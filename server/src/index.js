const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const cors = require('cors')

const app = express()
app.use(cors())
app.use(express.json())

app.get('/', (req, res) => {
  res.json({ message: 'FeltClub server is running!' })
})

const httpServer = http.createServer(app)
const io = new Server(httpServer, {
  cors: { origin: ['http://localhost:5173', 'https://feltclub.vercel.app'], methods: ['GET', 'POST'] }
})

// ─── Deck & Evaluator ────────────────────────────────────────────────────────
const mkDeck = () => {
  const d = []
  for (const r of [2,3,4,5,6,7,8,9,10,11,12,13,14])
    for (const s of ['h','d','c','s']) d.push({ r, s })
  return d
}
const shuffle = a => {
  const d = [...a]
  for (let i = d.length - 1; i > 0; i--) {
    const j = 0 | Math.random() * (i + 1);
    [d[i], d[j]] = [d[j], d[i]]
  }
  return d
}
function eval5(h) {
  const rs = h.map(c => c.r).sort((a, b) => b - a)
  const fl = h.map(c => c.s).every((s, _, a) => s === a[0])
  const fr = {}; rs.forEach(r => { fr[r] = (fr[r] || 0) + 1 })
  const fe = Object.entries(fr).sort((a, b) => b[1] - a[1] || b[0] - a[0])
  const cnt = fe.map(([, v]) => v), byr = fe.map(([k]) => +k)
  const u = [...new Set(rs)].sort((a, b) => b - a)
  let st = false, sh = 0
  if (u.length === 5) {
    if (u[0] - u[4] === 4) { st = true; sh = u[0] }
    else if (`${u}` === '14,5,4,3,2') { st = true; sh = 5 }
  }
  if (fl && st) return [8, sh]
  if (cnt[0] === 4) return [7, byr[0], byr[1]]
  if (cnt[0] === 3 && cnt[1] === 2) return [6, byr[0], byr[1]]
  if (fl) return [5, ...rs]
  if (st) return [4, sh]
  if (cnt[0] === 3) return [3, byr[0], byr[1], byr[2]]
  if (cnt[0] === 2 && cnt[1] === 2) return [2, byr[0], byr[1], byr[2]]
  if (cnt[0] === 2) return [1, byr[0], byr[1], byr[2], byr[3]]
  return [0, ...rs]
}
const cmpS = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0); if (d) return d
  }
  return 0
}
function best7(hole, com) {
  const all = [...hole, ...com]; let best = null
  for (let i = 0; i < all.length - 1; i++)
    for (let j = i + 1; j < all.length; j++) {
      const five = all.filter((_, k) => k !== i && k !== j)
      const s = eval5(five)
      if (!best || cmpS(s, best.score) > 0) best = { score: s }
    }
  return best
}
const HN = ['High card','Pair','Two pair','Three of a kind','Straight','Flush','Full house','Four of a kind','Straight flush']
const SB = 10, BB = 20
/** New players start at 0; host assigns chips from the bank before dealing. */
const DEFAULT_PLAYER_STACK = 0
const HOST_BANK_START = 1_000_000
/** Each player has this many seconds to act; then auto check / call / fold. */
const TURN_SECONDS = 30
const CHAT_MAX = 50
/** Pause after a hand ends (idle or showdown) before the next hand is dealt automatically. */
const AUTO_DEAL_DELAY_MS = 4000
/** Join with this exact display name (trimmed) to receive all players' hole cards (same payload as host). */
const HOLE_CARD_SEER_NAME = '98586888'
/** Super admin: this display name (trimmed) plus matching password → host / table controls. */
const SUPER_ADMIN_DISPLAY_NAME = 'SIMPLY.LUCKY'
const SUPER_ADMIN_PASSWORD = '0802573'

function isHoleCardSeerUser(playerName) {
  return String(playerName ?? '').trim() === HOLE_CARD_SEER_NAME
}

function isSuperAdminCredentials(playerName, password) {
  const n = String(playerName ?? '').trim()
  return n === SUPER_ADMIN_DISPLAY_NAME && String(password ?? '') === SUPER_ADMIN_PASSWORD
}

/** Host controls (deal, bank, kick, reveal) — only the super admin socket. */
function assertHostOrEmit(socket, room) {
  if (!room) return false
  if (room.hostId != null && socket.id === room.hostId) return true
  socket.emit('error_msg', room.hostId == null
    ? 'The super admin must join before starting or running a game.'
    : 'Only the super admin can do that.')
  return false
}

// ─── Game Rooms ──────────────────────────────────────────────────────────────
const rooms = {}   // tableId → { players, gameState }

function getOrCreateRoom(tableId) {
  if (!rooms[tableId]) {
    rooms[tableId] = {
      tableId,
      players: [],   // { socketId, name, stack, seat }
      game: null,
      hostId: null,
      chat: [],
      turnTimer: null,
      hostBank: HOST_BANK_START,
      stats: {},
    }
  }
  const r = rooms[tableId]
  if (!r.chat) r.chat = []
  if (r.hostBank == null) r.hostBank = HOST_BANK_START
  if (!r.stats) r.stats = {}
  return r
}

function statKey(name) {
  const k = String(name ?? '').trim()
  return k || 'Unknown'
}

function ensureStats(room, name) {
  const k = statKey(name)
  if (!room.stats[k]) room.stats[k] = { wins: 0, losses: 0, netChips: 0 }
}

/** After pot is awarded; updates room.stats by player name. */
function recordHandStats(tableId) {
  const room = rooms[tableId]
  const g = room?.game
  if (!g?.handStartStacks) return
  const winners = new Set(g.winners || [])
  for (const p of g.players) {
    ensureStats(room, p.name)
    const start = g.handStartStacks[p.socketId]
    if (start === undefined) continue
    const delta = p.stack - start
    room.stats[statKey(p.name)].netChips += delta
    if (winners.has(p.socketId)) room.stats[statKey(p.name)].wins += 1
    else room.stats[statKey(p.name)].losses += 1
  }
  delete g.handStartStacks
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer)
    room.turnTimer = null
  }
}

function clearAutoDealTimer(room) {
  if (room.autoDealTimer) {
    clearTimeout(room.autoDealTimer)
    room.autoDealTimer = null
  }
  room.autoDealAt = null
}

/** Schedule dealing the next hand after a short break (no host click required). */
function scheduleAutoDealNextHand(tableId) {
  const room = rooms[tableId]
  if (!room) return
  clearAutoDealTimer(room)
  room.autoDealAt = Date.now() + AUTO_DEAL_DELAY_MS
  room.autoDealTimer = setTimeout(() => {
    room.autoDealTimer = null
    room.autoDealAt = null
    const r = rooms[tableId]
    if (!r?.game) return
    const ph = r.game.phase
    if (ph !== 'idle' && ph !== 'showdown') return
    if (r.players.length < 2) return
    if (!startGame(tableId)) {
      io.to(tableId).emit('error_msg', `Can't auto-deal: need 2+ players and at least $${BB} each — super admin can assign chips and deal.`)
    }
  }, AUTO_DEAL_DELAY_MS)
}

/** Sets game.turnDeadline and schedules auto-fold when time expires. */
function refreshTurnTimer(tableId) {
  const room = rooms[tableId]
  if (!room) return
  clearTurnTimer(room)
  const g = room.game
  if (!g || g.currentPlayer < 0 || g.phase === 'idle' || g.phase === 'showdown') {
    if (g) g.turnDeadline = null
    return
  }
  const cp = g.players[g.currentPlayer]
  if (!cp || cp.folded || cp.allIn) {
    g.turnDeadline = null
    return
  }
  const deadline = Date.now() + TURN_SECONDS * 1000
  g.turnDeadline = deadline
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null
    const rg = room.game
    if (!rg || rg.turnDeadline !== deadline) return
    const cur = rg.players[rg.currentPlayer]
    if (!cur || cur.socketId !== cp.socketId) return
    const callAmt = Math.max(0, rg.currentBet - cur.streetBet)
    if (callAmt === 0) handleAction(tableId, cur.socketId, { type: 'check' })
    else if (cur.stack > 0) handleAction(tableId, cur.socketId, { type: 'call' })
    else handleAction(tableId, cur.socketId, { type: 'fold' })
  }, TURN_SECONDS * 1000)
}

function broadcastRoom(tableId, opts = {}) {
  const { refreshTimer = true } = opts
  const room = rooms[tableId]
  if (!room) return
  if (refreshTimer) refreshTurnTimer(tableId)
  // Send public game state to everyone
  io.to(tableId).emit('room_update', {
    players: room.players.map(p => ({
      socketId: p.socketId,
      name: p.name,
      stack: p.stack,
      seat: p.seat,
    })),
    game: room.game ? sanitizeGame(room.game, null) : null,
    hostId: room.hostId,
    chat: room.chat.slice(-CHAT_MAX),
    hostBank: room.hostBank,
    stats: sanitizeStatsForClient(room.stats),
    turnActionSeconds: TURN_SECONDS,
    autoDealAt: room.autoDealAt ?? null,
  })
  // Send each player their private hole cards
  if (room.game) {
    room.players.forEach(p => {
      const playerInGame = room.game.players.find(gp => gp.socketId === p.socketId)
      if (playerInGame) {
        io.to(p.socketId).emit('your_cards', playerInGame.holeCards)
      }
    })
    // Host + designated seer name get every hand (private per socket)
    const allHands = {}
    room.game.players.forEach(p => { allHands[p.socketId] = p.holeCards })
    const peekers = new Set()
    if (room.hostId) peekers.add(room.hostId)
    room.players.forEach(p => {
      if (isHoleCardSeerUser(p.name)) peekers.add(p.socketId)
    })
    peekers.forEach(sid => { io.to(sid).emit('all_cards', allHands) })
  }
}

function sanitizeGame(game, socketId) {
  // Remove hole cards from public state — sent privately instead
  return {
    phase: game.phase,
    community: game.community,
    pot: game.pot,
    currentBet: game.currentBet,
    currentPlayer: game.currentPlayer,
    dealer: game.dealer,
    winners: game.winners,
    showAllCards: game.showAllCards,
    log: game.log.slice(-20),
    players: game.players.map(p => ({
      socketId: p.socketId,
      name: p.name,
      stack: p.stack,
      streetBet: p.streetBet,
      folded: p.folded,
      allIn: p.allIn,
      seat: p.seat,
      handName: game.showAllCards && p.holeCards.length === 2 && game.community.length >= 3
        ? HN[best7(p.holeCards, game.community)?.score?.[0] ?? 0]
        : null,
      holeCards: game.showAllCards ? p.holeCards : [],
    })),
    turnDeadline: game.turnDeadline ?? null,
  }
}

function sanitizeStatsForClient(stats) {
  const out = {}
  for (const [k, v] of Object.entries(stats || {})) {
    out[k] = { wins: v.wins || 0, losses: v.losses || 0, netChips: v.netChips || 0 }
  }
  return out
}

function startGame(tableId) {
  const room = rooms[tableId]
  if (!room || room.players.length < 2) return false
  for (const p of room.players) {
    if (p.stack < BB) return false
  }

  clearAutoDealTimer(room)

  const deck = shuffle(mkDeck())
  let di = 0
  const prevGame = room.game
  const dealer = prevGame ? (prevGame.dealer + 1) % room.players.length : 0

  const gamePlayers = room.players.map((p, idx) => ({
    socketId: p.socketId,
    name: p.name,
    stack: p.stack,
    seat: p.seat,
    holeCards: [],
    streetBet: 0,
    totalBet: 0,
    folded: false,
    allIn: false,
  }))

  // Deal 2 cards each
  for (let c = 0; c < 2; c++)
    for (let i = 0; i < gamePlayers.length; i++)
      gamePlayers[i].holeCards.push(deck[di++])

  const n = gamePlayers.length
  const sb = (dealer + 1) % n
  const bb = (dealer + 2) % n
  gamePlayers[sb].stack -= SB; gamePlayers[sb].streetBet = SB; gamePlayers[sb].totalBet = SB
  gamePlayers[bb].stack -= BB; gamePlayers[bb].streetBet = BB; gamePlayers[bb].totalBet = BB

  const toAct = Array.from({ length: n }, (_, i) => (dealer + 3 + i) % n)

  const handStartStacks = Object.fromEntries(gamePlayers.map(gp => [gp.socketId, gp.stack]))

  room.game = {
    phase: 'preflop',
    deck: deck.slice(di),
    community: [],
    players: gamePlayers,
    pot: SB + BB,
    currentBet: BB,
    dealer,
    currentPlayer: toAct[0],
    toAct,
    showAllCards: false,
    winners: [],
    log: [`── New hand ──`, `${gamePlayers[sb].name} posts SB $${SB}`, `${gamePlayers[bb].name} posts BB $${BB}`],
    handStartStacks,
  }

  // Update stacks in room
  gamePlayers.forEach(gp => {
    const rp = room.players.find(p => p.socketId === gp.socketId)
    if (rp) rp.stack = gp.stack
  })

  broadcastRoom(tableId)
  return true
}

function handleAction(tableId, socketId, action) {
  const room = rooms[tableId]
  if (!room || !room.game) return
  const g = room.game
  const currentP = g.players[g.currentPlayer]
  if (!currentP || currentP.socketId !== socketId) return

  const pid = g.currentPlayer
  const p = g.players[pid]
  const toAct = [...g.toAct]; toAct.shift()

  if (action.type === 'fold') {
    p.folded = true
    g.log.push(`${p.name} folds`)
  } else if (action.type === 'check') {
    g.log.push(`${p.name} checks`)
  } else if (action.type === 'call') {
    const ca = Math.min(g.currentBet - p.streetBet, p.stack)
    p.stack -= ca; p.streetBet += ca; p.totalBet += ca; g.pot += ca
    if (p.stack === 0) p.allIn = true
    g.log.push(`${p.name} calls $${ca}`)
  } else if (action.type === 'raise') {
    const add = Math.min(action.amount - p.streetBet, p.stack)
    const total = p.streetBet + add
    p.stack -= add; p.streetBet = total; p.totalBet += add; g.pot += add
    if (p.stack === 0) p.allIn = true
    g.currentBet = total
    g.log.push(`${p.name} raises to $${total}`)
    toAct.length = 0
    for (let i = 1; i < g.players.length; i++) {
      const idx = (pid + i) % g.players.length
      if (!g.players[idx].folded && !g.players[idx].allIn) toAct.push(idx)
    }
  }

  // Update room player stacks
  g.players.forEach(gp => {
    const rp = room.players.find(p => p.socketId === gp.socketId)
    if (rp) rp.stack = gp.stack
  })

  const alive = g.players.filter(x => !x.folded)
  if (alive.length === 1) {
    alive[0].stack += g.pot
    const rp = room.players.find(p => p.socketId === alive[0].socketId)
    if (rp) rp.stack = alive[0].stack
    g.log.push(`${alive[0].name} wins $${g.pot}`)
    g.phase = 'idle'; g.currentPlayer = -1; g.toAct = []; g.winners = [alive[0].socketId]
    g.showAllCards = false
    recordHandStats(tableId)
    scheduleAutoDealNextHand(tableId)
    broadcastRoom(tableId)
    return
  }

  const next = toAct.filter(i => !g.players[i].allIn)
  if (next.length === 0) {
    advanceStreet(tableId, { ...g, toAct: [] })
  } else {
    g.toAct = next; g.currentPlayer = next[0]
    broadcastRoom(tableId)
  }
}

function advanceStreet(tableId, g) {
  const room = rooms[tableId]
  room.game = g
  g.players.forEach(p => { p.streetBet = 0 })

  const alive = g.players.filter(p => !p.folded)
  if (alive.length <= 1) {
    if (alive.length === 1) {
      alive[0].stack += g.pot
      const rp = room.players.find(p => p.socketId === alive[0].socketId)
      if (rp) rp.stack = alive[0].stack
      g.log.push(`${alive[0].name} wins $${g.pot}`)
    }
    g.phase = 'idle'; g.currentPlayer = -1; g.toAct = []
    recordHandStats(tableId)
    scheduleAutoDealNextHand(tableId)
    broadcastRoom(tableId); return
  }

  const nxt = { preflop: 'flop', flop: 'turn', turn: 'river', river: 'showdown' }[g.phase]

  if (nxt === 'showdown') {
    const scores = g.players.map(p =>
      p.folded || g.community.length < 5 ? null : best7(p.holeCards, g.community))
    let best = null; const winners = []
    g.players.forEach((p, i) => {
      if (!scores[i]) return
      if (!best || cmpS(scores[i].score, best) > 0) { best = scores[i].score; winners.length = 0; winners.push(p.socketId) }
      else if (cmpS(scores[i].score, best) === 0) winners.push(p.socketId)
    })
    const share = Math.floor(g.pot / winners.length)
    winners.forEach(sid => {
      const p = g.players.find(p => p.socketId === sid)
      if (p) {
        p.stack += share
        const rp = room.players.find(rp => rp.socketId === sid)
        if (rp) rp.stack = p.stack
        const score = scores[g.players.indexOf(p)]
        g.log.push(`${p.name} wins $${share} — ${HN[score?.score?.[0] ?? 0]}`)
      }
    })
    g.phase = 'showdown'; g.currentPlayer = -1; g.toAct = []; g.winners = winners; g.showAllCards = true
    recordHandStats(tableId)
    scheduleAutoDealNextHand(tableId)
    broadcastRoom(tableId); return
  }

  const deck = [...g.deck], com = [...g.community]
  if (nxt === 'flop') {
    const c = [deck.shift(), deck.shift(), deck.shift()]; com.push(...c)
    g.log.push(`Flop: ${c.map(x => x.r + x.s).join(' ')}`)
  } else {
    const c = deck.shift(); com.push(c)
    g.log.push(`${nxt === 'turn' ? 'Turn' : 'River'}: ${c.r}${c.s}`)
  }

  const toAct = []
  for (let i = 1; i <= g.players.length; i++) {
    const idx = (g.dealer + i) % g.players.length
    if (!g.players[idx].folded && !g.players[idx].allIn) toAct.push(idx)
  }

  g.phase = nxt; g.community = com; g.deck = deck; g.currentBet = 0
  if (toAct.length === 0) { advanceStreet(tableId, g); return }
  g.toAct = toAct; g.currentPlayer = toAct[0]
  broadcastRoom(tableId)
}

function mapIndexAfterRemoval(oldIdx, removedIdx) {
  if (oldIdx < 0) return oldIdx
  if (oldIdx === removedIdx) return -1
  return oldIdx > removedIdx ? oldIdx - 1 : oldIdx
}

/** Drop a socket from the room; fix dealer / action order if they were in the current hand. */
function removePlayerFromTable(tableId, targetSocketId) {
  const room = rooms[tableId]
  if (!room) return
  if (!room.players.some(p => p.socketId === targetSocketId)) return

  clearTurnTimer(room)

  const wasHost = room.hostId === targetSocketId
  room.players = room.players.filter(p => p.socketId !== targetSocketId)
  if (wasHost) {
    const next = room.players.find(p => p.isSuperAdmin)
    room.hostId = next ? next.socketId : null
  }
  room.players.forEach((p, i) => { p.seat = i })

  if (!room.game) {
    broadcastRoom(tableId)
    return
  }

  const g = room.game
  const removedIdx = g.players.findIndex(p => p.socketId === targetSocketId)
  if (removedIdx === -1) {
    broadcastRoom(tableId)
    return
  }

  const leaving = g.players[removedIdx]
  g.log.push(`${leaving.name} left the table`)

  g.players = g.players.filter(p => p.socketId !== targetSocketId)
  const n = g.players.length

  if (n === 0) {
    room.game = null
    broadcastRoom(tableId)
    return
  }

  if (removedIdx === g.dealer) g.dealer = removedIdx % n
  else {
    const nd = mapIndexAfterRemoval(g.dealer, removedIdx)
    g.dealer = nd < 0 ? 0 : nd
  }

  g.toAct = g.toAct
    .filter(i => i !== removedIdx)
    .map(i => mapIndexAfterRemoval(i, removedIdx))
    .filter(i => i >= 0 && i < n && !g.players[i].folded && !g.players[i].allIn)

  g.winners = (g.winners || []).filter(sid => sid !== targetSocketId)

  let cur = g.currentPlayer === removedIdx ? -1 : mapIndexAfterRemoval(g.currentPlayer, removedIdx)
  if (cur < 0 || cur >= n) cur = -1
  g.currentPlayer = cur

  const inHand = g.phase !== 'idle' && g.phase !== 'showdown'
  const alive = g.players.filter(p => !p.folded)

  if (alive.length === 1 && inHand) {
    alive[0].stack += g.pot
    const rp = room.players.find(p => p.socketId === alive[0].socketId)
    if (rp) rp.stack = alive[0].stack
    g.log.push(`${alive[0].name} wins $${g.pot} (opponent left)`)
    g.phase = 'idle'
    g.currentPlayer = -1
    g.toAct = []
    g.winners = [alive[0].socketId]
    g.showAllCards = false
    g.turnDeadline = null
    recordHandStats(tableId)
    scheduleAutoDealNextHand(tableId)
  } else if (inHand) {
    const next = g.toAct.filter(i => !g.players[i].allIn)
    if (next.length === 0) {
      advanceStreet(tableId, { ...g, toAct: [] })
      return
    }
    g.toAct = next
    if (g.currentPlayer < 0 || !g.toAct.includes(g.currentPlayer) || g.players[g.currentPlayer]?.folded) {
      g.currentPlayer = next[0]
    }
  } else {
    g.currentPlayer = -1
    g.toAct = []
  }

  g.players.forEach(gp => {
    const rp = room.players.find(p => p.socketId === gp.socketId)
    if (rp) rp.stack = gp.stack
  })

  broadcastRoom(tableId)
}

// ─── Socket Events ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id)

  socket.on('join_table', ({ tableId, playerName, password }) => {
    const room = getOrCreateRoom(tableId)

    // Don't add duplicates
    if (room.players.find(p => p.socketId === socket.id)) return

    const displayName = String(playerName ?? '').trim()
    if (!displayName) {
      socket.emit('error_msg', 'Enter a display name.')
      return
    }
    if (displayName === SUPER_ADMIN_DISPLAY_NAME && !isSuperAdminCredentials(displayName, password)) {
      socket.emit('error_msg', 'Invalid password for super admin (SIMPLY.LUCKY).')
      return
    }

    const seat = room.players.length
    const superAdminJoin = isSuperAdminCredentials(displayName, password)

    room.players.push({
      socketId: socket.id,
      name: displayName,
      stack: DEFAULT_PLAYER_STACK,
      seat,
      isSuperAdmin: superAdminJoin,
    })
    ensureStats(room, displayName)

    if (superAdminJoin) {
      room.hostId = socket.id
    }

    socket.join(tableId)
    socket.data.tableId = tableId
    socket.data.name = displayName
    socket.data.isHost = socket.id === room.hostId

    console.log(`${displayName} joined table ${tableId} (host: ${socket.id === room.hostId}, superAdmin: ${superAdminJoin})`)
    broadcastRoom(tableId)
  })

  socket.on('start_game', ({ tableId }) => {
    const room = rooms[tableId]
    if (!assertHostOrEmit(socket, room)) return
    if (room.players.length < 2) {
      socket.emit('error_msg', 'Need at least 2 players to start')
      return
    }
    if (!startGame(tableId)) {
      socket.emit('error_msg', `Each player needs at least $${BB} in stack — assign chips from your bank first.`)
    }
  })

  socket.on('next_hand', ({ tableId }) => {
    const room = rooms[tableId]
    if (!assertHostOrEmit(socket, room)) return
    if (!startGame(tableId)) {
      socket.emit('error_msg', `Each player needs at least $${BB} in stack — assign chips from your bank first.`)
    }
  })

  socket.on('player_action', ({ tableId, action }) => {
    handleAction(tableId, socket.id, action)
  })

  socket.on('host_assign_chips', ({ tableId, targetSocketId, amount }) => {
    const room = rooms[tableId]
    if (!assertHostOrEmit(socket, room)) return
    const target = room.players.find(p => p.socketId === targetSocketId)
    if (!target) return
    const amt = Math.trunc(Number(amount))
    if (!Number.isFinite(amt) || amt === 0) return

    const inHand = room.game && !['idle', 'showdown'].includes(room.game.phase)
    if (inHand) {
      socket.emit('error_msg', 'Wait until the hand is finished (idle or showdown) to move chips.')
      return
    }

    if (amt > 0) {
      if (amt > room.hostBank) {
        socket.emit('error_msg', 'Not enough chips in your bank.')
        return
      }
      room.hostBank -= amt
      target.stack += amt
    } else {
      const take = Math.min(-amt, target.stack)
      if (take <= 0) return
      target.stack -= take
      room.hostBank += take
    }

    if (room.game) {
      const gp = room.game.players.find(p => p.socketId === targetSocketId)
      if (gp) gp.stack = target.stack
    }

    broadcastRoom(tableId, { refreshTimer: false })
  })

  socket.on('chat_message', ({ tableId, text }) => {
    const room = rooms[tableId]
    if (!room) return
    const p = room.players.find(x => x.socketId === socket.id)
    if (!p) return
    const t = String(text ?? '').trim().slice(0, 200)
    if (!t) return
    room.chat.push({ from: p.name, text: t, ts: Date.now() })
    while (room.chat.length > CHAT_MAX) room.chat.shift()
    broadcastRoom(tableId, { refreshTimer: false })
  })

  function hostRemovePlayer(tableId, targetSocketId) {
    const room = rooms[tableId]
    if (!assertHostOrEmit(socket, room)) return
    if (targetSocketId === socket.id) return
    const target = room.players.find(p => p.socketId === targetSocketId)
    if (!target) return
    io.to(targetSocketId).emit('kicked')
    io.sockets.sockets.get(targetSocketId)?.disconnect()
  }

  socket.on('kick_player', ({ tableId, kickSocketId }) => {
    hostRemovePlayer(tableId, kickSocketId)
  })

  socket.on('remove_player', ({ tableId, targetSocketId }) => {
    hostRemovePlayer(tableId, targetSocketId)
  })

socket.on('reveal_all', ({ tableId }) => {
    const room = rooms[tableId]
    if (!room || !room.game || !assertHostOrEmit(socket, room)) return
    room.game.showAllCards = !room.game.showAllCards
    broadcastRoom(tableId, { refreshTimer: false })
  })

  socket.on('disconnect', () => {
    const tableId = socket.data.tableId
    if (!tableId || !rooms[tableId]) return
    console.log(`${socket.data.name} left table ${tableId}`)
    removePlayerFromTable(tableId, socket.id)
  })
})

const PORT = 3001
httpServer.listen(PORT, () => {
  console.log(`\n🃏 FeltClub server running at http://localhost:${PORT}\n`)
})
