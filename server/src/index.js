import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import {
  TURN_SECONDS,
  HOST_BANK_START,
  SUPER_ADMIN_NAME,
  SUPER_ADMIN_PIN,
  VARIANTS,
  maxSeatsForType,
  effectiveMaxSeats,
  effectiveMaxSeatsFor,
  startHand,
  handleAction,
  getRaiseBounds,
  canStartHand,
  statKey,
} from './poker/engine.js'
import { bestNLHE, bestOmaha, HAND_NAMES } from './poker/eval.js'

const PORT = 3001
const AUTO_DEAL_MS = 2000
const CHAT_MAX = 80
const ALLOWED_MAX_PLAYERS = new Set([2, 4, 6, 9])

const app = express()
app.use(cors())
app.use(express.json())
app.get('/', (_, res) => res.json({ ok: true, name: 'FeltClub' }))

const httpServer = http.createServer(app)
const io = new Server(httpServer, {
  cors: { origin: true, methods: ['GET', 'POST'] },
})

const rooms = new Map()
/** Sockets currently in the lobby UI (insertion order — first connected is lobby “host” for Create Table). */
const lobbySockets = new Set()

function pruneLobbySockets() {
  for (const id of [...lobbySockets]) {
    if (!io.sockets.sockets.get(id)?.connected) lobbySockets.delete(id)
  }
}

function getLobbyHostId() {
  pruneLobbySockets()
  for (const id of lobbySockets) {
    if (io.sockets.sockets.get(id)?.connected) return id
  }
  return null
}

function broadcastLobbyHostFlags() {
  const hid = getLobbyHostId()
  for (const id of lobbySockets) {
    const s = io.sockets.sockets.get(id)
    if (s?.connected) {
      s.emit('lobby_state', { isLobbyHost: hid != null && id === hid })
    }
  }
}

function getRoom(tableId) {
  return rooms.get(tableId)
}

function newTableId() {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

function normalizedSecret(s) {
  return String(s ?? '').trim()
}

function isSuperAdminCredentials(name, superAdminPin) {
  return String(name ?? '').trim() === SUPER_ADMIN_NAME && normalizedSecret(superAdminPin) === SUPER_ADMIN_PIN
}

function buildTableSummaries() {
  const out = []
  for (const [, room] of rooms) {
    out.push({
      tableId: room.tableId,
      name: room.name || room.tableId,
      gameType: room.gameType,
      smallBlind: room.smallBlind,
      bigBlind: room.bigBlind,
      playersSeated: room.players.length,
      maxSeats: effectiveMaxSeats(room),
      hasPassword: !!(room.tablePassword && room.tablePassword.length),
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

function syncHostFlags(room) {
  room.players.forEach(p => {
    p.unlimitedChips = p.socketId === room.hostId
  })
}

function assignHostIfNeeded(room) {
  if (room.hostId == null && room.players.length > 0) {
    room.hostId = room.players[0].socketId
    syncHostFlags(room)
  }
}

function transferHost(room, leavingId) {
  if (room.hostId !== leavingId) return
  const next = room.players.find(p => p.socketId !== leavingId)
  room.hostId = next ? next.socketId : null
  syncHostFlags(room)
}

function assertHost(socket, room) {
  if (!room || room.hostId == null) {
    socket.emit('error_msg', 'No host on this table.')
    return false
  }
  if (socket.id !== room.hostId) {
    socket.emit('error_msg', 'Only the table host can do that.')
    return false
  }
  return true
}

function clearTurn(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer)
    room.turnTimer = null
  }
}

function clearAutoDeal(room) {
  if (room.autoDealTimer) {
    clearTimeout(room.autoDealTimer)
    room.autoDealTimer = null
  }
  room.autoDealAt = null
}

function scheduleAutoDeal(tableId) {
  const room = getRoom(tableId)
  if (!room) return
  clearAutoDeal(room)
  room.autoDealAt = Date.now() + AUTO_DEAL_MS
  room.autoDealTimer = setTimeout(() => {
    room.autoDealTimer = null
    room.autoDealAt = null
    const r = getRoom(tableId)
    if (!r?.game || r.game.phase !== 'idle') return
    if (!canStartHand(r)) return
    if (startHand(r)) {
      broadcast(tableId)
      refreshTurnTimer(tableId)
    }
  }, AUTO_DEAL_MS)
}

function refreshTurnTimer(tableId) {
  const room = getRoom(tableId)
  if (!room) return
  clearTurn(room)
  const g = room.game
  if (!g || g.phase === 'idle' || g.phase === 'showdown' || g.currentPlayer < 0) {
    if (g) g.turnDeadline = null
    return
  }
  const cur = g.players[g.currentPlayer]
  if (!cur || cur.folded || cur.allIn) {
    if (g) g.turnDeadline = null
    return
  }
  const deadline = Date.now() + TURN_SECONDS * 1000
  g.turnDeadline = deadline
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null
    const rg = room.game
    if (!rg || rg.turnDeadline !== deadline) return
    const p = rg.players[rg.currentPlayer]
    if (!p || p.socketId !== cur.socketId) return
    const toCall = Math.max(0, rg.currentBet - p.streetBet)
    if (toCall === 0) handleAction(room, p.socketId, { type: 'check' })
    else if (p.unlimitedChips || p.stack >= toCall) handleAction(room, p.socketId, { type: 'call' })
    else handleAction(room, p.socketId, { type: 'fold' })
    afterAction(room, tableId)
  }, TURN_SECONDS * 1000)
}

function afterAction(room, tableId) {
  const g = room.game
  if (g?.phase === 'idle') {
    clearTurn(room)
    scheduleAutoDeal(tableId)
  }
  broadcast(tableId)
  refreshTurnTimer(tableId)
}

function handLabelFor(p, g) {
  if (!p.holeCards?.length || g.community.length < 3) return null
  const s =
    g.variant === 'NLHE' ? bestNLHE(p.holeCards, g.community) : bestOmaha(p.holeCards, g.community)
  return s ? HAND_NAMES[s[0]] : null
}

/**
 * @param viewerRp Room player row for this payload recipient (socketId, isSuperAdmin).
 * Opponents' hand labels and hole data are never included in shared fields for non–super admins.
 */
function sanitizeGame(game, viewerRp) {
  if (!game) return null
  const vsid = viewerRp?.socketId
  const vSuper = !!viewerRp?.isSuperAdmin
  const reveal = !!game.showAllCards
  return {
    variant: game.variant,
    phase: game.phase,
    community: game.community,
    pot: game.pot,
    currentBet: game.currentBet,
    minRaise: game.minRaise,
    dealer: game.dealer,
    currentPlayer: game.currentPlayer,
    turnDeadline: game.turnDeadline ?? null,
    winners: game.winners,
    showAllCards: game.showAllCards,
    log: game.log.slice(-50),
    players: game.players.map(p => {
      let handLabel = null
      if (!p.folded && vsid != null) {
        const hl = handLabelFor(p, game)
        if (hl) {
          if (p.socketId === vsid && game.phase === 'showdown') handLabel = hl
          else if (vSuper && reveal) handLabel = hl
        }
      }
      return {
        socketId: p.socketId,
        name: p.name,
        stack: p.unlimitedChips ? null : p.stack,
        unlimitedChips: p.unlimitedChips,
        streetBet: p.streetBet,
        folded: p.folded,
        allIn: p.allIn,
        seat: p.seat,
        holeCount: p.holeCards?.length ?? 0,
        handLabel,
      }
    }),
  }
}

function sanitizeStats(stats) {
  const out = {}
  for (const [k, v] of Object.entries(stats || {})) {
    out[k] = { wins: v.wins || 0, losses: v.losses || 0, netChips: v.netChips || 0 }
  }
  return out
}

function syncIdleGameWithRoom(room) {
  const g = room.game
  if (!g || g.phase !== 'idle') return
  const prevById = new Map(g.players.map(p => [p.socketId, p]))
  g.players = room.players.map(rp => {
    const prev = prevById.get(rp.socketId)
    if (prev) {
      return {
        ...prev,
        name: rp.name,
        seat: rp.seat,
        stack: rp.stack,
        unlimitedChips: rp.unlimitedChips,
      }
    }
    return {
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
    }
  })
}

function broadcast(tableId) {
  const room = getRoom(tableId)
  if (!room) return
  const g = room.game
  const shared = {
    tableId: room.tableId,
    tableName: room.name || room.tableId,
    players: room.players.map(p => ({
      socketId: p.socketId,
      name: p.name,
      stack: p.unlimitedChips ? null : p.stack,
      unlimitedChips: p.unlimitedChips,
      seat: p.seat,
      isHost: p.socketId === room.hostId,
      isSuperAdmin: !!p.isSuperAdmin,
      online: true,
    })),
    hostId: room.hostId,
    hostBank: room.hostBank,
    gameType: room.gameType,
    gameTypes: Object.keys(VARIANTS),
    maxSeats: effectiveMaxSeats(room),
    chat: room.chat.slice(-CHAT_MAX),
    stats: sanitizeStats(room.stats),
    turnActionSeconds: TURN_SECONDS,
    autoDealAt: room.autoDealAt,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
  }

  for (const rp of room.players) {
    io.to(rp.socketId).emit('room_update', {
      ...shared,
      game: sanitizeGame(g, rp),
    })
  }

  if (g && g.phase !== 'idle') {
    for (const p of g.players) {
      const cards = p.holeCards || []
      io.to(p.socketId).emit('your_hole_cards', cards)
    }
    const allHands = {}
    for (const p of g.players) {
      allHands[p.socketId] = p.holeCards || []
    }
    const sendAll = !!g.showAllCards
    for (const rp of room.players) {
      if (rp.isSuperAdmin && sendAll) {
        io.to(rp.socketId).emit('all_hole_cards', allHands)
      } else {
        io.to(rp.socketId).emit('all_hole_cards', null)
      }
    }
  } else {
    for (const rp of room.players) {
      io.to(rp.socketId).emit('your_hole_cards', [])
      io.to(rp.socketId).emit('all_hole_cards', null)
    }
  }
}

function removeFromTable(tableId, socketId) {
  const room = getRoom(tableId)
  if (!room) return
  const leaving = room.players.find(p => p.socketId === socketId)
  clearTurn(room)
  if (room.game && room.game.phase !== 'idle') {
    const ingame = room.game.players.some(p => p.socketId === socketId)
    if (ingame) {
      room.game = null
      clearAutoDeal(room)
      io.to(tableId).emit('error_msg', 'Hand cancelled — a player disconnected.')
    }
  }
  transferHost(room, socketId)
  room.players = room.players.filter(p => p.socketId !== socketId)
  if (leaving?.name) {
    delete room.stats[statKey(leaving.name)]
  }
  room.players.forEach((p, i) => {
    p.seat = i
  })
  syncIdleGameWithRoom(room)
  assignHostIfNeeded(room)

  if (room.players.length === 0) {
    clearTurn(room)
    clearAutoDeal(room)
    rooms.delete(tableId)
    return
  }
  broadcast(tableId)
}

function leaveCurrentTable(socket) {
  const tableId = socket.data.tableId
  if (!tableId) return
  socket.leave(tableId)
  removeFromTable(tableId, socket.id)
  socket.data.tableId = null
}

function addPlayerToRoom(socket, room, name, isSuper) {
  room.players.push({
    socketId: socket.id,
    name,
    seat: room.players.length,
    stack: 0,
    joinedAt: Date.now(),
    unlimitedChips: false,
    isSuperAdmin: isSuper,
  })
  if (room.players.length === 1) {
    room.hostId = socket.id
  }
  syncHostFlags(room)
  assignHostIfNeeded(room)
  socket.join(room.tableId)
  socket.data.tableId = room.tableId
  socket.data.name = name
  syncIdleGameWithRoom(room)
  broadcast(room.tableId)
}

io.on('connection', socket => {
  socket.on('join_lobby', () => {
    lobbySockets.add(socket.id)
    broadcastLobbyHostFlags()
  })

  socket.on('leave_lobby', () => {
    lobbySockets.delete(socket.id)
    broadcastLobbyHostFlags()
  })

  socket.on('get_tables', () => {
    let newToLobby = false
    if (!socket.data.tableId && !lobbySockets.has(socket.id)) {
      lobbySockets.add(socket.id)
      newToLobby = true
    }
    const hostId = getLobbyHostId()
    socket.emit('tables_list', {
      tables: buildTableSummaries(),
      onlineCount: io.sockets.sockets.size,
      isLobbyHost: hostId != null && socket.id === hostId,
    })
    if (newToLobby) broadcastLobbyHostFlags()
  })

  socket.on('create_table', payload => {
    pruneLobbySockets()
    const hostId = getLobbyHostId()
    if (
      lobbySockets.size > 0 &&
      (hostId == null || socket.id !== hostId)
    ) {
      socket.emit('error_msg', 'Only the first player in the lobby can create a table.')
      return
    }
    const name = String(payload?.name ?? '').trim()
    const gameType = payload?.gameType
    const playerName = String(payload?.playerName ?? '').trim()
    const superAdminPin = payload?.superAdminPin ?? payload?.pin
    const stakes = payload?.stakes || {}
    const sb = Math.trunc(Number(stakes.smallBlind ?? payload?.smallBlind))
    const bb = Math.trunc(Number(stakes.bigBlind ?? payload?.bigBlind))
    const maxPlayers = Math.trunc(Number(payload?.maxPlayers))
    const tablePassword = normalizedSecret(payload?.password)

    if (!name) {
      socket.emit('error_msg', 'Enter a table name.')
      return
    }
    if (!playerName) {
      socket.emit('error_msg', 'Enter your display name (join lobby first).')
      return
    }
    if (!VARIANTS[gameType]) {
      socket.emit('error_msg', 'Invalid game type.')
      return
    }
    if (!Number.isFinite(sb) || sb < 1 || !Number.isFinite(bb) || bb < 1) {
      socket.emit('error_msg', 'Enter valid small blind and big blind amounts.')
      return
    }
    if (bb < sb) {
      socket.emit('error_msg', 'Big blind must be at least the small blind.')
      return
    }
    if (!ALLOWED_MAX_PLAYERS.has(maxPlayers)) {
      socket.emit('error_msg', 'Max players must be 2, 4, 6, or 9.')
      return
    }
    if (playerName === SUPER_ADMIN_NAME && !isSuperAdminCredentials(playerName, superAdminPin)) {
      socket.emit(
        'error_msg',
        'Display name SIMPLY.LUCKY is reserved. Enter the correct super admin PIN to use it.',
      )
      return
    }

    const cap = effectiveMaxSeatsFor({ maxPlayers, gameType }, gameType)
    if (cap < 2) {
      socket.emit('error_msg', 'Invalid seat configuration.')
      return
    }

    leaveCurrentTable(socket)

    const tableId = newTableId()
    const room = {
      tableId,
      name,
      hostId: null,
      hostBank: HOST_BANK_START,
      gameType,
      smallBlind: sb,
      bigBlind: bb,
      maxPlayers,
      tablePassword,
      players: [],
      chat: [],
      stats: {},
      game: null,
      turnTimer: null,
      autoDealTimer: null,
      autoDealAt: null,
    }
    rooms.set(tableId, room)

    const isSuper = isSuperAdminCredentials(playerName, superAdminPin)
    addPlayerToRoom(socket, room, playerName, isSuper)
    socket.emit('created_table', { tableId })
  })

  socket.on('join_table', payload => {
    const tableId = String(payload?.tableId ?? '').trim()
    const name = String(payload?.playerName ?? '').trim()
    const tablePwd = normalizedSecret(payload?.password)
    const superAdminPin = payload?.superAdminPin ?? payload?.pin

    if (!tableId) {
      socket.emit('error_msg', 'Select a table.')
      return
    }
    if (!name) {
      socket.emit('error_msg', 'Enter a display name.')
      return
    }

    const room = getRoom(tableId)
    if (!room) {
      socket.emit('error_msg', 'That table no longer exists.')
      return
    }

    if (name === SUPER_ADMIN_NAME && !isSuperAdminCredentials(name, superAdminPin)) {
      socket.emit(
        'error_msg',
        'Display name SIMPLY.LUCKY is reserved. Enter the correct super admin PIN to use it.',
      )
      return
    }

    if (room.tablePassword && tablePwd !== room.tablePassword) {
      socket.emit('error_msg', 'Wrong table password.')
      return
    }

    const maxSeat = effectiveMaxSeats(room)
    if (room.players.length >= maxSeat && !room.players.find(p => p.socketId === socket.id)) {
      socket.emit('error_msg', `Table is full (${maxSeat} seats).`)
      return
    }

    if (socket.data.tableId && socket.data.tableId !== tableId) {
      leaveCurrentTable(socket)
    }

    if (room.players.find(p => p.socketId === socket.id)) {
      socket.join(tableId)
      socket.data.tableId = tableId
      socket.data.name = name
      broadcast(tableId)
      return
    }

    const dup = room.players.find(
      p => p.name.trim().toLowerCase() === name.toLowerCase() && p.socketId !== socket.id,
    )
    if (dup) {
      const oldId = dup.socketId
      const wasHost = room.hostId === oldId
      room.players = room.players.filter(p => p.socketId !== oldId)
      room.players.forEach((p, i) => {
        p.seat = i
      })
      if (wasHost) {
        room.hostId = room.players[0]?.socketId ?? null
        syncHostFlags(room)
      }
      io.to(oldId).emit('kicked')
      io.sockets.sockets.get(oldId)?.disconnect(true)
      delete room.stats[statKey(dup.name)]
    }

    const isSuper = isSuperAdminCredentials(name, superAdminPin)
    addPlayerToRoom(socket, room, name, isSuper)
  })

  socket.on('leave_table', ({ tableId: tid }) => {
    const cur = socket.data.tableId
    if (!cur) return
    if (tid && tid !== cur) return
    leaveCurrentTable(socket)
  })

  socket.on('set_game_type', ({ tableId, gameType }) => {
    const room = getRoom(tableId)
    if (!assertHost(socket, room)) return
    if (!VARIANTS[gameType]) {
      socket.emit('error_msg', 'Invalid game type.')
      return
    }
    if (room.game && room.game.phase !== 'idle') {
      socket.emit('error_msg', 'Wait until the hand is over.')
      return
    }
    const cap = effectiveMaxSeatsFor(room, gameType)
    if (room.players.length > cap) {
      socket.emit('error_msg', `${gameType} allows at most ${cap} players at this table. Remove seats first.`)
      return
    }
    room.gameType = gameType
    broadcast(tableId)
  })

  socket.on('host_assign_chips', ({ tableId, targetSocketId, amount }) => {
    const room = getRoom(tableId)
    if (!assertHost(socket, room)) return
    const target = room.players.find(p => p.socketId === targetSocketId)
    if (!target) {
      socket.emit('error_msg', 'That player is not at this table.')
      return
    }
    if (target.unlimitedChips) {
      socket.emit('error_msg', 'Use chip controls on seated players, not the host seat.')
      return
    }
    const amt = Math.trunc(Number(amount))
    if (!Number.isFinite(amt) || amt === 0) {
      socket.emit('error_msg', 'Enter a valid chip amount.')
      return
    }
    const g = room.game
    const phase = g?.phase
    if (g && phase !== 'idle' && phase !== 'showdown') {
      socket.emit('error_msg', 'Wait until the hand is finished to move chips.')
      return
    }
    if (amt > 0) {
      if (amt > room.hostBank) {
        socket.emit('error_msg', 'Not enough chips in the host bank.')
        return
      }
      room.hostBank -= amt
      target.stack += amt
    } else {
      const take = Math.min(-amt, target.stack)
      if (take <= 0) {
        socket.emit('error_msg', 'That player has no chips to take back.')
        return
      }
      target.stack -= take
      room.hostBank += take
    }
    syncIdleGameWithRoom(room)
    broadcast(tableId)
    if (!room.game && canStartHand(room)) scheduleAutoDeal(tableId)
  })

  socket.on('kick_player', ({ tableId, targetSocketId }) => {
    const room = getRoom(tableId)
    if (!assertHost(socket, room)) return
    if (targetSocketId === socket.id) return
    const target = room.players.find(p => p.socketId === targetSocketId)
    if (!target) return
    io.to(targetSocketId).emit('kicked')
    io.sockets.sockets.get(targetSocketId)?.disconnect(true)
  })

  socket.on('host_deal', ({ tableId }) => {
    const room = getRoom(tableId)
    if (!assertHost(socket, room)) return
    if (room.game && room.game.phase !== 'idle') {
      socket.emit('error_msg', 'A hand is already in progress.')
      return
    }
    clearAutoDeal(room)
    if (!canStartHand(room)) {
      socket.emit('error_msg', 'Need at least 2 players with stacks at least equal to the big blind.')
      return
    }
    if (startHand(room)) {
      broadcast(tableId)
      refreshTurnTimer(tableId)
    }
  })

  socket.on('host_next_hand', ({ tableId }) => {
    const room = getRoom(tableId)
    if (!assertHost(socket, room)) return
    if (room.game && room.game.phase !== 'idle') {
      socket.emit('error_msg', 'Finish the current hand before starting the next.')
      return
    }
    clearAutoDeal(room)
    if (!canStartHand(room)) {
      socket.emit('error_msg', 'Need at least 2 players with stacks at least equal to the big blind.')
      return
    }
    if (startHand(room)) {
      broadcast(tableId)
      refreshTurnTimer(tableId)
    }
  })

  socket.on('host_reveal_cards', ({ tableId, reveal }) => {
    const room = getRoom(tableId)
    if (!assertHost(socket, room)) return
    const g = room.game
    if (!g || g.phase === 'idle') {
      socket.emit('error_msg', 'No active hand to reveal.')
      return
    }
    g.showAllCards = reveal !== false
    broadcast(tableId)
  })

  socket.on('player_action', ({ tableId, action }) => {
    const room = getRoom(tableId)
    if (!room?.game) return
    const r = handleAction(room, socket.id, action)
    if (r.ok) afterAction(room, tableId)
  })

  socket.on('chat_message', ({ tableId, text }) => {
    const room = getRoom(tableId)
    if (!room) return
    const p = room.players.find(x => x.socketId === socket.id)
    if (!p) return
    const t = String(text ?? '').trim().slice(0, 200)
    if (!t) return
    room.chat.push({ from: p.name, text: t, ts: Date.now() })
    while (room.chat.length > CHAT_MAX) room.chat.shift()
    broadcast(tableId)
  })

  socket.on('request_raise_bounds', ({ tableId }) => {
    const room = getRoom(tableId)
    const g = room?.game
    if (!g || g.phase === 'idle') return
    const idx = g.players.findIndex(p => p.socketId === socket.id)
    if (idx < 0 || g.currentPlayer !== idx) return
    socket.emit('raise_bounds', getRaiseBounds(g, idx))
  })

  socket.on('disconnect', () => {
    const wasInLobby = lobbySockets.has(socket.id)
    lobbySockets.delete(socket.id)
    if (wasInLobby) broadcastLobbyHostFlags()
    const tableId = socket.data.tableId
    if (tableId) removeFromTable(tableId, socket.id)
  })
})

httpServer.listen(PORT, () => {
  console.log(`FeltClub server http://localhost:${PORT}`)
})
