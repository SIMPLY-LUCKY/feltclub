import { bestNLHE, bestPLOHand, compareScores, HAND_NAMES } from './eval.js'

export const SB = 10
export const BB = 20
export const TURN_SECONDS = 15
export const HOST_BANK_START = 50_000
export const SUPER_ADMIN_NAME = 'SIMPLY.LUCKY'
export const SUPER_ADMIN_PIN = '0802573'
export const UNLIMITED_STACK = Number.MAX_SAFE_INTEGER

export const VARIANTS = {
  NLHE: { id: 'NLHE', maxSeats: 10, holes: 2, potLimit: false },
  PLO4: { id: 'PLO4', maxSeats: 6, holes: 4, potLimit: true },
  PLO5: { id: 'PLO5', maxSeats: 6, holes: 5, potLimit: true },
  PLO6: { id: 'PLO6', maxSeats: 6, holes: 6, potLimit: true },
}

export function maxSeatsForType(type) {
  return VARIANTS[type]?.maxSeats ?? 10
}

export function roomSB(room) {
  const sb = Math.trunc(Number(room?.smallBlind))
  return Number.isFinite(sb) && sb > 0 ? sb : SB
}

export function roomBB(room) {
  const bb = Math.trunc(Number(room?.bigBlind))
  const sb = roomSB(room)
  const b = Number.isFinite(bb) && bb > 0 ? bb : BB
  return b >= sb ? b : sb * 2
}

/** Table cap: min(variant max, configured maxPlayers). */
export function effectiveMaxSeats(room) {
  return effectiveMaxSeatsFor(room, room?.gameType || 'NLHE')
}

export function effectiveMaxSeatsFor(room, gameType) {
  const t = gameType || 'NLHE'
  const vMax = maxSeatsForType(t)
  const mp = Math.trunc(Number(room?.maxPlayers))
  const cap = Number.isFinite(mp) && mp >= 2 ? mp : vMax
  return Math.min(vMax, cap)
}

function shuffle(a) {
  const d = [...a]
  for (let i = d.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0
    ;[d[i], d[j]] = [d[j], d[i]]
  }
  return d
}

export function mkDeck() {
  const d = []
  for (const r of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
    for (const s of ['h', 'd', 'c', 's']) d.push({ r, s })
  }
  return d
}

function effStack(p) {
  return p.unlimitedChips ? UNLIMITED_STACK : p.stack
}

function takeFromStack(p, amt) {
  if (p.unlimitedChips) return
  p.stack -= amt
}

export function potLimitMaxTotalStreet(game, p) {
  const toCall = Math.max(0, game.currentBet - p.streetBet)
  return p.streetBet + toCall + game.pot + toCall
}

function isPloVariant(v) {
  return v === 'PLO4' || v === 'PLO5' || v === 'PLO6'
}

function scoreFor(p, g) {
  if (isPloVariant(g.variant)) return bestPLOHand(p.holeCards, g.community)
  return bestNLHE(p.holeCards, g.community)
}

/** Set on the room from index.js: starts the between-hands auto-deal countdown. */
function notifyHandCompleteForAutoDeal(room) {
  if (typeof room.onShowdownComplete === 'function') room.onShowdownComplete()
}

function syncAllStacksToRoom(g, room) {
  for (const p of g.players) {
    const rp = room.players.find(r => r.socketId === p.socketId)
    if (rp && !p.unlimitedChips) rp.stack = p.stack
  }
}

function awardBySidePots(g, room) {
  const players = g.players
  const potTotal = g.pot
  const levels = [...new Set(players.map(p => p.totalBet))].filter(x => x > 0).sort((a, b) => a - b)
  const payouts = Object.fromEntries(players.map(p => [p.socketId, 0]))
  let prev = 0
  for (const level of levels) {
    const inc = level - prev
    const contributors = players.filter(p => p.totalBet >= level)
    const layerAmt = inc * contributors.length
    const eligible = contributors.filter(p => !p.folded)
    if (eligible.length === 0) {
      prev = level
      continue
    }
    const scores = eligible.map(p => ({ p, s: scoreFor(p, g) }))
    const valid = scores.filter(x => x.s != null)
    if (valid.length === 0) {
      const share = Math.floor(layerAmt / eligible.length) || 0
      for (const w of eligible) payouts[w.socketId] += share
      prev = level
      continue
    }
    let best = valid[0].s
    for (const x of valid) {
      if (compareScores(x.s, best) > 0) best = x.s
    }
    const winners = valid.filter(x => compareScores(x.s, best) === 0)
    const share = Math.floor(layerAmt / winners.length)
    for (const w of winners) payouts[w.p.socketId] += share
    prev = level
  }
  let paid = 0
  for (const v of Object.values(payouts)) paid += v
  let rem = potTotal - paid
  const winSids = [...new Set(Object.entries(payouts).filter(([, v]) => v > 0).map(([k]) => k))]
  let i = 0
  while (rem > 0 && winSids.length) {
    payouts[winSids[i % winSids.length]] += 1
    rem -= 1
    i += 1
  }
  for (const p of players) {
    const add = payouts[p.socketId] || 0
    if (add <= 0) continue
    if (!p.unlimitedChips) p.stack += add
  }
  g.pot = 0
  syncAllStacksToRoom(g, room)
}

function recordStats(room, g) {
  const winners = new Set(g.winners || [])
  for (const p of g.players) {
    const k = statKey(p.name)
    if (!room.stats[k]) room.stats[k] = { wins: 0, losses: 0, netChips: 0 }
    const start = g.handStartStacks?.[p.socketId]
    if (start === undefined) continue
    const delta = p.stack - start
    room.stats[k].netChips += delta
    if (winners.has(p.socketId)) room.stats[k].wins += 1
    else room.stats[k].losses += 1
  }
}

export function statKey(name) {
  return String(name || '').trim().toLowerCase()
}

/** Seated players only, in seat order (for poker hand / blinds). */
export function getSeatedPlayersSorted(room) {
  return (room.players || [])
    .filter(p => p.seated && typeof p.seat === 'number' && p.seat >= 0)
    .sort((a, b) => a.seat - b.seat)
}

function sameSeatedLineup(prevGame, seatedSorted) {
  if (!prevGame?.players || prevGame.players.length !== seatedSorted.length) return false
  return prevGame.players.every((gp, i) => gp.socketId === seatedSorted[i].socketId)
}

export function canStartHand(room) {
  const bb = roomBB(room)
  const seated = getSeatedPlayersSorted(room)
  if (seated.length < 2) return false
  for (const p of seated) {
    if (p.unlimitedChips) continue
    if (p.stack < bb) return false
  }
  return true
}

function firstPreflopActor(n, dealer) {
  if (n === 2) return (dealer + 1) % n
  return (dealer + 3) % n
}

function rebuildAfterRaise(g, raiserIdx) {
  const out = []
  for (let i = 1; i < g.players.length; i++) {
    const j = (raiserIdx + i) % g.players.length
    const o = g.players[j]
    if (!o.folded && !o.allIn && o.streetBet < g.currentBet) out.push(j)
  }
  return out
}

function postStreetActionOrder(g) {
  const n = g.players.length
  const order = []
  for (let k = 1; k <= n; k++) {
    const idx = (g.dealer + k) % n
    if (!g.players[idx].folded && !g.players[idx].allIn) order.push(idx)
  }
  return order
}

export function startHand(room) {
  if (!canStartHand(room)) return false
  const gt = room.gameType && VARIANTS[room.gameType] ? room.gameType : 'NLHE'
  const v = VARIANTS[gt]
  const deck = shuffle(mkDeck())
  let di = 0
  const prev = room.game
  const seated = getSeatedPlayersSorted(room)
  const n = seated.length
  const dealer = sameSeatedLineup(prev, seated) ? ((prev.dealer + 1) % n) : 0

  const gamePlayers = seated.map(rp => ({
    socketId: rp.socketId,
    name: rp.name,
    seat: rp.seat,
    stack: rp.stack,
    unlimitedChips: rp.unlimitedChips,
    holeCards: [],
    streetBet: 0,
    totalBet: 0,
    folded: false,
    allIn: false,
  }))

  const holes = v.holes
  for (let c = 0; c < holes; c++) {
    for (let i = 0; i < n; i++) {
      gamePlayers[i].holeCards.push(deck[di++])
    }
  }

  const sbIdx = (dealer + 1) % n
  const bbIdx = (dealer + 2) % n
  const sbAmt = roomSB(room)
  const bbAmt = roomBB(room)
  const post = (idx, amt) => {
    const p = gamePlayers[idx]
    const pay = Math.min(amt, effStack(p))
    takeFromStack(p, pay)
    p.streetBet = pay
    p.totalBet = pay
    if (pay < amt) p.allIn = true
  }
  post(sbIdx, sbAmt)
  post(bbIdx, bbAmt)

  const pot = gamePlayers.reduce((s, p) => s + p.streetBet, 0)

  room.game = {
    variant: gt,
    phase: 'preflop',
    deck: deck.slice(di),
    community: [],
    players: gamePlayers,
    pot,
    currentBet: bbAmt,
    minRaise: bbAmt,
    lastRaise: bbAmt,
    dealer,
    winners: [],
    showAllCards: false,
    log: [
      `── ${v.id} — new hand ──`,
      `${gamePlayers[sbIdx].name} SB $${gamePlayers[sbIdx].streetBet}`,
      `${gamePlayers[bbIdx].name} BB $${gamePlayers[bbIdx].streetBet}`,
    ],
    handStartStacks: Object.fromEntries(gamePlayers.map(p => [p.socketId, p.stack])),
  }

  const order = []
  const start = firstPreflopActor(n, dealer)
  for (let k = 0; k < n; k++) {
    const idx = (start + k) % n
    if (!gamePlayers[idx].allIn) order.push(idx)
  }
  room.game.toAct = order
  room.game.currentPlayer = order[0] ?? -1

  syncAllStacksToRoom(room.game, room)
  return true
}

export function getRaiseBounds(game, pIdx) {
  const p = game.players[pIdx]
  const toCall = Math.max(0, game.currentBet - p.streetBet)
  const stack = effStack(p)
  const minTotal = game.currentBet + game.minRaise
  const minRaiseTo = Math.min(minTotal, p.streetBet + stack)
  let maxRaiseTo = p.streetBet + stack
  if (VARIANTS[game.variant]?.potLimit) {
    maxRaiseTo = Math.min(maxRaiseTo, potLimitMaxTotalStreet(game, p))
  }
  return {
    toCall,
    minRaiseTo: Math.min(minTotal, maxRaiseTo),
    maxRaiseTo: Math.max(game.currentBet, maxRaiseTo),
  }
}

function bettingComplete(g) {
  const need = g.players.filter(p => !p.folded && !p.allIn)
  if (need.length === 0) return true
  return need.every(p => p.streetBet === g.currentBet)
}

function allContestedAllIn(g) {
  const alive = g.players.filter(p => !p.folded)
  if (alive.length < 2) return false
  return alive.every(p => p.allIn)
}

function endFoldWin(room, g, winner) {
  if (!winner.unlimitedChips) winner.stack += g.pot
  g.log.push(`${winner.name} wins $${g.pot}`)
  g.pot = 0
  g.currentPlayer = -1
  g.toAct = []
  g.winners = [winner.socketId]
  g.showAllCards = false
  g.phase = 'showdown'
  recordStats(room, g)
  delete g.handStartStacks
  syncAllStacksToRoom(g, room)
  notifyHandCompleteForAutoDeal(room)
  return { ok: true, handOver: true }
}

export function handleAction(room, socketId, action) {
  const bb = roomBB(room)
  const g = room.game
  if (!g || g.phase === 'idle' || g.phase === 'showdown') return { ok: false }
  const idx = g.players.findIndex(p => p.socketId === socketId)
  if (idx < 0) return { ok: false }
  if (g.currentPlayer !== idx) return { ok: false }
  const p = g.players[idx]
  if (p.folded || p.allIn) return { ok: false }

  const toCall = Math.max(0, g.currentBet - p.streetBet)
  const stack = effStack(p)
  let queue = [...g.toAct]
  if (queue[0] !== idx) return { ok: false }
  queue.shift()
  let raised = false

  if (action.type === 'fold') {
    p.folded = true
    g.log.push(`${p.name} folds`)
  } else if (action.type === 'check') {
    if (toCall > 0) return { ok: false }
    g.log.push(`${p.name} checks`)
  } else if (action.type === 'call') {
    const pay = Math.min(toCall, stack)
    takeFromStack(p, pay)
    p.streetBet += pay
    p.totalBet += pay
    g.pot += pay
    if (pay < toCall) p.allIn = true
    g.log.push(`${p.name} calls $${pay}`)
  } else if (action.type === 'raise') {
    let target = Math.trunc(Number(action.amount))
    if (!Number.isFinite(target)) return { ok: false }
    const bounds = getRaiseBounds(g, idx)
    target = Math.max(bounds.minRaiseTo, Math.min(bounds.maxRaiseTo, target))
    const need = target - p.streetBet
    const pay = Math.min(need, stack)
    takeFromStack(p, pay)
    p.streetBet += pay
    p.totalBet += pay
    g.pot += pay
    const newBet = p.streetBet
    if (newBet > g.currentBet) {
      g.lastRaise = newBet - g.currentBet
      g.minRaise = Math.max(bb, g.lastRaise)
      g.currentBet = newBet
      g.log.push(`${p.name} raises to $${newBet}`)
      if (pay < need) p.allIn = true
      queue = rebuildAfterRaise(g, idx)
      raised = true
    } else {
      g.log.push(`${p.name} calls (all-in) $${pay}`)
      if (pay < need) p.allIn = true
    }
  } else return { ok: false }

  const alive = g.players.filter(x => !x.folded)
  if (alive.length === 1) {
    return endFoldWin(room, g, alive[0])
  }

  if (allContestedAllIn(g)) {
    return runOutBoard(room)
  }

  let next
  if (raised) {
    next = queue
  } else {
    next = queue.filter(i => {
      const pl = g.players[i]
      if (pl.folded || pl.allIn) return false
      if (g.currentBet === 0) return true
      return pl.streetBet < g.currentBet
    })
  }

  if (next.length === 0) {
    if (bettingComplete(g)) return advanceStreet(room)
    return runOutBoard(room)
  }
  g.toAct = next
  g.currentPlayer = next[0]
  syncAllStacksToRoom(g, room)
  return { ok: true }
}

function runOutBoard(room) {
  const g = room.game
  while (g.phase !== 'showdown' && g.phase !== 'idle') {
    const r = advanceStreet(room)
    if (r.handOver) return r
  }
  return { ok: true, handOver: true }
}

function advanceStreet(room) {
  const g = room.game
  const bb = roomBB(room)
  g.players.forEach(p => {
    p.streetBet = 0
  })
  g.currentBet = 0
  g.minRaise = bb
  g.lastRaise = bb

  const alive = g.players.filter(p => !p.folded)
  if (alive.length === 1) {
    return endFoldWin(room, g, alive[0])
  }
  if (alive.length === 0) {
    g.phase = 'showdown'
    g.currentPlayer = -1
    g.toAct = []
    g.pot = 0
    delete g.handStartStacks
    syncAllStacksToRoom(g, room)
    notifyHandCompleteForAutoDeal(room)
    return { ok: true, handOver: true }
  }

  const nxt = { preflop: 'flop', flop: 'turn', turn: 'river', river: 'showdown' }[g.phase]

  if (nxt === 'showdown') {
    const deck = [...g.deck]
    while (g.community.length < 5) {
      if (g.community.length === 0) {
        const c = [deck.shift(), deck.shift(), deck.shift()]
        g.community.push(...c)
        g.log.push(`Flop: ${c.map(x => x.r + x.s).join(' ')}`)
      } else {
        const c = deck.shift()
        g.community.push(c)
        g.log.push(`${g.community.length === 4 ? 'Turn' : 'River'}: ${c.r}${c.s}`)
      }
    }
    g.deck = deck
    g.phase = 'showdown'
    g.showAllCards = true
    const active = g.players.filter(p => !p.folded)
    const rawScores = active.map(p => ({ p, s: scoreFor(p, g) }))
    const scores = rawScores.filter(x => x.s != null)
    if (scores.length === 0) {
      g.winners = []
      g.log.push('Showdown: could not evaluate hands.')
    } else {
      let best = scores[0].s
      for (const x of scores) {
        if (compareScores(x.s, best) > 0) best = x.s
      }
      const wids = scores.filter(x => compareScores(x.s, best) === 0).map(x => x.p.socketId)
      g.winners = wids
      for (const x of scores) {
        g.log.push(`${x.p.name}: ${HAND_NAMES[x.s[0]]}`)
      }
    }
    awardBySidePots(g, room)
    g.currentPlayer = -1
    g.toAct = []
    recordStats(room, g)
    delete g.handStartStacks
    notifyHandCompleteForAutoDeal(room)
    return { ok: true, handOver: true }
  }

  const deck = [...g.deck]
  let com = [...g.community]
  if (nxt === 'flop') {
    const c = [deck.shift(), deck.shift(), deck.shift()]
    com.push(...c)
    g.log.push(`Flop: ${c.map(x => x.r + x.s).join(' ')}`)
  } else {
    const c = deck.shift()
    com.push(c)
    g.log.push(`${nxt === 'turn' ? 'Turn' : 'River'}: ${c.r}${c.s}`)
  }
  g.deck = deck
  g.community = com
  g.phase = nxt

  const order = postStreetActionOrder(g)
  if (order.length === 0) {
    return advanceStreet(room)
  }
  g.toAct = order
  g.currentPlayer = order[0]
  syncAllStacksToRoom(g, room)
  return { ok: true }
}
