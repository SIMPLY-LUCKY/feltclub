import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import socket from './socket'

const SUPER_ADMIN_NAME = 'SIMPLY.LUCKY'
const MAX_PLAYER_OPTIONS = [2, 4, 6, 9]
const MAX_TABLE_OBSERVERS = 32

function joinTableDisabled(row, joiningTable) {
  const atTable = row.playersAtTable ?? row.playersSeated
  if (joiningTable) return true
  if (row.seatAssignment === 'choose') return atTable >= row.maxSeats + MAX_TABLE_OBSERVERS
  return row.playersSeated >= row.maxSeats
}

/** Board (community) and hole card layouts in CSS px at scale 1. */
const CARD_LAYOUT = {
  board: { w: 80, h: 112, rank: 30, suit: 24, radius: 10 },
  hole: { w: 64, h: 90, rank: 24, suit: 20, radius: 8 },
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

const FOUR_COLOR_STORAGE_KEY = 'xingwangfa-fourColorDeck'

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
const SUIT_COLORS_CLASSIC = { h: '#e01010', d: '#e01010', c: '#0a0a0a', s: '#0a0a0a' }
const SUIT_COLORS_FOUR = { h: '#e01010', d: '#1565c0', c: '#1b5e20', s: '#0a0a0a' }

const suitSym = { h: '♥', d: '♦', c: '♣', s: '♠' }

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
            radial-gradient(circle at 28% 32%, rgba(212,175,55,0.22) 0%, transparent 42%),
            radial-gradient(circle at 72% 68%, rgba(212,175,55,0.18) 0%, transparent 38%),
            repeating-linear-gradient(
              52deg,
              #1a2336 0px,
              #1a2336 5px,
              #243049 5px,
              #243049 10px
            )
          `,
          border: '2px solid #2a3548',
          boxShadow: 'inset 0 0 0 1px rgba(212,175,55,0.25), 0 2px 10px rgba(0,0,0,0.5)',
        }}
      />
    )
  }
  const fc = fourColor ? SUIT_COLORS_FOUR : SUIT_COLORS_CLASSIC
  const col = fc[card.s] || '#ccc'
  const rnk = rankStr(card.r)
  const sym = suitSym[card.s] ?? '?'
  const isBoard = variant === 'board'
  const shadow = isBoard ? '0 4px 12px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.4)'
  const corner = (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        lineHeight: 1,
        color: col,
      }}
    >
      <span
        style={{
          fontSize: L.rank,
          fontWeight: 900,
          letterSpacing: isBoard ? 0 : -1,
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        }}
      >
        {rnk}
      </span>
      <span style={{ fontSize: L.suit, fontWeight: 900, marginTop: 1 }}>{sym}</span>
    </div>
  )
  return (
    <div
      style={{
        width: w,
        height: h,
        borderRadius: br,
        boxSizing: 'border-box',
        background: '#ffffff',
        border: '2px solid #e0e0e0',
        boxShadow: shadow,
        flexShrink: 0,
        userSelect: 'none',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div style={{ position: 'absolute', left: 5, top: 4 }}>{corner}</div>
      <div style={{ position: 'absolute', right: 5, bottom: 4, transform: 'rotate(180deg)' }}>{corner}</div>
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

/** Ellipse seat anchor: i = 0 is top-center, proceeds clockwise (professional TV table layout). */
function seatPosition(i, n, rxPct, ryPct) {
  const a = (Math.PI * 2 * i) / n - Math.PI / 2
  return {
    left: `calc(50% + ${Math.cos(a) * rxPct}%)`,
    top: `calc(50% + ${Math.sin(a) * ryPct}%)`,
    transform: 'translate(-50%, -50%)',
  }
}

function usdToBB(usd, bb) {
  if (!bb || bb <= 0 || usd == null || !Number.isFinite(Number(usd))) return 0
  return Number(usd) / bb
}

function formatBBAmount(usd, bb) {
  const v = usdToBB(usd, bb)
  if (!Number.isFinite(v)) return '—'
  if (v >= 100) return `${Math.round(v)} BB`
  if (v >= 10) return `${v.toFixed(1)} BB`
  return `${v.toFixed(2)} BB`
}

function playerInitials(name) {
  const t = String(name || '?').trim()
  if (!t) return '?'
  const parts = t.split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return t.slice(0, 2).toUpperCase()
}

/** Small chip icon by street bet size (visual tier). */
function BetChipIcon({ streetBet, bb }) {
  const bbs = usdToBB(streetBet, bb)
  let fill = '#c62828'
  if (bbs >= 20) fill = '#1565c0'
  else if (bbs >= 10) fill = '#2e7d32'
  else if (bbs >= 3) fill = '#f9a825'
  else if (bbs <= 0) fill = 'transparent'
  if (bbs <= 0) return null
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 11,
        height: 11,
        borderRadius: '50%',
        background: `linear-gradient(145deg, ${fill}, ${fill}cc)`,
        border: '1px solid rgba(255,255,255,0.35)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
        verticalAlign: 'middle',
        marginRight: 4,
      }}
    />
  )
}

/** Decorative stack near main pot. */
function PotChipDecor() {
  const chips = ['#c62828', '#1565c0', '#f9a825', '#2e7d32']
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 0, height: 22, marginTop: 6 }}>
      {chips.map((c, i) => (
        <span
          key={i}
          style={{
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: `linear-gradient(145deg, ${c}, ${c}99)`,
            border: '1px solid rgba(255,255,255,0.25)',
            marginLeft: i > 0 ? -8 : 0,
            boxShadow: '0 2px 4px rgba(0,0,0,0.4)',
            zIndex: i,
          }}
        />
      ))}
    </div>
  )
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
  const [createSeatAssignment, setCreateSeatAssignment] = useState('random')
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
  const [seatAssignment, setSeatAssignment] = useState('random')
  const [chat, setChat] = useState([])
  const [stats, setStats] = useState({})
  const [turnSec, setTurnSec] = useState(15)
  const [autoDealAt, setAutoDealAt] = useState(null)
  /** From `next_hand_countdown` (and room_update when joining mid-timer). */
  const [nextHandSeconds, setNextHandSeconds] = useState(null)
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
  const tableIdRef = useRef(null)
  const prevAutoDealAtRef = useRef(null)
  const joinPending = useRef(false)
  /** Server is source of truth; ignore all_hole_cards unless this is true. */
  const isSuperAdminRef = useRef(false)

  const vw = useViewportWidth()

  const boardScale = useMemo(() => {
    const budget = Math.max(500, Math.min(vw * 0.58, 680))
    return rowFitScale(5, CARD_LAYOUT.board.w, BOARD_CARD_GAP, budget)
  }, [vw])

  const holeScale = useMemo(() => {
    const n = VARIANT_HOLES[game?.variant ?? gameType] ?? 6
    const budget =
      vw < 640 ? Math.max(220, vw - 28) : Math.min(520, Math.floor(vw * 0.42))
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
    tableIdRef.current = tableId
  }, [tableId])

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
      setSeatAssignment(payload.seatAssignment === 'choose' ? 'choose' : 'random')
      setChat(payload.chat || [])
      setStats(payload.stats || {})
      if (typeof payload.turnActionSeconds === 'number') setTurnSec(payload.turnActionSeconds)
      if (typeof payload.autoDealAt === 'number') {
        setAutoDealAt(payload.autoDealAt)
        const g0 = payload.game
        const waitingNext = !g0 || g0.phase === 'idle' || g0.phase === 'showdown'
        if (!waitingNext) {
          setNextHandSeconds(null)
        } else if (payload.autoDealAt !== prevAutoDealAtRef.current) {
          const s = Math.max(0, Math.ceil((payload.autoDealAt - Date.now()) / 1000))
          setNextHandSeconds(s > 0 ? s : null)
          prevAutoDealAtRef.current = payload.autoDealAt
        }
      } else {
        setAutoDealAt(null)
        setNextHandSeconds(null)
        prevAutoDealAtRef.current = null
      }
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
      setNextHandSeconds(null)
      prevAutoDealAtRef.current = null
    }
    const onBounds = b => {
      if (b && typeof b === 'object') setRaiseBounds(b)
    }
    const onNextHandCountdown = ({ tableId: tid, secondsRemaining }) => {
      if (tid !== tableIdRef.current) return
      setNextHandSeconds(secondsRemaining > 0 ? secondsRemaining : null)
    }
    socket.on('room_update', onRoom)
    socket.on('your_hole_cards', onYour)
    socket.on('all_hole_cards', onAll)
    socket.on('error_msg', onErr)
    socket.on('kicked', onKicked)
    socket.on('raise_bounds', onBounds)
    socket.on('next_hand_countdown', onNextHandCountdown)
    const onSeatTaken = msg => {
      const m = typeof msg === 'object' && msg?.message ? msg.message : String(msg ?? 'Seat taken.')
      setError(m)
      setTimeout(() => setError(''), 4000)
    }
    socket.on('seat_taken', onSeatTaken)
    return () => {
      socket.off('room_update', onRoom)
      socket.off('your_hole_cards', onYour)
      socket.off('all_hole_cards', onAll)
      socket.off('error_msg', onErr)
      socket.off('kicked', onKicked)
      socket.off('raise_bounds', onBounds)
      socket.off('next_hand_countdown', onNextHandCountdown)
      socket.off('seat_taken', onSeatTaken)
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
      seatAssignment: createSeatAssignment,
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

  const chooseSeat = useCallback(
    seatIdx => {
      if (!tableId) return
      socket.emit('choose_seat', { tableId, seat: seatIdx })
    },
    [tableId],
  )

  const shareUrl = typeof window !== 'undefined' ? window.location.origin : ''

  const actSecsLeft = useMemo(() => {
    if (!game?.turnDeadline) return null
    return Math.max(0, Math.ceil((game.turnDeadline - now) / 1000))
  }, [game?.turnDeadline, now])

  /** Seated players in seat order (physical seat index maps to position on the oval). */
  const orderedSeats = useMemo(() => {
    return roomPlayers
      .filter(p => p.seated !== false)
      .sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0))
  }, [roomPlayers])

  const dealerSeatIndex = useMemo(() => {
    if (!game || game.dealer == null || game.dealer < 0) return null
    const dp = game.players?.[game.dealer]
    if (!dp) return null
    const rp = roomPlayers.find(p => p.socketId === dp.socketId && p.seated !== false)
    return typeof rp?.seat === 'number' ? rp.seat : null
  }, [game, roomPlayers])

  const potOddsLine = useMemo(() => {
    if (!game || !raiseBounds || raiseBounds.toCall <= 0) return null
    const pot = game.pot
    const c = raiseBounds.toCall
    const r = pot / c
    const pct = (100 * c) / (pot + c)
    return `Pot odds ${r.toFixed(2)} : 1 · need ~${pct.toFixed(1)}% equity`
  }, [game, raiseBounds])

  const showSidePotHint = useMemo(() => {
    if (!game?.players?.length) return false
    return game.players.filter(p => p.allIn).length >= 2
  }, [game?.players])

  const needsChooseSeat = seatAssignment === 'choose' && me && me.seated === false

  const betweenHands = !game || game.phase === 'idle' || game.phase === 'showdown'

  const nextHandShowSec = useMemo(() => {
    if (!betweenHands) return null
    if (nextHandSeconds != null && nextHandSeconds > 0) return nextHandSeconds
    if (autoDealAt == null) return null
    const v = Math.max(0, Math.ceil((autoDealAt - now) / 1000))
    return v > 0 ? v : null
  }, [betweenHands, autoDealAt, now, nextHandSeconds])

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
          <h1 style={{ margin: '0 0 8px', fontSize: 28, letterSpacing: 2, color: '#6eb5ff' }}>
            兴旺发<span style={{ color: '#5a6a7a', fontWeight: 400 }}>传奇牌手</span>
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
              <label style={{ display: 'block', fontSize: 11, color: '#6a7a8a', marginBottom: 8 }}>Seat assignment</label>
              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                <button
                  type="button"
                  onClick={() => setCreateSeatAssignment('random')}
                  style={{
                    flex: 1,
                    padding: '10px 12px',
                    borderRadius: 10,
                    border: createSeatAssignment === 'random' ? '2px solid #6eb5ff' : '1px solid #2a3544',
                    background: createSeatAssignment === 'random' ? 'rgba(40,90,140,0.35)' : '#0a0e14',
                    color: createSeatAssignment === 'random' ? '#cde4ff' : '#7a8a9a',
                    fontWeight: createSeatAssignment === 'random' ? 700 : 500,
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Random
                </button>
                <button
                  type="button"
                  onClick={() => setCreateSeatAssignment('choose')}
                  style={{
                    flex: 1,
                    padding: '10px 12px',
                    borderRadius: 10,
                    border: createSeatAssignment === 'choose' ? '2px solid #6eb5ff' : '1px solid #2a3544',
                    background: createSeatAssignment === 'choose' ? 'rgba(40,90,140,0.35)' : '#0a0e14',
                    color: createSeatAssignment === 'choose' ? '#cde4ff' : '#7a8a9a',
                    fontWeight: createSeatAssignment === 'choose' ? 700 : 500,
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Choose
                </button>
              </div>
              <p style={{ margin: '-6px 0 14px', fontSize: 11, color: '#5a6a7a', lineHeight: 1.4 }}>
                Random: auto seat on join. Choose: players pick an empty seat on a table map.
              </p>
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
              <h1 style={{ margin: 0, fontSize: 26, letterSpacing: 2, color: '#6eb5ff' }}>
                兴旺发<span style={{ color: '#5a6a7a', fontWeight: 400 }}>传奇牌手</span>
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
                      {row.seatAssignment === 'choose' ? ' · pick seat' : ''}
                      {row.hasPassword ? ' · private' : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={joinTableDisabled(row, joiningTable)}
                    onClick={() => openJoinTable(row)}
                    style={{
                      padding: '10px 18px',
                      borderRadius: 10,
                      border: 'none',
                      background: joinTableDisabled(row, joiningTable) ? '#3a4a55' : '#1e5a8a',
                      color: '#fff',
                      fontWeight: 700,
                      cursor: joinTableDisabled(row, joiningTable) ? 'not-allowed' : 'pointer',
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
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: '#0a0a0a' }}>
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
            <span style={{ fontSize: 20, fontWeight: 800, color: '#6eb5ff', letterSpacing: 2 }}>兴旺发传奇牌手</span>
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
          {isSuper && game && game.phase !== 'idle' && game.phase !== 'showdown' && (
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
          {isHost && betweenHands && (
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
          {isHost && betweenHands && (
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

      {isSuper && game?.phase === 'showdown' && (
        <div style={{ margin: '0 16px 8px', padding: 4 }}>
          <button
            type="button"
            onClick={hostNextHand}
            style={{
              width: '100%',
              maxWidth: 560,
              margin: '0 auto',
              display: 'block',
              padding: '20px 28px',
              fontSize: 22,
              fontWeight: 900,
              letterSpacing: 0.5,
              borderRadius: 16,
              border: '4px solid #ffe082',
              cursor: 'pointer',
              color: '#2a1800',
              background: 'linear-gradient(180deg, #ffecb3 0%, #ffc107 35%, #ff8f00 100%)',
              boxShadow: '0 8px 28px rgba(255, 193, 7, 0.55), inset 0 1px 0 rgba(255,255,255,0.35)',
            }}
          >
            Deal Next Hand
          </button>
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0, padding: '8px 12px 12px', gap: 12 }}>
        {/* Table + log */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, minHeight: 0 }}>
          <div
            style={{
              flex: 1,
              minHeight: 'min(80vh, 820px)',
              height: '80vh',
              maxHeight: 900,
              position: 'relative',
              borderRadius: 12,
              overflow: 'visible',
              background: '#0a0a0a',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div
              style={{
                position: 'relative',
                width: 'min(96%, 1100px)',
                height: 'min(78vh, 760px)',
                maxHeight: '80vh',
                minHeight: 480,
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  transform: 'translate(-50%, -50%)',
                  width: '100%',
                  height: '88%',
                  maxWidth: 1040,
                  borderRadius: '50%',
                  background: 'radial-gradient(ellipse 100% 100% at 50% 40%, #0a9a42 0%, #076324 42%, #043d18 100%)',
                  boxShadow: `
                    0 0 0 3px #d4af37,
                    0 0 0 14px #2a1500,
                    0 0 0 17px #1a0c00,
                    0 32px 64px rgba(0,0,0,0.85),
                    0 12px 28px rgba(0,0,0,0.55),
                    inset 0 3px 22px rgba(255,255,255,0.1),
                    inset 0 -28px 55px rgba(0,0,0,0.38)
                  `,
                }}
              />

              <div style={{ position: 'absolute', inset: 0, overflow: 'visible', zIndex: 1 }}>
                {needsChooseSeat && (
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      zIndex: 15,
                      borderRadius: '50%',
                      background: 'radial-gradient(ellipse 100% 100% at 50% 42%, #0a8a3a 0%, #065a20 100%)',
                      boxShadow: 'inset 0 0 60px rgba(0,0,0,0.35)',
                      overflow: 'hidden',
                      pointerEvents: 'auto',
                    }}
                  >
                    <div style={{ textAlign: 'center', padding: '22px 16px 6px' }}>
                      <div style={{ fontSize: 21, fontWeight: 800, color: '#fff', marginBottom: 6 }}>Choose your seat</div>
                      <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)' }}>
                        Tap a glowing seat. Taken seats show the player name.
                      </div>
                    </div>
                    {Array.from({ length: maxSeats }, (_, i) => {
                      const occupant = roomPlayers.find(p => p.seated !== false && typeof p.seat === 'number' && p.seat === i)
                      const pos = seatPosition(i, Math.max(maxSeats, 2), 42, 44)
                      return (
                        <div
                          key={i}
                          style={{
                            position: 'absolute',
                            ...pos,
                            width: 'max-content',
                            zIndex: 2,
                            pointerEvents: 'auto',
                          }}
                        >
                          {occupant ? (
                            <div
                              title={occupant.name}
                              style={{
                                width: 60,
                                height: 60,
                                borderRadius: '50%',
                                border: '2px solid rgba(0,0,0,0.45)',
                                background: 'rgba(0,0,0,0.5)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: 11,
                                fontWeight: 700,
                                color: '#fff',
                                textAlign: 'center',
                                padding: 5,
                                boxSizing: 'border-box',
                                wordBreak: 'break-word',
                              }}
                            >
                              {occupant.name.length > 12 ? `${occupant.name.slice(0, 10)}…` : occupant.name}
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => chooseSeat(i)}
                              aria-label={`Sit in seat ${i + 1}`}
                              style={{
                                width: 54,
                                height: 54,
                                borderRadius: '50%',
                                border: '2px solid #ffe082',
                                background: 'rgba(30,80,40,0.55)',
                                cursor: 'pointer',
                                boxShadow:
                                  '0 0 18px rgba(255,224,130,0.9), 0 0 36px rgba(212,175,55,0.45), inset 0 0 12px rgba(255,255,255,0.12)',
                              }}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {nextHandShowSec != null && nextHandShowSec > 0 && (
                  <div
                    style={{
                      position: 'absolute',
                      left: '50%',
                      top: '50%',
                      transform: 'translate(-50%,-50%)',
                      zIndex: 12,
                      pointerEvents: 'none',
                      textAlign: 'center',
                      padding: '18px 28px',
                      borderRadius: 16,
                      background: 'rgba(0,0,0,0.78)',
                      border: '2px solid #d4af37',
                      boxShadow: '0 12px 40px rgba(0,0,0,0.65)',
                    }}
                  >
                    <div style={{ fontSize: 26, fontWeight: 900, color: '#ffe082', letterSpacing: 1 }}>
                      New hand in {nextHandShowSec}…
                    </div>
                  </div>
                )}

                <div
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    transform: 'translate(-50%,-50%)',
                    textAlign: 'center',
                    zIndex: 2,
                    width: 'min(92%, 720px)',
                    pointerEvents: 'none',
                  }}
                >
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', letterSpacing: 3, marginBottom: 6, textTransform: 'uppercase' }}>
                    {(game && PHASE_LABELS[game.phase]) || 'Waiting'}
                  </div>
                  <div
                    style={{
                      fontSize: 'clamp(18px, 3.2vw, 26px)',
                      fontWeight: 800,
                      color: '#fff',
                      textShadow: '0 2px 12px rgba(0,0,0,0.65)',
                      marginBottom: 4,
                    }}
                  >
                    Total Pot: {formatBBAmount(game?.pot ?? 0, bigBlind)}
                  </div>
                  <div style={{ pointerEvents: 'none', display: 'flex', justifyContent: 'center' }}>
                    <PotChipDecor />
                  </div>
                  {showSidePotHint && (
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', marginTop: 4 }}>Multiple all-ins — side pots may apply</div>
                  )}
                  <div
                    style={{
                      width: boardRowW * boardScale,
                      height: boardRowH * boardScale,
                      margin: '10px auto 0',
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
                </div>

                {orderedSeats.map(slot => {
                  const seatIdx = typeof slot.seat === 'number' ? slot.seat : 0
                  const pos = seatPosition(seatIdx, Math.max(maxSeats, 2), 41, 43)
                  const gp = mergedGamePlayers(slot.socketId)
                  const active = gp && game?.players?.[game.currentPlayer]?.socketId === slot.socketId
                  const winner = gp && game?.winners?.includes(slot.socketId)
                  const folded = !!gp?.folded
                  const cards = cardsForSeat(slot)
                  const showCards =
                    cards &&
                    cards.length > 0 &&
                    cards.some(c => c !== null && typeof c === 'object' && c.r)
                  const nHole = cards?.length ?? 0
                  const fanItems =
                    showCards && cards
                      ? cards.map((c, j) => ({ key: j, card: c, back: !c || !c.r }))
                      : cards && nHole > 0
                        ? Array.from({ length: nHole }, (_, j) => ({ key: j, card: null, back: true }))
                        : []

                  return (
                    <div
                      key={slot.socketId}
                      style={{
                        position: 'absolute',
                        ...pos,
                        width: 'max-content',
                        maxWidth: 'min(88vw, 280px)',
                        zIndex: 4,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 6,
                        boxSizing: 'border-box',
                        opacity: folded ? 0.42 : 1,
                        filter: folded ? 'grayscale(0.35)' : 'none',
                        pointerEvents: 'none',
                      }}
                    >
                      <div
                        style={{
                          position: 'relative',
                          width: Math.max(120, nHole * 28 + 40),
                          height: Math.max(52, holeRowH * holeScale * 0.75),
                          marginBottom: 2,
                        }}
                      >
                        {fanItems.length > 0 ? (
                          fanItems.map((item, j) => {
                            const n = fanItems.length
                            const off = j - (n - 1) / 2
                            return (
                              <div
                                key={item.key}
                                style={{
                                  position: 'absolute',
                                  left: '50%',
                                  bottom: 0,
                                  transform: `translateX(-50%) translateX(${off * 18}px) rotate(${off * 13}deg)`,
                                  transformOrigin: 'bottom center',
                                  zIndex: j,
                                }}
                              >
                                <div style={{ transform: `scale(${holeScale * 0.88})`, transformOrigin: 'bottom center' }}>
                                  <Card
                                    variant="hole"
                                    card={item.card}
                                    fourColor={fourColor}
                                    back={item.back}
                                  />
                                </div>
                              </div>
                            )
                          })
                        ) : null}
                      </div>

                      <div style={{ position: 'relative', width: 60, height: 60, flexShrink: 0 }}>
                        <div
                          style={{
                            width: 60,
                            height: 60,
                            borderRadius: '50%',
                            background: 'linear-gradient(165deg, #4a5568 0%, #2a3038 100%)',
                            border: winner
                              ? '3px solid #ffe082'
                              : active
                                ? '3px solid #d4af37'
                                : '2px solid rgba(0,0,0,0.55)',
                            boxShadow: active
                              ? '0 0 0 2px rgba(212,175,55,0.35), 0 0 24px rgba(212,175,55,0.55), 0 6px 16px rgba(0,0,0,0.5)'
                              : winner
                                ? '0 0 18px rgba(255,224,130,0.45), 0 6px 16px rgba(0,0,0,0.5)'
                                : '0 6px 16px rgba(0,0,0,0.45)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 19,
                            fontWeight: 800,
                            color: '#fff',
                            letterSpacing: -0.5,
                          }}
                        >
                          {playerInitials(slot.name)}
                        </div>
                        {dealerSeatIndex != null && dealerSeatIndex === seatIdx && (
                          <div
                            style={{
                              position: 'absolute',
                              right: -4,
                              top: -2,
                              width: 22,
                              height: 22,
                              borderRadius: '50%',
                              background: 'linear-gradient(180deg, #f4d03f, #b8860b)',
                              color: '#1a0f00',
                              fontSize: 11,
                              fontWeight: 900,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              border: '2px solid #2a1500',
                              boxShadow: '0 2px 8px rgba(0,0,0,0.55)',
                            }}
                          >
                            D
                          </div>
                        )}
                      </div>

                      <div style={{ textAlign: 'center', maxWidth: 120 }}>
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 700,
                            color: '#fff',
                            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {slot.name}
                          {slot.socketId === sid ? ' · you' : ''}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: 'rgba(255,255,255,0.88)',
                            marginTop: 2,
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {slot.unlimitedChips ? '∞ BB' : formatBBAmount(slot.stack ?? 0, bigBlind)}
                        </div>
                        {gp &&
                          game &&
                          game.phase !== 'idle' &&
                          game.phase !== 'showdown' &&
                          (gp.streetBet ?? 0) > 0 && (
                            <div
                              style={{
                                marginTop: 4,
                                fontSize: 11,
                                fontWeight: 700,
                                color: '#fff3d0',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 2,
                                textShadow: '0 1px 3px rgba(0,0,0,0.7)',
                              }}
                            >
                              <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                                <BetChipIcon streetBet={gp.streetBet} bb={bigBlind} />
                              </span>
                              {formatBBAmount(gp.streetBet, bigBlind)}
                            </div>
                          )}
                        {gp?.handLabel && (
                          <div style={{ fontSize: 10, color: '#c8f0c8', marginTop: 3, fontWeight: 600 }}>{gp.handLabel}</div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Actions */}
          {myTurn && raiseBounds && (
            <div
              style={{
                padding: '14px 16px 18px',
                background: 'linear-gradient(180deg, #141820 0%, #0d1018 100%)',
                borderRadius: 14,
                border: '1px solid #2a2520',
                boxShadow: '0 -8px 32px rgba(0,0,0,0.45)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 12,
                maxWidth: 560,
                margin: '0 auto',
                width: '100%',
              }}
            >
              <div style={{ fontSize: 12, color: '#a8b0c0', alignSelf: 'stretch', textAlign: 'center' }}>
                Your turn ·{' '}
                <strong style={{ color: actSecsLeft <= 5 ? '#ff7043' : '#fff' }}>{actSecsLeft}s</strong>
              </div>
              {potOddsLine && raiseBounds.toCall > 0 && (
                <div style={{ fontSize: 11, color: '#c9a227', textAlign: 'center', maxWidth: 420, lineHeight: 1.35 }}>
                  {potOddsLine}
                </div>
              )}
              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'stretch',
                  gap: 6,
                  fontSize: 12,
                  color: '#9aa4b4',
                  width: '100%',
                  maxWidth: 480,
                }}
              >
                <span style={{ textAlign: 'center' }}>
                  Raise to <strong style={{ color: '#fff' }}>{formatBBAmount(raiseTo, bigBlind)}</strong>
                  <span style={{ color: '#6a7384', fontWeight: 400 }}> (${raiseTo})</span>
                </span>
                <input
                  type="range"
                  min={raiseBounds.minRaiseTo}
                  max={raiseBounds.maxRaiseTo}
                  value={Math.min(raiseTo, raiseBounds.maxRaiseTo)}
                  onChange={e => setRaiseTo(+e.target.value)}
                  style={{ width: '100%', accentColor: '#d4af37' }}
                />
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 12, width: '100%' }}>
                <button type="button" onClick={() => doAction('fold')} style={btnFold}>
                  FOLD
                </button>
                {raiseBounds.toCall === 0 ? (
                  <button type="button" onClick={() => doAction('check')} style={btnCall}>
                    CHECK
                  </button>
                ) : (
                  <button type="button" onClick={() => doAction('call')} style={btnCall}>
                    CALL {formatBBAmount(raiseBounds.toCall, bigBlind)}
                  </button>
                )}
                <button type="button" onClick={doRaise} style={btnRaise}>
                  RAISE
                </button>
              </div>
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
          {roomPlayers.filter(p => p.seated !== false).length < 2 && !game && (
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
            {[...roomPlayers]
              .sort((a, b) => {
                const wa = a.seated === false ? 1 : 0
                const wb = b.seated === false ? 1 : 0
                if (wa !== wb) return wa - wb
                return (a.seat ?? 999) - (b.seat ?? 999)
              })
              .map(p => (
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
                    title={p.seated === false ? 'Watching (no seat)' : 'Seated'}
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: p.seated === false ? '#7a8a9a' : p.online ? '#4caf50' : '#444',
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', color: p.socketId === sid ? '#8bc4ff' : '#c8d4e0' }}>
                    <span style={{ color: '#5a6a7a', fontSize: 10, marginRight: 4 }}>
                      {p.seated === false ? '—' : `#${typeof p.seat === 'number' ? p.seat + 1 : '?'}`}
                    </span>
                    {p.name}
                    {p.isHost ? ' · host' : ''}
                    {p.seated === false ? <span style={{ color: '#6a7a8a' }}> · watching</span> : null}
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
  padding: '14px 28px',
  borderRadius: 10,
  border: '2px solid #8b2a2a',
  background: 'linear-gradient(180deg, #c62828 0%, #8e1b1b 100%)',
  color: '#fff',
  fontWeight: 800,
  cursor: 'pointer',
  fontSize: 15,
  letterSpacing: 0.5,
  boxShadow: '0 4px 14px rgba(198,40,40,0.45)',
  minWidth: 120,
}
const btnCall = {
  padding: '14px 28px',
  borderRadius: 10,
  border: '2px solid #1e4a7a',
  background: 'linear-gradient(180deg, #1e6ba8 0%, #124a78 100%)',
  color: '#fff',
  fontWeight: 800,
  cursor: 'pointer',
  fontSize: 15,
  letterSpacing: 0.5,
  boxShadow: '0 4px 14px rgba(30,107,168,0.4)',
  minWidth: 120,
}
const btnRaise = {
  padding: '14px 28px',
  borderRadius: 10,
  border: '2px solid #8a6d1f',
  background: 'linear-gradient(180deg, #f4d03f 0%, #c9a227 45%, #9a7b18 100%)',
  color: '#1a1200',
  fontWeight: 800,
  cursor: 'pointer',
  fontSize: 15,
  letterSpacing: 0.5,
  boxShadow: '0 4px 16px rgba(201,162,39,0.45)',
  minWidth: 120,
}
const btnOk = btnCall
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
