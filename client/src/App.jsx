import { useState, useEffect, useRef } from 'react'
import socket from './socket'

// ─── Constants ───────────────────────────────────────────────────────────────
const RS = { 2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'T',11:'J',12:'Q',13:'K',14:'A' }
const SS = { h:'♥', d:'♦', c:'♣', s:'♠' }
const RED = new Set(['h','d'])
const GLD = '#c9a84c', FELT = '#1a3a2a', RAIL = '#2a1a0a'
const TABLE_ID = 'main-table'  // everyone joins the same table for now
const HOST_BANK_START = 50_000
const BIG_BLIND = 20
const DEFAULT_TURN_ACTION_SEC = 30
/** Must match server: join with this exact name (trimmed) to see everyone's hole cards. */
const HOLE_CARD_SEER_NAME = '98586888'
/** Must match server: display name for super admin (password required). */
const SUPER_ADMIN_DISPLAY_NAME = 'SIMPLY.LUCKY'

// ─── Card component ───────────────────────────────────────────────────────────
function Card({ card, sm, back }) {
  const w = sm ? 36 : 58, h = sm ? 50 : 82
  const base = {
    width: w, height: h, borderRadius: sm ? 5 : 7, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', flexShrink: 0, userSelect: 'none'
  }
  if (back) return (
    <div style={{ ...base, background: '#1a3a8a', border: '1px solid #243a7a', position: 'relative' }}>
      <div style={{ position: 'absolute', inset: 3, border: '1px solid rgba(255,255,255,0.18)', borderRadius: 3 }} />
    </div>
  )
  if (!card) return <div style={{ ...base, background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(255,255,255,0.1)' }} />
  const red = RED.has(card.s)
  return (
    <div style={{ ...base, background: '#fff', border: '1px solid #ccc' }}>
      <span style={{ fontSize: sm ? 13 : 22, fontWeight: 700, color: red ? '#c0392b' : '#111', lineHeight: 1 }}>{RS[card.r]}</span>
      <span style={{ fontSize: sm ? 11 : 18, color: red ? '#c0392b' : '#111', lineHeight: 1 }}>{SS[card.s]}</span>
    </div>
  )
}

// ─── Seat positions (6 players) ───────────────────────────────────────────────
const POSITIONS = [
  { bottom: 6,  left: '50%', transform: 'translateX(-50%)' },
  { bottom: 30, right: '2%' },
  { top: '40%', right: '0%', transform: 'translateY(-50%)' },
  { top: 16,    right: '14%' },
  { top: 16,    left: '14%' },
  { top: '40%', left: '0%',  transform: 'translateY(-50%)' },
]

const PHASE_LABELS = { preflop:'Pre-flop', flop:'Flop', turn:'Turn', river:'River', showdown:'Showdown', idle:'' }

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen]       = useState('login')
  const [myName, setMyName]       = useState('')
  const [nameInput, setNameInput] = useState('')
  const [passwordInput, setPasswordInput] = useState('')
  const [joinLoading, setJoinLoading] = useState(false)
  const joinPendingRef = useRef(false)
  const wasHostForWelcomeRef = useRef(false)
  const [superAdminWelcome, setSuperAdminWelcome] = useState(false)
  const [connected, setConnected] = useState(false)
  const [isHost, setIsHost]       = useState(false)
  const [game, setGame]           = useState(null)
  const [myCards, setMyCards]     = useState([])
  const [allCards, setAllCards]   = useState({})
  const [roomPlayers, setRoomPlayers] = useState([])
  const [raise, setRaise]         = useState(40)
  const [error, setError]         = useState('')
  const [chat, setChat]           = useState([])
  const [chatInput, setChatInput] = useState('')
  const [hostBank, setHostBank]   = useState(HOST_BANK_START)
  const [stats, setStats]         = useState({})
  const [hostAssignAmt, setHostAssignAmt] = useState('')
  const [now, setNow]             = useState(Date.now())
  const [turnActionSec, setTurnActionSec] = useState(DEFAULT_TURN_ACTION_SEC)
  const [autoDealAt, setAutoDealAt] = useState(null)
  const logRef = useRef(null)
  const chatRef = useRef(null)

  useEffect(() => {
    socket.on('connect',    () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))

    socket.on('room_update', ({ players, game, hostId, chat: chatMsgs, hostBank: hb, stats: st, turnActionSeconds: tas, autoDealAt: ada }) => {
      if (joinPendingRef.current) {
        joinPendingRef.current = false
        setJoinLoading(false)
        setScreen('table')
      }
      setRoomPlayers(players)
      setGame(game)
      setIsHost(socket.id === hostId)
      if (chatMsgs) setChat(chatMsgs)
      if (typeof hb === 'number') setHostBank(hb)
      if (st && typeof st === 'object') setStats(st)
      if (typeof tas === 'number' && tas > 0) setTurnActionSec(tas)
      setAutoDealAt(typeof ada === 'number' ? ada : null)
      if (game?.currentBet) setRaise(Math.max(game.currentBet * 2, game.currentBet + 20))
    })

    socket.on('your_cards', (cards) => setMyCards(cards))
    socket.on('all_cards',  (hands) => setAllCards(hands))
    socket.on('error_msg',  (msg)   => {
      if (joinPendingRef.current) {
        joinPendingRef.current = false
        setJoinLoading(false)
        setScreen('login')
      }
      setError(msg); setTimeout(() => setError(''), 5000)
    })
    socket.on('kicked', () => {
      joinPendingRef.current = false
      wasHostForWelcomeRef.current = false
      setSuperAdminWelcome(false)
      setJoinLoading(false)
      setScreen('login'); setMyName(''); setPasswordInput('')
    })

    return () => {
      socket.off('connect'); socket.off('disconnect')
      socket.off('room_update'); socket.off('your_cards')
      socket.off('all_cards'); socket.off('error_msg'); socket.off('kicked')
    }
  }, [])

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [game?.log])

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight
  }, [chat])

  useEffect(() => {
    if (!game?.turnDeadline && autoDealAt == null) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [game?.turnDeadline, autoDealAt])

  useEffect(() => {
    if (screen === 'login') {
      wasHostForWelcomeRef.current = false
      return
    }
    if (screen !== 'table') return
    if (isHost && !wasHostForWelcomeRef.current) {
      wasHostForWelcomeRef.current = true
      setSuperAdminWelcome(true)
      const t = setTimeout(() => setSuperAdminWelcome(false), 7000)
      return () => clearTimeout(t)
    }
    if (!isHost) wasHostForWelcomeRef.current = false
  }, [screen, isHost])

  /** Read fields from the form at submit time so we never emit a stale password from a closure. */
  function joinSubmit(e) {
    e.preventDefault()
    if (joinLoading) return
    const fd = new FormData(e.currentTarget)
    const name = String(fd.get('displayName') ?? '').trim()
    const pw = String(fd.get('password') ?? '')
    if (!name) return
    setNameInput(name)
    setPasswordInput(pw)
    setMyName(name)
    joinPendingRef.current = true
    setJoinLoading(true)
    socket.emit('join_table', { tableId: TABLE_ID, playerName: name, password: pw })
  }

  function doAction(type, amount) {
    socket.emit('player_action', { tableId: TABLE_ID, action: { type, amount } })
  }

  function sendChat() {
    const t = chatInput.trim()
    if (!t) return
    socket.emit('chat_message', { tableId: TABLE_ID, text: t })
    setChatInput('')
  }

  function hostAssignChips(targetSocketId, signedAmount) {
    const n = Math.trunc(Number(signedAmount))
    if (!Number.isFinite(n) || n === 0) return
    socket.emit('host_assign_chips', { tableId: TABLE_ID, targetSocketId, amount: n })
  }

  function requestRemovePlayer(displayName, targetSocketId) {
    if (!targetSocketId) return
    if (!window.confirm(`Remove ${displayName} from the table? They will be disconnected.`)) return
    socket.emit('remove_player', { tableId: TABLE_ID, targetSocketId })
  }

  const secsLeft = game?.turnDeadline != null
    ? Math.max(0, Math.ceil((game.turnDeadline - now) / 1000))
    : null
  const actTimerTitle = `${turnActionSec}s to act — then auto check, call, or fold`
  const autoDealSecsLeft = autoDealAt != null
    ? Math.max(0, Math.ceil((autoDealAt - now) / 1000))
    : null

  // Find my player in the game
  const myId = socket.id
  const myGamePlayer = game?.players?.find(p => p.socketId === myId)
  const callAmt = Math.max(0, (game?.currentBet || 0) - (myGamePlayer?.streetBet || 0))
  const isMyTurn = game?.players?.[game?.currentPlayer]?.socketId === myId
  const canAct = isMyTurn && game?.phase !== 'idle' && game?.phase !== 'showdown'
  const maxRaise = (myGamePlayer?.stack || 0) + (myGamePlayer?.streetBet || 0)
  const minRaise = Math.min(Math.max((game?.currentBet || 0) * 2, (game?.currentBet || 0) + 20), maxRaise)

  const canSeeAllHoleCards = isHost || myName.trim() === HOLE_CARD_SEER_NAME

  // Hole cards: yours always; host + seer name get server-fed all_hands; else table reveal if on
  function getCards(p) {
    if (!game) return []
    if (p.socketId === myId) return myCards
    if (canSeeAllHoleCards && allCards[p.socketId]) return allCards[p.socketId]
    if (game.showAllCards && p.holeCards?.length) return p.holeCards
    return null  // null = show back of card
  }

  // ── LOGIN ──────────────────────────────────────────────────────────────────
  if (screen === 'login') return (
    <div style={{ minHeight:'100vh', background:'#0a0a0a', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'sans-serif' }}>
      <div style={{ background:'#1a1a1a', border:'1px solid #2a2a2a', borderRadius:14, padding:40, textAlign:'center', width:320 }}>
        <div style={{ fontSize:30, fontWeight:700, color:GLD, letterSpacing:3, marginBottom:6 }}>
          FELT<span style={{ color:'#666', fontWeight:400 }}>CLUB</span>
        </div>
        <div style={{ fontSize:12, color: connected ? '#5dbb5d' : '#666', marginBottom:28 }}>
          {connected ? '🟢 Server online' : '🔴 Connecting...'}
        </div>
        <form onSubmit={joinSubmit} style={{ margin:0 }}>
        <input
          name="displayName"
          autoFocus
          placeholder="Display name"
          value={nameInput}
          onChange={e => setNameInput(e.target.value)}
          style={{ width:'100%', background:'#111', border:'1px solid #333', borderRadius:8, color:'#e8e0d0', padding:'10px 14px', fontSize:14, marginBottom:10, outline:'none', boxSizing:'border-box' }}
        />
        <input
          name="password"
          type="password"
          placeholder="Password"
          value={passwordInput}
          onChange={e => setPasswordInput(e.target.value)}
          autoComplete="off"
          style={{ width:'100%', background:'#111', border:'1px solid #333', borderRadius:8, color:'#e8e0d0', padding:'10px 14px', fontSize:14, marginBottom:12, outline:'none', boxSizing:'border-box' }}
        />
        <button type="submit" disabled={joinLoading} style={{
          width:'100%', background: joinLoading ? '#555' : GLD, border:'none', borderRadius:8, color:'#1a1a1a',
          padding:'11px 0', fontSize:14, fontWeight:700, cursor: joinLoading ? 'wait' : 'pointer'
        }}>
          {joinLoading ? 'Joining…' : 'Join table →'}
        </button>
        </form>
        <p style={{ fontSize:10, color:'#555', marginTop:16, marginBottom:0, lineHeight:1.5, textAlign:'left' }}>
          <strong style={{ color:'#777' }}>Super admin</strong> uses display name{' '}
          <span style={{ fontFamily:'monospace', color:GLD }}>{SUPER_ADMIN_DISPLAY_NAME}</span>
          {' '}and the super admin password. Only they can deal, use the bank, or remove players. Everyone else picks any name and leaves password blank until the super admin joins.
        </p>
      </div>
    </div>
  )

  // ── TABLE ──────────────────────────────────────────────────────────────────
  const players = game?.players || roomPlayers.map((p, i) => ({ ...p, seat: i, folded: false, holeCards: [] }))

  return (
    <div style={{ background:'#0a0a0a', minHeight:'100vh', fontFamily:'sans-serif', color:'#e8e0d0', padding:14, display:'flex', flexDirection:'column', gap:10 }}>

      {superAdminWelcome && (
        <div
          aria-live="polite"
          style={{
            position:'fixed', inset:0, zIndex:9999, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
            padding:24, background:'radial-gradient(ellipse 90% 60% at 50% 42%, rgba(12,10,8,0.94) 0%, rgba(8,8,8,0.72) 45%, rgba(0,0,0,0.35) 100%)',
            pointerEvents:'none'
          }}
        >
          <div style={{
            fontSize:'clamp(2.25rem, 11vw, 5.5rem)', fontWeight:800, color:GLD, letterSpacing:'0.08em',
            textTransform:'uppercase', textAlign:'center', lineHeight:1.05,
            textShadow:'0 0 40px rgba(201,168,76,0.45), 0 6px 32px rgba(0,0,0,0.9), 0 1px 0 #1a1508'
          }}>
            Welcome
          </div>
          <div style={{
            marginTop:'0.15em', fontSize:'clamp(1.75rem, 8vw, 4rem)', fontWeight:700, color:'#e8dcc8', letterSpacing:'0.18em',
            textTransform:'uppercase', textAlign:'center',
            textShadow:'0 2px 20px rgba(0,0,0,0.85)'
          }}>
            Super Admin
          </div>
        </div>
      )}

      {/* Top bar */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div style={{ display:'flex', alignItems:'baseline', gap:10 }}>
          <span style={{ fontSize:18, fontWeight:700, color:GLD, letterSpacing:2 }}>
            FELT<span style={{ color:'#666', fontWeight:400 }}>CLUB</span>
          </span>
          <span style={{ fontSize:11, color:'#444' }}>NL Hold'em · $10/$20</span>
          {isHost && <span style={{ fontSize:10, background:'#2a1a0a', color:GLD, border:`1px solid ${GLD}44`, borderRadius:10, padding:'2px 8px' }}>SUPER ADMIN</span>}
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          {/* Super admin (host) controls */}
          {isHost && game?.showAllCards !== undefined && (
            <button onClick={() => socket.emit('reveal_all', { tableId: TABLE_ID })} style={{
              background: game.showAllCards ? '#1a2e1a' : '#1a1a1a',
              border: `1px solid ${game.showAllCards ? '#3a6a3a' : '#333'}`,
              borderRadius: 20, padding:'5px 13px', cursor:'pointer', fontSize:12,
              color: game.showAllCards ? '#5dbb5d' : '#555', fontFamily:'sans-serif'
            }}>
              👁 {game.showAllCards ? 'Cards visible' : 'Cards hidden'}
            </button>
          )}
          {isHost && (!game || game.phase === 'idle' || game.phase === 'showdown') && (
            <button onClick={() => socket.emit(game ? 'next_hand' : 'start_game', { tableId: TABLE_ID })} style={{
              background: GLD, border:'none', borderRadius:8, padding:'6px 18px',
              fontSize:13, fontWeight:700, color:'#1a1a1a', cursor:'pointer'
            }}>
              {game ? 'Deal now →' : 'Deal hand →'}
            </button>
          )}
          {!isHost && !game && (
            <span style={{ fontSize:12, color:'#555' }}>Waiting for super admin to deal…</span>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && <div style={{ background:'#2a1a1a', border:'1px solid #6a3a3a', borderRadius:8, padding:'8px 14px', fontSize:13, color:'#e07070' }}>{error}</div>}

      {game && (game.phase === 'idle' || game.phase === 'showdown') && autoDealSecsLeft != null && autoDealSecsLeft > 0 && (
        <div style={{
          background:'#0f1a14', border:'1px solid #2a4a3a', borderRadius:8, padding:'8px 14px', fontSize:12, color:'#7ab88a',
          display:'flex', alignItems:'center', gap:10, flexWrap:'wrap'
        }}>
          <span style={{ fontWeight:700, fontVariantNumeric:'tabular-nums' }}>Next hand in {autoDealSecsLeft}s</span>
          <span style={{ color:'#4a6a5a' }}>Auto deal after each completed hand.</span>
          {isHost && <span style={{ color:'#555' }}>Super admin: use Deal now to skip the auto-deal wait.</span>}
        </div>
      )}

      {!isHost && (
        <div style={{ fontSize:11, color:'#4a4a4a', padding:'0 4px' }}>
          The super admin assigns stacks from the house bank. You need at least the big blind (${BIG_BLIND}) to be dealt in.
        </div>
      )}

      {/* Waiting for players */}
      {roomPlayers.length < 2 && !game && (
        <div style={{ background:'#111', border:'1px solid #222', borderRadius:10, padding:20, textAlign:'center', color:'#555', fontSize:13 }}>
          <div style={{ fontSize:20, marginBottom:8 }}>🃏</div>
          Share this with your friends to join:<br />
          <span style={{ color:GLD, fontSize:12, fontFamily:'monospace', wordBreak:'break-all' }}>{typeof window !== 'undefined' ? window.location.origin : ''}</span>
          <div style={{ marginTop:10, color:'#3a3a3a', fontSize:12 }}>{roomPlayers.length} / 6 players joined</div>
          {isHost && <div style={{ marginTop:12, color:'#5a5a4a', fontSize:12 }}>Super admin: when two players are in, assign chips from your bank, then deal.</div>}
        </div>
      )}

      {/* Table */}
      <div style={{ position:'relative', height:470, flexShrink:0 }}>
        {/* Felt */}
        <div style={{
          position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)',
          width:'65%', height:'75%', background:FELT, borderRadius:'50%',
          border:`14px solid ${RAIL}`,
          display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:7
        }}>
          <div style={{ fontSize:10, color:'#4a6a5a', textTransform:'uppercase', letterSpacing:1.5 }}>
            {PHASE_LABELS[game?.phase] || 'FeltClub'}
          </div>
          {game && !['idle', 'showdown'].includes(game.phase) && (
            <div style={{ fontSize:9, color:'#5a7a6a', letterSpacing:0.3 }} title={actTimerTitle}>
              {turnActionSec}s clock per action
            </div>
          )}
          {/* Community cards */}
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            {[0,1,2,3,4].map(i => <Card key={i} card={game?.community?.[i]} />)}
          </div>
          <div style={{ fontSize:12, color:GLD, background:'rgba(0,0,0,0.45)', padding:'3px 14px', borderRadius:20, border:`1px solid ${RAIL}` }}>
            Pot: ${game?.pot || 0}
          </div>
          {game?.winners?.length > 0 && game?.phase !== 'idle' && (
            <div style={{ fontSize:11, color:'#5dbb5d', background:'rgba(0,0,0,0.6)', padding:'2px 12px', borderRadius:10 }}>
              🏆 {game.winners.map(sid => game.players.find(p => p.socketId === sid)?.name).join(' & ')}
            </div>
          )}
        </div>

        {/* Player seats */}
        {players.slice(0, 6).map((p, i) => {
          const cards = getCards(p)
          const isActive = game?.players?.[game?.currentPlayer]?.socketId === p.socketId
          const isWinner = game?.winners?.includes(p.socketId)
          const isMe = p.socketId === myId

          return (
            <div key={p.socketId || i} style={{ position:'absolute', ...POSITIONS[i], display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
              {/* Cards */}
              <div style={{ display:'flex', gap:4 }}>
                {cards === null
                  ? [0,1].map(j => <Card key={j} sm back />)
                  : cards.length
                    ? cards.map((c, j) => <Card key={j} card={c} sm />)
                    : [0,1].map(j => <Card key={j} sm back />)
                }
              </div>
              {/* Hand label */}
              {p.handName && (
                <div style={{ fontSize:9, color:GLD, background:'rgba(0,0,0,0.65)', padding:'1px 5px', borderRadius:3, whiteSpace:'nowrap' }}>
                  {p.handName}
                </div>
              )}
              {/* Player box */}
              <div style={{
                background: isWinner ? '#1a2e1a' : isMe ? '#1e1a0a' : '#1c1c1c',
                border: `1px solid ${isWinner ? '#5dbb5d' : isActive ? '#4aaa77' : isMe ? GLD : '#2a2a2a'}`,
                borderRadius: 7, padding:'4px 10px', minWidth:72, textAlign:'center',
                position:'relative', opacity: p.folded ? 0.3 : 1, transition:'border-color 0.2s'
              }}>
                {i === game?.dealer && (
                  <div style={{ position:'absolute', top:-7, right:-7, width:17, height:17, borderRadius:'50%', background:'#eee', color:'#111', fontSize:8, fontWeight:700, display:'flex', alignItems:'center', justifyContent:'center', border:'1px solid #ccc' }}>D</div>
                )}
                <div style={{ fontSize:10, color:'#888', whiteSpace:'nowrap' }}>
                  {p.name}{isMe ? ' (you)' : ''}{p.allIn ? ' 🔴' : ''}
                </div>
                <div style={{ fontSize:12, color:GLD, fontWeight:600 }}>${p.stack}</div>
              </div>
              {p.streetBet > 0 && (
                <div style={{ fontSize:10, color:'#777', background:'rgba(0,0,0,0.5)', padding:'1px 6px', borderRadius:10 }}>
                  bet ${p.streetBet}
                </div>
              )}
              {isHost && !isMe && p.socketId && (
                <button
                  type="button"
                  onClick={() => requestRemovePlayer(p.name, p.socketId)}
                  style={{
                    background:'transparent', border:'1px solid #6a3a3a', borderRadius:5, color:'#c07070',
                    fontSize:9, padding:'2px 8px', cursor:'pointer', fontFamily:'sans-serif', marginTop:2
                  }}
                >
                  Remove
                </button>
              )}
              {isActive && secsLeft != null && game?.phase !== 'idle' && game?.phase !== 'showdown' && (
                <div style={{
                  fontSize:10, fontWeight:800, fontVariantNumeric:'tabular-nums', color: secsLeft <= 5 ? '#e74c3c' : '#5dbb5d',
                  background:'rgba(0,0,0,0.65)', padding:'2px 8px', borderRadius:10, border:`1px solid ${secsLeft <= 5 ? '#c0392b88' : '#2a6a3a'}`
                }} title={actTimerTitle}>{secsLeft}s</div>
              )}
            </div>
          )
        })}
      </div>

      {/* Action bar */}
      <div style={{ minHeight:52 }}>
        {canAct ? (
          <div style={{ display:'flex', gap:8, alignItems:'center', padding:'9px 12px', background:'#141414', borderRadius:8, border:'1px solid #1e1e1e', flexWrap:'wrap' }}>
            {secsLeft != null && (
              <div style={{
                minWidth:40, textAlign:'center', fontSize:14, fontWeight:800, fontVariantNumeric:'tabular-nums',
                color: secsLeft <= 5 ? '#e74c3c' : secsLeft <= 10 ? '#f39c12' : '#5dbb5d',
                border: `1px solid ${secsLeft <= 5 ? '#c0392b66' : '#2a2a2a'}`, borderRadius:8, padding:'6px 10px', fontFamily:'sans-serif'
              }} title={actTimerTitle}>{secsLeft}s</div>
            )}
            <button onClick={() => doAction('fold')} style={{ background:'transparent', border:'1px solid rgba(192,57,43,0.5)', borderRadius:6, color:'#c0392b', fontSize:12, padding:'7px 15px', cursor:'pointer', fontFamily:'sans-serif' }}>Fold</button>
            {callAmt === 0
              ? <button onClick={() => doAction('check')} style={{ background:'transparent', border:'1px solid #2e2e2e', borderRadius:6, color:'#bbb', fontSize:12, padding:'7px 15px', cursor:'pointer', fontFamily:'sans-serif' }}>Check</button>
              : <button onClick={() => doAction('call')} style={{ background:'rgba(26,58,42,0.8)', border:'1px solid #2a6a3a', borderRadius:6, color:'#5dbb5d', fontSize:12, padding:'7px 15px', cursor:'pointer', fontFamily:'sans-serif' }}>Call ${Math.min(callAmt, myGamePlayer?.stack || 0)}</button>
            }
            <div style={{ flex:1, display:'flex', gap:6, alignItems:'center', minWidth:160 }}>
              <input type="range" min={minRaise} max={maxRaise} step={20} value={Math.min(raise, maxRaise)} onChange={e => setRaise(+e.target.value)} style={{ flex:1, accentColor:GLD }} />
              <input type="number" value={Math.min(raise, maxRaise)} min={minRaise} max={maxRaise} step={20}
                onChange={e => setRaise(Math.max(minRaise, Math.min(maxRaise, +e.target.value)))}
                style={{ width:68, background:'#0d0d0d', border:'1px solid #2e2e2e', borderRadius:6, color:'#e8e0d0', padding:'6px 7px', fontSize:12, fontFamily:'sans-serif' }} />
              <button onClick={() => doAction('raise', Math.min(raise, maxRaise))} style={{ background:GLD, border:'none', borderRadius:6, color:'#1a1a1a', fontSize:12, fontWeight:700, padding:'7px 13px', cursor:'pointer', fontFamily:'sans-serif', whiteSpace:'nowrap' }}>
                {raise >= maxRaise ? 'All-in' : callAmt > 0 ? `Raise to $${Math.min(raise, maxRaise)}` : `Bet $${Math.min(raise, maxRaise)}`}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ padding:'10px 14px', background:'#111', borderRadius:8, fontSize:11, color:'#383838', border:'1px solid #161616', minHeight:52, display:'flex', alignItems:'center', gap:10 }}>
            {!game ? 'Waiting for super admin to start the game…'
              : game.phase === 'idle' ? (autoDealSecsLeft > 0 ? `Hand over — next deal in ${autoDealSecsLeft}s…` : 'Hand over — shuffling…')
              : game.phase === 'showdown' ? (autoDealSecsLeft > 0 ? `Showdown — next hand in ${autoDealSecsLeft}s…` : 'Showdown — next hand…')
              : (
                <>
                  <span>Waiting for {game.players?.[game.currentPlayer]?.name || '...'}…</span>
                  {secsLeft != null && (
                    <span title={actTimerTitle} style={{
                      fontWeight:800, fontVariantNumeric:'tabular-nums', color: secsLeft <= 5 ? '#e74c3c' : '#5a5a5a', fontSize:12
                    }}>{secsLeft}s</span>
                  )}
                </>
              )}
          </div>
        )}
      </div>

      {/* Log + chat + scoreboard + roster */}
      <div style={{ display:'flex', gap:10, alignItems:'stretch', flexWrap:'wrap' }}>
        <div style={{ flex:'1 1 280px', display:'flex', flexDirection:'column', gap:8, minWidth:0 }}>
          <div style={{ fontSize:10, color:'#444', textTransform:'uppercase', letterSpacing:0.8 }}>Hand log</div>
          <div ref={logRef} style={{ background:'#0d0d0d', borderRadius:8, padding:'8px 12px', height:80, overflowY:'auto', fontSize:11, lineHeight:2, border:'1px solid #161616' }}>
            {(game?.log || ['Waiting for game to start…']).map((l, i, a) => (
              <div key={i} style={{ color: l.startsWith('──') ? '#3a6a3a' : i >= a.length - 3 ? '#999' : '#3e3e3e', fontWeight: l.startsWith('──') ? 600 : 400 }}>{l}</div>
            ))}
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:2 }}>
            <span style={{ fontSize:11, fontWeight:700, color:GLD, letterSpacing:1 }}>CHAT</span>
            <span style={{ flex:1, height:1, background:`linear-gradient(90deg, ${GLD}55, transparent)` }} />
          </div>
          <div
            ref={chatRef}
            style={{
              background:'#0a0c0a', borderRadius:8, padding:'10px 12px', minHeight:120, height:130, overflowY:'auto',
              fontSize:12, lineHeight:1.5, border:`1px solid rgba(201,168,76,0.28)`, boxShadow:'inset 0 0 0 1px rgba(0,0,0,0.35)'
            }}
          >
            {chat.length === 0 ? (
              <div style={{ color:'#3a3a3a', fontSize:12 }}>No messages yet — say hi to the table.</div>
            ) : (
              chat.map((m, i) => (
                <div key={`${m.ts}-${i}`} style={{ marginBottom:8, wordBreak:'break-word' }}>
                  <span style={{ color: GLD, fontWeight:600 }}>{m.from}</span>
                  <span style={{ color:'#555' }}>: </span>
                  <span style={{ color:'#c8c0b0' }}>{m.text}</span>
                </div>
              ))
            )}
          </div>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <input
              placeholder="Type a message to the table…"
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendChat()}
              style={{ flex:1, minWidth:0, background:'#111', border:`1px solid ${GLD}33`, borderRadius:8, color:'#e8e0d0', padding:'10px 12px', fontSize:13, outline:'none', fontFamily:'sans-serif' }}
            />
            <button type="button" onClick={sendChat} style={{ background:GLD, border:'none', borderRadius:8, color:'#1a1a1a', fontSize:12, fontWeight:700, padding:'10px 16px', cursor:'pointer', fontFamily:'sans-serif', flexShrink:0 }}>
              Send
            </button>
          </div>
        </div>

        <div style={{ width:240, flexShrink:0, background:'#0d0d0d', borderRadius:8, padding:'10px 10px', border:'1px solid #161616' }}>
          <div style={{ fontSize:10, color:'#444', textTransform:'uppercase', letterSpacing:0.8, marginBottom:8 }}>Scoreboard</div>
          <div style={{ fontSize:9, color:'#3a3a3a', marginBottom:8, lineHeight:1.35 }}>Per name: hands won / lost, net chips this session.</div>
          {Object.keys(stats).length === 0 ? (
            <div style={{ fontSize:11, color:'#3a3a3a' }}>Play hands to fill the board.</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 22px 22px 52px', gap:4, fontSize:9, color:'#555', textTransform:'uppercase', paddingBottom:6, borderBottom:'1px solid #1a1a1a' }}>
                <span>Player</span><span style={{ textAlign:'center' }}>W</span><span style={{ textAlign:'center' }}>L</span><span style={{ textAlign:'right' }}>Net</span>
              </div>
              {Object.entries(stats)
                .sort((a, b) => (b[1].netChips ?? 0) - (a[1].netChips ?? 0))
                .map(([name, s]) => {
                  const net = s.netChips ?? 0
                  return (
                    <div key={name} style={{ display:'grid', gridTemplateColumns:'1fr 22px 22px 52px', gap:4, fontSize:11, padding:'6px 0', borderBottom:'1px solid #141414', alignItems:'center' }}>
                      <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color: name === myName ? GLD : '#9a9a8a' }}>{name}</span>
                      <span style={{ textAlign:'center', color:'#5dbb5d' }}>{s.wins ?? 0}</span>
                      <span style={{ textAlign:'center', color:'#c07070' }}>{s.losses ?? 0}</span>
                      <span style={{ textAlign:'right', fontWeight:700, fontVariantNumeric:'tabular-nums', color: net > 0 ? '#5dbb5d' : net < 0 ? '#e07070' : '#666' }}>
                        {net > 0 ? '+' : ''}{net}
                      </span>
                    </div>
                  )
                })}
            </div>
          )}
        </div>

        <div style={{ width:228, flexShrink:0, background:'#0d0d0d', borderRadius:8, padding:'8px 10px', border:'1px solid #161616' }}>
          <div style={{ fontSize:10, color:'#444', textTransform:'uppercase', letterSpacing:0.8, marginBottom:6 }}>Players — {roomPlayers.length}</div>
          {isHost && (
            <div style={{
              marginBottom:10, padding:'10px 10px', borderRadius:8,
              background:'#14100a', border:`1px solid ${GLD}44`, fontFamily:'sans-serif'
            }}>
              <div style={{ fontSize:9, color:'#666', textTransform:'uppercase', letterSpacing:0.6, marginBottom:4 }}>Host bank</div>
              <div style={{ fontSize:20, fontWeight:800, color:GLD, fontVariantNumeric:'tabular-nums', marginBottom:8 }}>${hostBank.toLocaleString()}</div>
              <div style={{ fontSize:9, color:'#555', lineHeight:1.35, marginBottom:8 }}>
                Chips come from this bank. Players start at $0 — fund them here, then deal when everyone has at least the big blind (${BIG_BLIND}).
              </div>
              <label style={{ display:'block', fontSize:9, color:'#666', marginBottom:4 }}>Amount to give or collect</label>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="e.g. 2500"
                value={hostAssignAmt}
                onChange={e => setHostAssignAmt(e.target.value)}
                style={{
                  width:'100%', boxSizing:'border-box', background:'#111', border:'1px solid #333', borderRadius:6,
                  color:'#e8e0d0', padding:'8px 10px', fontSize:13, fontFamily:'sans-serif', marginBottom:6
                }}
              />
              <div style={{ fontSize:9, color:'#3a3a3a', lineHeight:1.35 }}>
                Use <strong style={{ color:'#6a8a6a' }}>Give</strong> / <strong style={{ color:'#8a6a6a' }}>Collect</strong> on each player. Remove kicks a disconnected seat.
              </div>
            </div>
          )}
          {roomPlayers.map(p => (
            <div key={p.socketId} style={{ fontSize:11, color: p.socketId === myId ? GLD : '#888', padding:'6px 0', borderBottom:'1px solid #141414' }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:4, marginBottom:4 }}>
                <div style={{ display:'flex', alignItems:'center', gap:5, minWidth:0 }}>
                  <div style={{ width:5, height:5, borderRadius:'50%', background:'#5dbb5d', flexShrink:0 }} />
                  <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.name}{p.socketId === myId ? ' ✦' : ''}</span>
                </div>
                {isHost && p.socketId !== myId && (
                  <button type="button" onClick={() => requestRemovePlayer(p.name, p.socketId)}
                    style={{ background:'transparent', border:'1px solid #6a3a3a', borderRadius:4, color:'#c07070', fontSize:9, padding:'2px 6px', cursor:'pointer', fontFamily:'sans-serif', flexShrink:0 }}>
                    Remove
                  </button>
                )}
              </div>
              <div style={{ fontSize:10, color:'#555', fontVariantNumeric:'tabular-nums' }}>Stack ${p.stack?.toLocaleString?.() ?? p.stack}</div>
              {isHost && (
                <div style={{ display:'flex', gap:4, marginTop:6, flexWrap:'wrap' }}>
                  <button type="button" onClick={() => hostAssignChips(p.socketId, hostAssignAmt)}
                    style={{ background:'rgba(26,58,42,0.5)', border:'1px solid #2a5a3a', borderRadius:4, color:'#7dcc7d', fontSize:9, padding:'3px 8px', cursor:'pointer', fontFamily:'sans-serif' }}>
                    Give
                  </button>
                  <button type="button" onClick={() => hostAssignChips(p.socketId, -Math.abs(Math.trunc(Number(hostAssignAmt)) || 0))}
                    style={{ background:'rgba(58,26,26,0.4)', border:'1px solid #5a2a2a', borderRadius:4, color:'#d08080', fontSize:9, padding:'3px 8px', cursor:'pointer', fontFamily:'sans-serif' }}>
                    Collect
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}