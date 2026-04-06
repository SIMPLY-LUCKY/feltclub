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
const SB = 10, BB = 20, BUY_IN = 1000

// ─── Game Rooms ──────────────────────────────────────────────────────────────
const rooms = {}   // tableId → { players, gameState }

function getOrCreateRoom(tableId) {
  if (!rooms[tableId]) {
    rooms[tableId] = {
      tableId,
      players: [],   // { socketId, name, stack, seat }
      game: null,
      hostId: null,
    }
  }
  return rooms[tableId]
}

function broadcastRoom(tableId) {
  const room = rooms[tableId]
  if (!room) return
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
  })
  // Send each player their private hole cards
  if (room.game) {
    room.players.forEach(p => {
      const playerInGame = room.game.players.find(gp => gp.socketId === p.socketId)
      if (playerInGame) {
        io.to(p.socketId).emit('your_cards', playerInGame.holeCards)
      }
    })
    // Send host ALL hole cards
    if (room.hostId) {
      const allHands = {}
      room.game.players.forEach(p => { allHands[p.socketId] = p.holeCards })
      io.to(room.hostId).emit('all_cards', allHands)
    }
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
    }))
  }
}

function startGame(tableId) {
  const room = rooms[tableId]
  if (!room || room.players.length < 2) return

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
  }

  // Update stacks in room
  gamePlayers.forEach(gp => {
    const rp = room.players.find(p => p.socketId === gp.socketId)
    if (rp) rp.stack = gp.stack
  })

  broadcastRoom(tableId)
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

// ─── Socket Events ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id)

  socket.on('join_table', ({ tableId, playerName }) => {
    const room = getOrCreateRoom(tableId)

    // Don't add duplicates
    if (room.players.find(p => p.socketId === socket.id)) return

    const seat = room.players.length
    const isHost = room.players.length === 0

    room.players.push({
      socketId: socket.id,
      name: playerName,
      stack: BUY_IN,
      seat,
    })

    if (isHost) room.hostId = socket.id
    socket.join(tableId)
    socket.data.tableId = tableId
    socket.data.name = playerName
    socket.data.isHost = isHost

    console.log(`${playerName} joined table ${tableId} (host: ${isHost})`)
    broadcastRoom(tableId)
  })

  socket.on('start_game', ({ tableId }) => {
    const room = rooms[tableId]
    if (!room || socket.id !== room.hostId) return
    if (room.players.length < 2) {
      socket.emit('error_msg', 'Need at least 2 players to start')
      return
    }
    startGame(tableId)
  })

  socket.on('next_hand', ({ tableId }) => {
    const room = rooms[tableId]
    if (!room || socket.id !== room.hostId) return
    startGame(tableId)
  })

  socket.on('player_action', ({ tableId, action }) => {
    handleAction(tableId, socket.id, action)
  })

  socket.on('reveal_all', ({ tableId }) => {
    const room = rooms[tableId]
    if (!room || socket.id !== room.hostId || !room.game) return
    room.game.showAllCards = !room.game.showAllCards
    broadcastRoom(tableId)
  })

  socket.on('disconnect', () => {
    const tableId = socket.data.tableId
    if (!tableId || !rooms[tableId]) return
    const room = rooms[tableId]
    room.players = room.players.filter(p => p.socketId !== socket.id)
    if (room.game) room.game.players = room.game.players.filter(p => p.socketId !== socket.id)
    if (room.hostId === socket.id && room.players.length > 0) {
      room.hostId = room.players[0].socketId
    }
    console.log(`${socket.data.name} left table ${tableId}`)
    broadcastRoom(tableId)
  })
})

const PORT = 3001
httpServer.listen(PORT, () => {
  console.log(`\n🃏 FeltClub server running at http://localhost:${PORT}\n`)
})
