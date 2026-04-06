import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import socket from './socket'

const SUPER_ADMIN_NAME = 'SIMPLY.LUCKY'
const MAX_PLAYER_OPTIONS = [2, 4, 6, 9]

/** Board (community) and hole card layouts in CSS px at scale 1. */
const CARD_LAYOUT = {
  board: { w: 75, h: 105, rank: 28, suit: 22, radius: 8, suitMarginTop: 6 },
  hole: { w: 60, h: 84, rank: 22, suit: 18, radius: 8, suitMarginTop: 5 },
}
const BOARD_CARD_GAP = 10
const HOLE_CARD_GAP = 6

const VARIANT_HOLES = { NLHE: 2, PLO4: 4, PLO5: 5, PLO6: 6 }

const PHASE_LABELS = {
  preflop: 'Preflop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
  showdown: 'Showdown',
  idle: 'Between hands',
}

const FOUR_COLOR_STORAGE_KEY = 'feltclub-fourColorDeck'

function readFourColorPref() {
  try {
    const v = localStorage.getItem(FOUR_COLOR_STORAGE_KEY)
    if (v === null) return true
    return v === '1'
  } catch {
    return true
  }
}

function rankStr(r) {
  const m = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 10: 'T' }
  return m[r] || String(r)
}

/** Classic: red h/d, black c/s. 4-colour: same red/black anchors + blue diamonds / green clubs. */
const SUIT_COLORS_CLASSIC = { h: '#e01010', d: '#e01010', c: '#111111', s: '#111111' }
const SUIT_COLORS_FOUR = { h: '#e01010', d: '#1565c0', c: '#1b5e20', s: '#111111' }

function Card({ card, variant = 'hole', back, fourColor }) {
  const faceL = variant === 'board' ? CARD_LAYOUT.board : CARD_LAYOUT.hole
  const L = back ? CARD_LAYOUT.hole : faceL
  const w = L.w
  const h = L.h
  const br = L.radius
  if (back) {
    return (
      <div
        style={{
          width: w,
          height: h,
          borderRadius: br,
          boxSizing: 'border-box',
          flexShrink: 0,
          background: `
            repeating-linear-gradient(
              45deg,
              transparent,
              transparent 5px,
              rgba(255,255,255,0.07) 5px,
              rgba(255,255,255,0.07) 10px
            ),
            #1a3a8a
          `,
          border: '2px solid rgba(0,0,0,0.35)',
          boxShadow:
            'inset 0 0 0 2px rgba(255,255,255,0.2), inset 0 0 0 5px rgba(0,0,0,0.15), inset 0 0 0 7px rgba(255,255,255,0.1), 0 2px 10px rgba(0,0,0,0.35)',
        }}
      />
    )
  }
  const suitSym = { h: '♥', d: '♦', c: '♣', s: '♠' }
  const fc = fourColor ? SUIT_COLORS_FOUR : SUIT_COLORS_CLASSIC
  const col = fc[card.s] || '#ccc'
  return (
    <div
      style={{
        width: w,
        height: h,
        borderRadius: br,
        boxSizing: 'border-box',
        background: '#ffffff',
        border: '2px solid #ddd',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: col,
        fontWeight: 900,
        fontSize: L.rank,
        lineHeight: 1,
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      <span style={{ fontWeight: 900 }}>{rankStr(card.r)}</span>
      <span style={{ fontSize: L.suit, lineHeight: 1.1, fontWeight: 900, marginTop: L.suitMarginTop }}>
        {suitSym[card.s]}
      </span>
    </div>
  )
}

function useViewportWidth() {
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1024))
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

/** Scale factor so a row of `count` cards of width `cardW` + gaps fits within `budgetPx`. */
function rowFitScale(count, cardW, gap, budgetPx) {
  if (count <= 0 || budgetPx <= 0) return 1
  const rowW = count * cardW + Math.max(0, count - 1) * gap
  return rowW > budgetPx ? Math.max(0.45, budgetPx / rowW) : 1
}

function seatPosition(i, n, rxPct, ryPct) {
  const a = (Math.PI * 2 * i) / n - Math.PI / 2
  return {
    left: `calc(50% + ${Math.cos(a) * rxPct}%)`,
    top: `calc(50% + ${Math.sin(a) * ryPct}%)`,
    transform: 'translate(-50%, -50%)',
  }
}

export default function App() {
  const [connected, setConnected] = useState(socket.connected)
  const [screen, setScreen] = useState('login')
  const [nameInput, setNameInput] = useState('')
  const [joiningTable, setJoiningTable] = useState(false)
  /** After a failed join/create, show PIN field for reserved display name (lobby only). */
  const [showSuperPinField, setShowSuperPinField] = useState(false)
  const [tables, setTables] = useState([])
  const [onlineCount, setOnlineCount] = useState(0)
  const [tableId, setTableId] = useState(null)
  const [tableName, setTableName] = useState('')
  const [savedSuperPin, setSavedSuperPin] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createGameType, setCreateGameType] = useState('NLHE')
  const [createSb, setCreateSb] = useState('10')
  const [createBb, setCreateBb] = useState('20')
  const [createMax, setCreateMax] = useState(6)
  const [createPwd, setCreatePwd] = useState('')
  const [joinPwdModal, setJoinPwdModal] = useState(null)
  const [joinPwdInput, setJoinPwdInput] = useState('')
  const [isLobbyHost, setIsLobbyHost] = useState(false)

  const [roomPlayers, setRoomPlayers] = useState([])
  const [game, setGame] = useState(null)
  const [hostId, setHostId] = useState(null)
  const [hostBank, setHostBank] = useState(50000)
  const [gameType, setGameType] = useState('NLHE')
  const [gameTypes, setGameTypes] = useState(['NLHE', 'PLO4', 'PLO5', 'PLO6'])
  const [maxSeats, setMaxSeats] = useState(10)
  const [chat, setChat] = useState([])
  const [stats, setStats] = useState({})
  const [turnSec, setTurnSec] = useState(15)
  const [autoDealAt, setAutoDealAt] = useState(null)
  const [smallBlind, setSmallBlind] = useState(10)
  const [bigBlind, setBigBlind] = useState(20)

  const [myName, setMyName] = useState('')
  const [myCards, setMyCards] = useState([])
  const [allHoleCards, setAllHoleCards] = useState(null)

  const [chatInput, setChatInput] = useState('')
  const [hostAssignAmt, setHostAssignAmt] = useState('')
  const [fourColor, setFourColor] = useState(readFourColorPref)
  const [error, setError] = useState('')
  const [raiseBounds, setRaiseBounds] = useState(null)
  const [raiseTo, setRaiseTo] = useState(0)
  const [now, setNow] = useState(Date.now())

  const logRef = useRef(null)
  const screenRef = useRef(screen)
  const joinPending = useRef(false)
  /** Server is source of truth; ignore all_hole_cards unless this is true. */
  const isSuperAdminRef = useRef(false)

  const vw = useViewportWidth()

  const boardScale = useMemo(() => {
    const budget = Math.max(220, Math.min(vw * 0.92 - 20, 580))
    return rowFitScale(5, CARD_LAYOUT.board.w, BOARD_CARD_GAP, budget)
  }, [vw])

  const holeScale = useMemo(() => {
    const n = VARIANT_HOLES[game?.variant ?? gameType] ?? 6
    const budget =
      vw < 640 ? Math.max(160, vw - 36) : Math.min(400, Math.floor(vw * 0.33))
    return rowFitScale(n, CARD_LAYOUT.hole.w, HOLE_CARD_GAP, budget)
  }, [vw, gameType, game?.variant])

  const boardRowW = 5 * CARD_LAYOUT.board.w + 4 * BOARD_CARD_GAP
  const boardRowH = CARD_LAYOUT.board.h
  const maxHoleCards = VARIANT_HOLES[game?.variant ?? gameType] ?? 6
  const holeRowW = maxHoleCards * CARD_LAYOUT.hole.w + Math.max(0, maxHoleCards - 1) * HOLE_CARD_GAP
  const holeRowH = CARD_LAYOUT.hole.h

  useEffect(() => {
    screenRef.current = screen
  }, [screen])

  useEffect(() => {
    if (screen === 'table') setShowSuperPinField(false)
  }, [screen])

  useEffect(() => {
    const onConnect = () => {
      setConnected(true)
    }
    const onDisconnect = () => setConnected(false)
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
    }
  }, [])

  useEffect(() => {
    const onTablesList = ({ tables: t, onlineCount: oc, isLobbyHost: ilh }) => {
      setTables(Array.isArray(t) ? t : [])
      setOnlineCount(typeof oc === 'number' ? oc : 0)
      if (typeof ilh === 'boolean') setIsLobbyHost(ilh)
    }
    const onLobbyState = ({ isLobbyHost: ilh }) => {
      if (typeof ilh === 'boolean') setIsLobbyHost(ilh)
    }
    const onCreated = ({ tableId: tid }) => {
      if (tid) setTableId(tid)
      setJoiningTable(false)
      setScreen('table')
    }
    socket.on('tables_list', onTablesList)
    socket.on('lobby_state', onLobbyState)
    socket.on('created_table', onCreated)
    return () => {
      socket.off('tables_list', onTablesList)
      socket.off('lobby_state', onLobbyState)
      socket.off('created_table', onCreated)
    }
  }, [])

  useEffect(() => {
    if (screen !== 'lobby') return
    socket.emit('join_lobby')
    const pull = () => socket.emit('get_tables')
    pull()
    const id = setInterval(pull, 5000)
    return () => {
      clearInterval(id)
      socket.emit('leave_lobby')
    }
  }, [screen])

  useEffect(() => {
    const onRoom = payload => {
      if (joinPending.current) {
        joinPending.current = false
        setJoiningTable(false)
        setScreen('table')
      }
      if (payload.tableId) setTableId(payload.tableId)
      if (payload.tableName) setTableName(payload.tableName)
      setRoomPlayers(payload.players || [])
      setGame(payload.game)
      setHostId(payload.hostId)
      if (typeof payload.hostBank === 'number') setHostBank(payload.hostBank)
      if (payload.gameType) setGameType(payload.gameType)
      if (Array.isArray(payload.gameTypes)) setGameTypes(payload.gameTypes)
      if (typeof payload.maxSeats === 'number') setMaxSeats(payload.maxSeats)
      setChat(payload.chat || [])
      setStats(payload.stats || {})
      if (typeof payload.turnActionSeconds === 'number') setTurnSec(payload.turnActionSeconds)
      setAutoDealAt(typeof payload.autoDealAt === 'number' ? payload.autoDealAt : null)
      if (typeof payload.smallBlind === 'number') setSmallBlind(payload.smallBlind)
      if (typeof payload.bigBlind === 'number') setBigBlind(payload.bigBlind)
      const meRow = (payload.players || []).find(p => p.socketId === socket.id)
      isSuperAdminRef.current = !!meRow?.isSuperAdmin
      if (!meRow?.isSuperAdmin) setAllHoleCards(null)
      if (Array.isArray(payload.yourHoleCards)) {
        setMyCards(payload.yourHoleCards)
      }
    }
    const onYour = cards => setMyCards(Array.isArray(cards) ? cards : [])
    const onAll = hands => {
      if (!isSuperAdminRef.current) {
        setAllHoleCards(null)
        return
      }
      if (hands != null && typeof hands === 'object') setAllHoleCards(hands)
      else setAllHoleCards(null)
    }
    const onErr = msg => {
      if (joinPending.current) {
        joinPending.current = false
        setJoiningTable(false)
      }
      setJoiningTable(false)
      setError(msg)
      if (
        screenRef.current === 'lobby' &&
        typeof msg === 'string' &&
        (msg.includes('SIMPLY.LUCKY') || msg.toLowerCase().includes('super admin pin'))
      ) {
        setShowSuperPinField(true)
      }
      setTimeout(() => setError(''), 5000)
    }
    const onKicked = () => {
      isSuperAdminRef.current = false
      setTableId(null)
      setTableName('')
      setScreen('lobby')
      setMyCards([])
      setAllHoleCards(null)
    }
    const onBounds = b => {
      if (b && typeof b === 'object') setRaiseBounds(b)
    }
    socket.on('room_update', onRoom)
    socket.on('your_hole_cards', onYour)
    socket.on('all_hole_cards', onAll)
    socket.on('error_msg', onErr)
    socket.on('kicked', onKicked)
    socket.on('raise_bounds', onBounds)
    return () => {
      socket.off('room_update', onRoom)
      socket.off('your_hole_cards', onYour)
      socket.off('all_hole_cards', onAll)
      socket.off('error_msg', onErr)
      socket.off('kicked', onKicked)
      socket.off('raise_bounds', onBounds)
    }
  }, [])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [game?.log])

  useEffect(() => {
    if (!game?.turnDeadline && autoDealAt == null) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [game?.turnDeadline, autoDealAt])

  const sid = socket.id
  const me = useMemo(() => roomPlayers.find(p => p.socketId === sid), [roomPlayers, sid])
  const isHost = me?.isHost
  const isSuper = me?.isSuperAdmin

  const gamePlayers = game?.players || []
  const myGameIdx = gamePlayers.findIndex(p => p.socketId === sid)
  const myTurn =
    game &&
    game.phase !== 'idle' &&
    game.phase !== 'showdown' &&
    myGameIdx === game.currentPlayer &&
    !gamePlayers[myGameIdx]?.folded &&
    !gamePlayers[myGameIdx]?.allIn

  useEffect(() => {
    if (myTurn && tableId) {
      socket.emit('request_raise_bounds', { tableId })
    } else {
      setRaiseBounds(null)
    }
  }, [myTurn, tableId, game?.pot, game?.currentBet, game?.currentPlayer])

  useEffect(() => {
    if (raiseBounds) {
      setRaiseTo(raiseBounds.minRaiseTo)
    }
  }, [raiseBounds])

  function joinLobbySubmit(e) {
    e.preventDefault()
    const name = nameInput.trim()
    if (!name) return
    setMyName(name)
    setSavedSuperPin('')
    setShowSuperPinField(false)
    setScreen('lobby')
  }

  function backToLobby() {
    if (tableId) socket.emit('leave_table', { tableId })
    setTableId(null)
    setTableName('')
    setScreen('lobby')
  }

  function emitJoinTable(tid, tablePassword = '') {
    if (!myName.trim() || !tid) return
    joinPending.current = true
    setJoiningTable(true)
    socket.emit('join_table', {
      tableId: tid,
      playerName: myName.trim(),
      password: tablePassword,
      superAdminPin: savedSuperPin,
    })
  }

  function openJoinTable(row) {
    if (joiningTable) return
    if (row.hasPassword) {
      setJoinPwdInput('')
      setJoinPwdModal({ tableId: row.tableId, name: row.name })
      return
    }
    emitJoinTable(row.tableId, '')
  }

  function submitJoinPwd(e) {
    e.preventDefault()
    if (!joinPwdModal) return
    setJoinPwdModal(null)
    emitJoinTable(joinPwdModal.tableId, joinPwdInput.trim())
  }

  function submitCreateTable(e) {
    e.preventDefault()
    const n = createName.trim()
    if (!n || !myName.trim()) return
    const sb = Math.trunc(Number(createSb))
    const bb = Math.trunc(Number(createBb))
    if (!Number.isFinite(sb) || sb < 1 || !Number.isFinite(bb) || bb < 1) return
    setJoiningTable(true)
    socket.emit('create_table', {
      name: n,
      gameType: createGameType,
      stakes: { smallBlind: sb, bigBlind: bb },
      maxPlayers: createMax,
      password: createPwd.trim(),
      playerName: myName.trim(),
      superAdminPin: savedSuperPin,
    })
    setShowCreate(false)
    setCreatePwd('')
  }

  const sendChat = useCallback(() => {
    const t = chatInput.trim()
    if (!t || !tableId) return
    socket.emit('chat_message', { tableId, text: t })
    setChatInput('')
  }, [chatInput, tableId])

  const doAction = useCallback(
    type => {
      if (!tableId) return
      socket.emit('player_action', { tableId, action: { type } })
    },
    [tableId],
  )

  const doRaise = useCallback(() => {
    if (!tableId) return
    socket.emit('player_action', {
      tableId,
      action: { type: 'raise', amount: raiseTo },
    })
  }, [raiseTo, tableId])

  const assignChips = (targetId, signed) => {
    if (!tableId) {
      setError('Not connected to a table.')
      setTimeout(() => setError(''), 4000)
      return
    }
    const raw = String(hostAssignAmt ?? '').trim()
    let n = Math.trunc(Number(raw))
    if (!Number.isFinite(n) || n === 0) {
      n = 100
    }
    const amt = signed * Math.abs(n)
    socket.emit('host_assign_chips', { tableId, targetSocketId: targetId, amount: amt })
  }

  const kick = targetId => {
    if (!tableId) return
    if (!window.confirm('Remove this player from the table?')) return
    socket.emit('kick_player', { tableId, targetSocketId: targetId })
  }

  const changeGameType = gt => {
    if (!tableId) return
    socket.emit('set_game_type', { tableId, gameType: gt })
  }

  const hostDeal = () => {
    if (!tableId) return
    socket.emit('host_deal', { tableId })
  }

  const hostNextHand = () => {
    if (!tableId) return
    socket.emit('host_next_hand', { tableId })
  }

  const hostReveal = reveal => {
    if (!tableId) return
    socket.emit('host_reveal_cards', { tableId, reveal })
  }

  const shareUrl = typeof window !== 'undefined' ? window.location.origin : ''

  const autoSecs =
    autoDealAt != null ? Math.max(0, Math.ceil((autoDealAt - now) / 1000)) : null

  const actSecsLeft = useMemo(() => {
    if (!game?.turnDeadline) return null
    return Math.max(0, Math.ceil((game.turnDeadline - now) / 1000))
  }, [game?.turnDeadline, now])

  const tableSeats = maxSeats
  const seatSlots = useMemo(() => {
    const bySeat = {}
    roomPlayers.forEach(p => {
      const s = typeof p.seat === 'number' ? p.seat : 0
      bySeat[s] = p
    })
    return Array.from({ length: tableSeats }, (_, i) => bySeat[i] || null)
  }, [roomPlayers, tableSeats])

  /** Occupied seats spaced evenly on the arc (avoids overlap when maxSeats is large). */
  const occupiedSorted = useMemo(
    () => [...roomPlayers].sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0)),
    [roomPlayers],
  )
  const occupiedCount = Math.max(occupiedSorted.length, 1)

  const mergedGamePlayers = useCallback(
    socketId => {
      const gp = gamePlayers.find(p => p.socketId === socketId)
      if (!gp) return null
      return gp
    },
    [gamePlayers],
  )

  function cardsForSeat(slotPlayer) {
    if (!slotPlayer || !game) return null
    const gp = mergedGamePlayers(slotPlayer.socketId)
    const holeN = gp?.holeCount ?? VARIANT_HOLES[game.variant] ?? 2

    if (slotPlayer.socketId === sid) {
      if (myCards.length) return myCards
      if (
        me?.isSuperAdmin &&
        game.showAllCards &&
        allHoleCards &&
        Array.isArray(allHoleCards[slotPlayer.socketId]) &&
        allHoleCards[slotPlayer.socketId].length
      ) {
        return allHoleCards[slotPlayer.socketId]
      }
      return null
    }
    if (
      me?.isSuperAdmin &&
      game.showAllCards &&
      allHoleCards &&
      allHoleCards[slotPlayer.socketId]
    ) {
      return allHoleCards[slotPlayer.socketId]
    }

    if (!gp) {
      if (game.phase === 'idle' || game.phase === 'showdown') return null
      if (holeN > 0) return Array.from({ length: holeN }, () => null)
      return null
    }

    if (game.showAllCards && gp.holeCount && !me?.isSuperAdmin) {
      return Array.from({ length: gp.holeCount }, () => null)
    }
    if (gp.holeCount) return Array.from({ length: gp.holeCount }, () => null)
    return null
  }

  if (screen === 'login') {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'radial-gradient(ellipse at center,#121820 0%,#07090e 70%)',
        }}
      >
        <form
          onSubmit={joinLobbySubmit}
          style={{
            width: 360,
            padding: 36,
            borderRadius: 16,
            background: '#11151c',
            border: '1px solid #2a3544',
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          }}
        >
          <h1 style={{ margin: '0 0 8px', fontSize: 28, letterSpacing: 3, color: '#6eb5ff' }}>
            FELT<span style={{ color: '#5a6a7a', fontWeight: 400 }}>CLUB</span>
          </h1>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginBottom: 24,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: connected ? '#4caf50' : '#e53935',
                flexShrink: 0,
                boxShadow: connected ? '0 0 8px rgba(76,175,80,0.5)' : 'none',
              }}
            />
            <span style={{ fontSize: 13, color: '#7a8a9a' }}>
              {connected ? 'Connected to server' : 'Connecting…'}
            </span>
          </div>
          <input
            name="displayName"
            autoFocus
            placeholder="Display name"
            value={nameInput}
            onChange={e => setNameInput(e.target.value)}
            style={{
              width: '100%',
              padding: '12px 14px',
              marginBottom: 12,
              borderRadius: 10,
              border: '1px solid #2a3544',
              background: '#0a0e14',
              color: '#e8e4dc',
              fontSize: 15,
            }}
          />
          <button
            type="submit"
            disabled={!connected}
            style={{
              width: '100%',
              padding: '14px',
              borderRadius: 10,
              border: 'none',
              background: !connected ? '#3a4a55' : '#2a6cb0',
              color: '#fff',
              fontWeight: 700,
              fontSize: 15,
              cursor: !connected ? 'wait' : 'pointer',
            }}
          >
            Join lobby
          </button>
        </form>
      </div>
    )
  }

  if (screen === 'lobby') {
    const typeLabel = {
      NLHE: "NL Hold'em",
      PLO4: 'PLO (4)',
      PLO5: 'PLO (5)',
      PLO6: 'PLO (6)',
    }
    return (
      <div
        style={{
          minHeight: '100vh',
          background: 'radial-gradient(ellipse at center,#121820 0%,#07090e 70%)',
          padding: 24,
          color: '#e8eef8',
        }}
      >
        {joinPwdModal && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.65)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 50,
            }}
          >
            <form
              onSubmit={submitJoinPwd}
              style={{
                width: 360,
                padding: 28,
                borderRadius: 16,
                background: '#11151c',
                border: '1px solid #2a3544',
              }}
            >
              <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>Private table</h2>
              <p style={{ margin: '0 0 16px', fontSize: 13, color: '#7a8a9a' }}>
                Enter password for <strong>{joinPwdModal.name}</strong>
              </p>
              <input
                type="password"
                autoFocus
                value={joinPwdInput}
                onChange={e => setJoinPwdInput(e.target.value)}
                placeholder="Table password"
                style={{
                  width: '100%',
                  padding: '12px 14px',
                  marginBottom: 16,
                  borderRadius: 10,
                  border: '1px solid #2a3544',
                  background: '#0a0e14',
                  color: '#e8e4dc',
                }}
              />
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  onClick={() => setJoinPwdModal(null)}
                  style={{ flex: 1, padding: 12, borderRadius: 10, border: '1px solid #3a4a55', background: 'transparent', color: '#9aa8b8' }}
                >
                  Cancel
                </button>
                <button type="submit" style={{ flex: 1, padding: 12, borderRadius: 10, border: 'none', background: '#2a6cb0', color: '#fff', fontWeight: 700 }}>
                  Join
                </button>
              </div>
            </form>
          </div>
        )}

        {showCreate && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.65)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 50,
              overflow: 'auto',
              padding: 20,
            }}
          >
            <form
              onSubmit={submitCreateTable}
              style={{
                width: 'min(420px, 100%)',
                padding: 28,
                borderRadius: 16,
                background: '#11151c',
                border: '1px solid #2a3544',
              }}
            >
              <h2 style={{ margin: '0 0 20px', fontSize: 20, color: '#6eb5ff' }}>Create table</h2>
              <label style={{ display: 'block', fontSize: 11, color: '#6a7a8a', marginBottom: 4 }}>Table name</label>
              <input
                value={createName}
                onChange={e => setCreateName(e.target.value)}
                required
                style={{
                  width: '100%',
                  padding: 10,
                  marginBottom: 14,
                  borderRadius: 10,
                  border: '1px solid #2a3544',
                  background: '#0a0e14',
                  color: '#e8e4dc',
                }}
              />
              <label style={{ display: 'block', fontSize: 11, color: '#6a7a8a', marginBottom: 4 }}>Game type</label>
              <select
                value={createGameType}
                onChange={e => setCreateGameType(e.target.value)}
                style={{
                  width: '100%',
                  padding: 10,
                  marginBottom: 14,
                  borderRadius: 10,
                  border: '1px solid #2a3544',
                  background: '#0a0e14',
                  color: '#cde4ff',
                }}
              >
                <option value="NLHE">NL Hold&apos;em</option>
                <option value="PLO4">PLO (4 cards)</option>
                <option value="PLO5">PLO (5 cards)</option>
                <option value="PLO6">PLO (6 cards)</option>
              </select>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 11, color: '#6a7a8a', marginBottom: 4 }}>Small blind</label>
                  <input
                    type="number"
                    min={1}
                    value={createSb}
                    onChange={e => setCreateSb(e.target.value)}
                    required
                    style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #2a3544', background: '#0a0e14', color: '#e8e4dc' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 11, color: '#6a7a8a', marginBottom: 4 }}>Big blind</label>
                  <input
                    type="number"
                    min={1}
                    value={createBb}
                    onChange={e => setCreateBb(e.target.value)}
                    required
                    style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #2a3544', background: '#0a0e14', color: '#e8e4dc' }}
                  />
                </div>
              </div>
              <label style={{ display: 'block', fontSize: 11, color: '#6a7a8a', marginBottom: 4 }}>Max players</label>
              <select
                value={createMax}
                onChange={e => setCreateMax(+e.target.value)}
                style={{
                  width: '100%',
                  padding: 10,
                  marginBottom: 14,
                  borderRadius: 10,
                  border: '1px solid #2a3544',
                  background: '#0a0e14',
                  color: '#cde4ff',
                }}
              >
                {MAX_PLAYER_OPTIONS.map(m => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <label style={{ display: 'block', fontSize: 11, color: '#6a7a8a', marginBottom: 4 }}>Password (optional)</label>
              <input
                type="password"
                value={createPwd}
                onChange={e => setCreatePwd(e.target.value)}
                placeholder="Private table"
                style={{
                  width: '100%',
                  padding: 10,
                  marginBottom: 20,
                  borderRadius: 10,
                  border: '1px solid #2a3544',
                  background: '#0a0e14',
                  color: '#e8e4dc',
                }}
              />
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  style={{ flex: 1, padding: 12, borderRadius: 10, border: '1px solid #3a4a55', background: 'transparent', color: '#9aa8b8' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={joiningTable}
                  style={{
                    flex: 1,
                    padding: 12,
                    borderRadius: 10,
                    border: 'none',
                    background: joiningTable ? '#3a4a55' : '#2a6cb0',
                    color: '#fff',
                    fontWeight: 700,
                  }}
                >
                  Create table
                </button>
              </div>
            </form>
          </div>
        )}

        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h1 style={{ margin: 0, fontSize: 26, letterSpacing: 3, color: '#6eb5ff' }}>
                FELT<span style={{ color: '#5a6a7a', fontWeight: 400 }}>CLUB</span>
              </h1>
              <p style={{ margin: '6px 0 0', fontSize: 13, color: '#6a7a8a' }}>
                Signed in as <strong style={{ color: '#cde4ff' }}>{myName}</strong>
              </p>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 8,
                  fontSize: 12,
                  color: '#7a8a9a',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: connected ? '#4caf50' : '#e53935',
                  }}
                />
                <span>{connected ? 'Connected' : 'Disconnected'}</span>
              </div>
              <div style={{ fontSize: 13, color: '#8ab8e8', marginTop: 4 }}>Online: {onlineCount}</div>
            </div>
          </div>

          {myName.trim() === SUPER_ADMIN_NAME && showSuperPinField && (
            <input
              type="password"
              autoComplete="off"
              value={savedSuperPin}
              onChange={e => setSavedSuperPin(e.target.value)}
              placeholder="PIN"
              style={{
                width: '100%',
                maxWidth: 360,
                padding: '12px 14px',
                marginBottom: 16,
                borderRadius: 10,
                border: '1px solid #3a4a60',
                background: '#0a0e14',
                color: '#e8e4dc',
                fontSize: 15,
                display: 'block',
              }}
            />
          )}

          <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
            {isLobbyHost ? (
              <button
                type="button"
                onClick={() => {
                  setCreateName(`${myName}'s table`)
                  setShowCreate(true)
                }}
                style={{
                  padding: '12px 20px',
                  borderRadius: 10,
                  border: 'none',
                  background: '#2a6cb0',
                  color: '#fff',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Create table
              </button>
            ) : (
              <div
                style={{
                  padding: '12px 16px',
                  borderRadius: 10,
                  border: '1px solid #2a3544',
                  background: '#0f141c',
                  color: '#7a8a9a',
                  fontSize: 13,
                  maxWidth: 360,
                  lineHeight: 1.45,
                }}
              >
                Only the first player in the lobby can create a table. If they leave or open a table, you become
                host next.
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                setNameInput(myName)
                setSavedSuperPin('')
                setShowSuperPinField(false)
                setScreen('login')
              }}
              style={{
                padding: '12px 20px',
                borderRadius: 10,
                border: '1px solid #3a4a55',
                background: 'transparent',
                color: '#9aa8b8',
                cursor: 'pointer',
              }}
            >
              Change name
            </button>
          </div>

          {error && (
            <div style={{ marginBottom: 16, padding: 10, background: '#301818', border: '1px solid #5a2020', color: '#f0a0a0', fontSize: 13 }}>
              {error}
            </div>
          )}

          <div style={{ fontSize: 12, color: '#5a6a7a', marginBottom: 10 }}>Active tables</div>
          {tables.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#5a6a7a', border: '1px dashed #2a3544', borderRadius: 12 }}>
              {isLobbyHost ? 'No tables yet. Create one to start.' : 'No tables yet. Wait for the lobby host to create one.'}
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {tables.map(row => (
                <li
                  key={row.tableId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '14px 16px',
                    borderRadius: 12,
                    background: '#11151c',
                    border: '1px solid #2a3544',
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 700, color: '#e8eef8', marginBottom: 4 }}>{row.name}</div>
                    <div style={{ fontSize: 12, color: '#7a8a9a' }}>
                      {typeLabel[row.gameType] || row.gameType} · ${row.smallBlind}/${row.bigBlind} · {row.playersSeated}/{row.maxSeats}{' '}
                      seated
                      {row.hasPassword ? ' · private' : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={joiningTable || row.playersSeated >= row.maxSeats}
                    onClick={() => openJoinTable(row)}
                    style={{
                      padding: '10px 18px',
                      borderRadius: 10,
                      border: 'none',
                      background: joiningTable || row.playersSeated >= row.maxSeats ? '#3a4a55' : '#1e5a8a',
                      color: '#fff',
                      fontWeight: 700,
                      cursor: joiningTable || row.playersSeated >= row.maxSeats ? 'not-allowed' : 'pointer',
                    }}
                  >
                    Join
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: '#07090e' }}>
      {/* Top bar */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '10px 16px',
          borderBottom: '1px solid #1a2230',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={backToLobby}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: '1px solid #3a5a78',
              background: '#0f1824',
              color: '#8bc4ff',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            ← Lobby
          </button>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 20, fontWeight: 800, color: '#6eb5ff', letterSpacing: 2 }}>FELTCLUB</span>
            <span style={{ fontSize: 12, color: '#7a8a9a' }}>
              {tableName || 'Table'} · {gameType} · ${smallBlind}/${bigBlind}
            </span>
          </div>
          {isHost && (
            <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 8, background: '#1a3050', color: '#8bc4ff' }}>
              HOST
            </span>
          )}
          {isSuper && (
            <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 8, background: '#2a2040', color: '#c9a8ff' }}>
              SUPER ADMIN
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {isSuper && game && game.phase !== 'idle' && (
            <button
              type="button"
              onClick={() => hostReveal(!game.showAllCards)}
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                border: '1px solid #4a6080',
                background: '#152030',
                color: '#cde4ff',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {game.showAllCards ? 'Hide cards' : 'Reveal cards'}
            </button>
          )}
          {isHost && (!game || game.phase === 'idle') && (
            <>
              <button type="button" onClick={hostDeal} style={hostMiniBtn}>
                Deal
              </button>
              <button type="button" onClick={hostNextHand} style={hostMiniBtn}>
                Next hand
              </button>
            </>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#7a8a9a', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={fourColor}
              onChange={e => {
                const on = e.target.checked
                setFourColor(on)
                try {
                  localStorage.setItem(FOUR_COLOR_STORAGE_KEY, on ? '1' : '0')
                } catch {
                  /* ignore */
                }
              }}
            />
            4-colour deck
          </label>
          {isHost && (!game || game.phase === 'idle') && (
            <select
              value={gameType}
              onChange={e => changeGameType(e.target.value)}
              style={{
                padding: '6px 10px',
                borderRadius: 8,
                border: '1px solid #2a4058',
                background: '#0a1018',
                color: '#cde4ff',
                fontSize: 13,
              }}
            >
              {gameTypes.map(gt => (
                <option key={gt} value={gt}>
                  {gt}
                </option>
              ))}
            </select>
          )}
        </div>
      </header>

      {error && (
        <div style={{ margin: '0 16px', padding: 10, background: '#301818', border: '1px solid #5a2020', color: '#f0a0a0', fontSize: 13 }}>
          {error}
        </div>
      )}

      {game?.phase === 'idle' && autoSecs != null && autoSecs > 0 && (
        <div style={{ margin: '8px 16px', padding: 10, background: '#0f1822', border: '1px solid #2a4058', fontSize: 13, color: '#8ab8e8' }}>
          Next hand in <strong>{autoSecs}s</strong> (auto)
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0, padding: 12, gap: 12 }}>
        {/* Table + log */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <div
            style={{
              flex: 1,
              minHeight: Math.max(520, Math.min(720, Math.round(vw * 1.15))),
              position: 'relative',
              borderRadius: 20,
              overflow: 'auto',
              background: 'radial-gradient(ellipse 55% 42% at 50% 48%, #1e4a7a 0%, #153a62 35%, #0f2848 100%)',
              border: '3px solid #2a5080',
              boxShadow: 'inset 0 0 80px rgba(0,40,80,0.35), 0 12px 40px rgba(0,0,0,0.45)',
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: '42%',
                transform: 'translate(-50%,-50%)',
                textAlign: 'center',
                zIndex: 1,
              }}
            >
              <div style={{ fontSize: 16, color: '#8ab8e8', letterSpacing: 2, marginBottom: 12 }}>
                {(game && PHASE_LABELS[game.phase]) || 'WAITING'}
              </div>
              <div
                style={{
                  width: boardRowW * boardScale,
                  height: boardRowH * boardScale,
                  margin: '0 auto 12px',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'flex-start',
                  maxWidth: '100%',
                }}
              >
                <div style={{ transform: `scale(${boardScale})`, transformOrigin: 'top center' }}>
                  <div
                    style={{
                      display: 'flex',
                      gap: BOARD_CARD_GAP,
                      flexWrap: 'wrap',
                      justifyContent: 'center',
                      width: boardRowW,
                    }}
                  >
                    {[0, 1, 2, 3, 4].map(i => (
                      <Card
                        key={i}
                        variant="board"
                        card={game?.community?.[i]}
                        fourColor={fourColor}
                        back={!game?.community?.[i]}
                      />
                    ))}
                  </div>
                </div>
              </div>
              <div
                style={{
                  display: 'inline-block',
                  padding: '10px 22px',
                  borderRadius: 24,
                  background: 'rgba(0,0,0,0.45)',
                  border: '2px solid #3a6a9a',
                  color: '#b8d8ff',
                  fontWeight: 700,
                  fontSize: 20,
                }}
              >
                Pot ${game?.pot ?? 0}
              </div>
            </div>

            {seatSlots.map((slot, i) => {
              const occIdx = slot ? occupiedSorted.findIndex(p => p.seat === i) : -1
              const pos = slot
                ? seatPosition(occIdx >= 0 ? occIdx : 0, occupiedCount, 44, 46)
                : seatPosition(i, tableSeats, 40, 42)
              const gp = slot ? mergedGamePlayers(slot.socketId) : null
              const active = gp && game?.players?.[game.currentPlayer]?.socketId === slot?.socketId
              const winner = gp && game?.winners?.includes(slot.socketId)
              const cards = slot ? cardsForSeat(slot) : null
              const showCards =
                cards &&
                cards.length > 0 &&
                cards.some(c => c !== null && typeof c === 'object' && c.r)

              return (
                <div
                  key={slot ? slot.socketId : `empty-${i}`}
                  style={{
                    position: 'absolute',
                    ...pos,
                    width: 'max-content',
                    maxWidth: 'min(92vw, 360px)',
                    zIndex: slot ? 3 : 2,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 12,
                    overflow: 'hidden',
                    boxSizing: 'border-box',
                  }}
                >
                  <div
                    style={{
                      width: slot ? holeRowW * holeScale : undefined,
                      minHeight: slot ? holeRowH * holeScale : undefined,
                      maxWidth: '100%',
                      display: 'flex',
                      justifyContent: 'center',
                      alignItems: 'flex-start',
                    }}
                  >
                    <div
                      style={
                        slot
                          ? { transform: `scale(${holeScale})`, transformOrigin: 'top center' }
                          : undefined
                      }
                    >
                      <div
                        style={{
                          display: 'flex',
                          gap: HOLE_CARD_GAP,
                          flexWrap: 'wrap',
                          justifyContent: 'center',
                          maxWidth: holeRowW,
                        }}
                      >
                    {!slot ? (
                      <span style={{ fontSize: 18, color: '#3a5a78' }}>Empty</span>
                    ) : showCards ? (
                      cards.map((c, j) => (
                        <Card
                          key={j}
                          variant="hole"
                          card={c}
                          fourColor={fourColor}
                          back={!c || !c.r}
                        />
                      ))
                    ) : cards ? (
                      cards.map((_, j) => (
                        <Card key={j} variant="hole" back fourColor={fourColor} />
                      ))
                    ) : (
                      <span style={{ fontSize: 18, color: '#5a7a9a' }}>—</span>
                    )}
                      </div>
                    </div>
                  </div>
                  {slot && (
                    <div
                      style={{
                        padding: '10px 16px',
                        borderRadius: 12,
                        background: winner ? 'rgba(40,80,40,0.85)' : active ? 'rgba(40,60,90,0.9)' : 'rgba(0,0,0,0.5)',
                        border: `2px solid ${winner ? '#5a8a5a' : active ? '#6eb5ff' : '#2a4058'}`,
                        fontSize: 20,
                        maxWidth: 'min(96vw, 1200px)',
                        textAlign: 'center',
                        color: '#e8eef8',
                      }}
                    >
                      <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {slot.name}
                        {slot.socketId === sid ? ' · you' : ''}
                      </div>
                      <div style={{ fontSize: 17, color: '#9ab8d8', fontVariantNumeric: 'tabular-nums' }}>
                        {slot.unlimitedChips ? '∞' : `$${slot.stack ?? 0}`}
                      </div>
                      {gp?.handLabel && (
                        <div style={{ fontSize: 15, color: '#a8d8a8' }}>{gp.handLabel}</div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Actions */}
          {myTurn && raiseBounds && (
            <div
              style={{
                padding: 12,
                background: '#101820',
                borderRadius: 12,
                border: '1px solid #2a4058',
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <span style={{ fontSize: 12, color: '#8ab8e8' }}>
                Your turn · <strong style={{ color: actSecsLeft <= 5 ? '#ff8a80' : '#b8d8ff' }}>{actSecsLeft}s</strong>
              </span>
              <button type="button" onClick={() => doAction('fold')} style={btnFold}>
                Fold
              </button>
              {raiseBounds.toCall === 0 ? (
                <button type="button" onClick={() => doAction('check')} style={btnOk}>
                  Check
                </button>
              ) : (
                <button type="button" onClick={() => doAction('call')} style={btnOk}>
                  Call ${raiseBounds.toCall}
                </button>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#8a9aaa' }}>
                Raise to
                <input
                  type="range"
                  min={raiseBounds.minRaiseTo}
                  max={raiseBounds.maxRaiseTo}
                  value={Math.min(raiseTo, raiseBounds.maxRaiseTo)}
                  onChange={e => setRaiseTo(+e.target.value)}
                />
                <span style={{ minWidth: 48, fontVariantNumeric: 'tabular-nums' }}>${raiseTo}</span>
              </label>
              <button type="button" onClick={doRaise} style={btnRaise}>
                Raise
              </button>
            </div>
          )}

          {/* Hand log */}
          <div
            ref={logRef}
            style={{
              height: 120,
              overflowY: 'auto',
              padding: 10,
              background: '#0a0e14',
              borderRadius: 10,
              border: '1px solid #1a2430',
              fontSize: 11,
              fontFamily: 'ui-monospace, monospace',
              color: '#7a8a9a',
            }}
          >
            {(game?.log || []).map((line, i) => (
              <div key={i} style={{ color: line.startsWith('──') ? '#5a8ab0' : '#6a7a8a' }}>
                {line}
              </div>
            ))}
            {!game?.log?.length && <div style={{ color: '#3a4a55' }}>Hand history appears here.</div>}
          </div>
        </div>

        {/* Sidebar */}
        <aside
          style={{
            width: 300,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            minHeight: 0,
            maxHeight: '100%',
          }}
        >
          {roomPlayers.length < 2 && !game && (
            <div style={{ padding: 12, background: '#101820', borderRadius: 10, border: '1px solid #1a2838', fontSize: 12, color: '#6a7a8a' }}>
              Invite players:{' '}
              <span style={{ color: '#6eb5ff', wordBreak: 'break-all' }}>{shareUrl}</span>
            </div>
          )}

          {isHost && (
            <div style={{ padding: 12, background: '#101820', borderRadius: 10, border: '1px solid #2a5080' }}>
              <div style={{ fontSize: 10, color: '#6a8aaa', textTransform: 'uppercase', marginBottom: 4 }}>Host bank</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#8bc4ff', fontVariantNumeric: 'tabular-nums' }}>
                ${hostBank.toLocaleString()}
              </div>
              <p style={{ margin: '8px 0', fontSize: 11, color: '#5a6a7a', lineHeight: 1.4 }}>
                Assign chips before play. You play with <strong>∞</strong> on the table.
              </p>
              <input
                type="number"
                placeholder="Amount"
                value={hostAssignAmt}
                onChange={e => setHostAssignAmt(e.target.value)}
                style={{
                  width: '100%',
                  padding: 8,
                  marginBottom: 8,
                  borderRadius: 8,
                  border: '1px solid #2a4058',
                  background: '#0a1018',
                  color: '#e8eef8',
                }}
              />
              <button
                type="button"
                onClick={() => assignChips(sid, 1)}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  marginBottom: 0,
                  borderRadius: 8,
                  border: '1px solid #3a6a9a',
                  background: 'rgba(40,90,130,0.35)',
                  color: '#b8d8ff',
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                Add to my stack
              </button>
            </div>
          )}

          <div style={{ flex: 1, minHeight: 140, padding: 10, background: '#101820', borderRadius: 10, border: '1px solid #1a2838', display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 11, color: '#5a6a7a', marginBottom: 8 }}>CHAT</div>
            <div style={{ flex: 1, overflowY: 'auto', fontSize: 12, marginBottom: 8 }}>
              {chat.map((m, i) => (
                <div key={i} style={{ marginBottom: 6 }}>
                  <span style={{ color: '#6eb5ff' }}>{m.from}:</span> <span style={{ color: '#9aa8b8' }}>{m.text}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendChat()}
                placeholder="Message…"
                style={{
                  flex: 1,
                  padding: 8,
                  borderRadius: 8,
                  border: '1px solid #2a3544',
                  background: '#0a0e14',
                  color: '#e8e4dc',
                  fontSize: 13,
                }}
              />
              <button type="button" onClick={sendChat} style={{ ...btnOk, padding: '8px 12px' }}>
                Send
              </button>
            </div>
          </div>

          <div
            style={{
              padding: 10,
              background: '#101820',
              borderRadius: 10,
              border: '1px solid #1a2838',
              flex: 1,
              minHeight: 120,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div style={{ fontSize: 11, color: '#5a6a7a', marginBottom: 8 }}>
              PLAYERS ({roomPlayers.length})
            </div>
            <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
            {[...roomPlayers].sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0)).map(p => (
              <div
                key={p.socketId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '8px 0',
                  borderBottom: '1px solid #1a2430',
                  fontSize: 12,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: p.online ? '#4caf50' : '#444',
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', color: p.socketId === sid ? '#8bc4ff' : '#c8d4e0' }}>
                    <span style={{ color: '#5a6a7a', fontSize: 10, marginRight: 4 }}>#{typeof p.seat === 'number' ? p.seat + 1 : '?'}</span>
                    {p.name}
                    {p.isHost ? ' · host' : ''}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                  <span style={{ fontVariantNumeric: 'tabular-nums', color: '#7a8a9a' }}>
                    {p.unlimitedChips ? '∞' : `$${p.stack ?? 0}`}
                  </span>
                  {isHost && p.socketId !== sid && (
                    <>
                      <button type="button" onClick={() => assignChips(p.socketId, 1)} style={miniBtn}>
                        +
                      </button>
                      <button type="button" onClick={() => assignChips(p.socketId, -1)} style={miniBtn}>
                        −
                      </button>
                      <button type="button" onClick={() => kick(p.socketId)} style={miniKick}>
                        Kick
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
            </div>
          </div>

          <div style={{ padding: 10, background: '#101820', borderRadius: 10, border: '1px solid #1a2838' }}>
            <div style={{ fontSize: 11, color: '#5a6a7a', marginBottom: 8 }}>SCOREBOARD</div>
            {Object.keys(stats).length === 0 ? (
              <div style={{ fontSize: 12, color: '#4a5560' }}>Stats after hands play.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 24px 24px 40px', gap: 4, fontSize: 11 }}>
                <span style={{ color: '#4a5560' }}>Player</span>
                <span style={{ color: '#4a5560', textAlign: 'center' }}>W</span>
                <span style={{ color: '#4a5560', textAlign: 'center' }}>L</span>
                <span style={{ color: '#4a5560', textAlign: 'right' }}>Net</span>
                {Object.entries(stats)
                  .sort((a, b) => (b[1].netChips || 0) - (a[1].netChips || 0))
                  .map(([k, s]) => (
                    <div key={k} style={{ display: 'contents', fontSize: 12 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{k}</span>
                      <span style={{ textAlign: 'center', color: '#6abf69' }}>{s.wins}</span>
                      <span style={{ textAlign: 'center', color: '#e57373' }}>{s.losses}</span>
                      <span
                        style={{
                          textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums',
                          color: (s.netChips || 0) >= 0 ? '#8bc4a8' : '#e0a0a0',
                        }}
                      >
                        {(s.netChips || 0) > 0 ? '+' : ''}
                        {s.netChips}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

const btnFold = {
  padding: '8px 16px',
  borderRadius: 8,
  border: '1px solid #6a3030',
  background: 'transparent',
  color: '#e57373',
  cursor: 'pointer',
  fontSize: 13,
}
const btnOk = {
  padding: '8px 16px',
  borderRadius: 8,
  border: '1px solid #2a6080',
  background: 'rgba(40,90,130,0.4)',
  color: '#b8d8ff',
  cursor: 'pointer',
  fontSize: 13,
}
const btnRaise = {
  padding: '8px 16px',
  borderRadius: 8,
  border: 'none',
  background: '#2a6cb0',
  color: '#fff',
  fontWeight: 700,
  cursor: 'pointer',
  fontSize: 13,
}
const miniBtn = {
  padding: '2px 8px',
  fontSize: 11,
  borderRadius: 6,
  border: '1px solid #3a5a78',
  background: '#1a2838',
  color: '#8bc4ff',
  cursor: 'pointer',
}
const miniKick = {
  padding: '2px 6px',
  fontSize: 10,
  borderRadius: 6,
  border: '1px solid #5a3030',
  background: 'transparent',
  color: '#e08080',
  cursor: 'pointer',
}
const hostMiniBtn = {
  padding: '6px 12px',
  borderRadius: 8,
  border: '1px solid #2a6080',
  background: 'rgba(40,90,130,0.35)',
  color: '#b8d8ff',
  fontSize: 12,
  cursor: 'pointer',
}
