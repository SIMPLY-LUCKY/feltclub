import { useState, useEffect, useRef } from 'react'
import socket from './socket'

// ─── Constants ───────────────────────────────────────────────────────────────
const RS = { 2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'T',11:'J',12:'Q',13:'K',14:'A' }
const SS = { h:'♥', d:'♦', c:'♣', s:'♠' }
const RED = new Set(['h','d'])
const GLD = '#c9a84c', FELT = '#1a3a2a', RAIL = '#2a1a0a'
const TABLE_ID = 'main-table'  // everyone joins the same table for now

// ─── Card component ───────────────────────────────────────────────────────────
function Card({ card, sm, back }) {
  const w = sm ? 24 : 42, h = sm ? 34 : 58
  const base = {
    width: w, height: h, borderRadius: 4, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', flexShrink: 0, userSelect: 'none'
  }
  if (back) return (
    <div style={{ ...base, background: '#1a3a8a', border: '1px solid #243a7a', position: 'relative' }}>
      <div style={{ position: 'absolute', inset: 2, border: '1px solid rgba(255,255,255,0.18)', borderRadius: 2 }} />
    </div>
  )
  if (!card) return <div style={{ ...base, background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(255,255,255,0.1)' }} />
  const red = RED.has(card.s)
  return (
    <div style={{ ...base, background: '#fff', border: '1px solid #ccc' }}>
      <span style={{ fontSize: sm ? 9 : 15, fontWeight: 700, color: red ? '#c0392b' : '#111', lineHeight: 1 }}>{RS[card.r]}</span>
      <span style={{ fontSize: sm ? 8 : 13, color: red ? '#c0392b' : '#111', lineHeight: 1 }}>{SS[card.s]}</span>
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
  const [connected, setConnected] = useState(false)
  const [isHost, setIsHost]       = useState(false)
  const [game, setGame]           = useState(null)
  const [myCards, setMyCards]     = useState([])
  const [allCards, setAllCards]   = useState({})
  const [roomPlayers, setRoomPlayers] = useState([])
  const [raise, setRaise]         = useState(40)
  const [error, setError]         = useState('')
  const logRef = useRef(null)

  useEffect(() => {
    socket.on('connect',    () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))

    socket.on('room_update', ({ players, game, hostId }) => {
      setRoomPlayers(players)
      setGame(game)
      setIsHost(socket.id === hostId)
      if (game?.currentBet) setRaise(Math.max(game.currentBet * 2, game.currentBet + 20))
    })

    socket.on('your_cards', (cards) => setMyCards(cards))
    socket.on('all_cards',  (hands) => setAllCards(hands))
    socket.on('error_msg',  (msg)   => { setError(msg); setTimeout(() => setError(''), 3000) })

    return () => {
      socket.off('connect'); socket.off('disconnect')
      socket.off('room_update'); socket.off('your_cards')
      socket.off('all_cards'); socket.off('error_msg')
    }
  }, [])

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [game?.log])

  function joinTable() {
    if (!nameInput.trim()) return
    setMyName(nameInput)
    socket.emit('join_table', { tableId: TABLE_ID, playerName: nameInput })
    setScreen('table')
  }

  function doAction(type, amount) {
    socket.emit('player_action', { tableId: TABLE_ID, action: { type, amount } })
  }

  // Find my player in the game
  const myId = socket.id
  const myGamePlayer = game?.players?.find(p => p.socketId === myId)
  const callAmt = Math.max(0, (game?.currentBet || 0) - (myGamePlayer?.streetBet || 0))
  const isMyTurn = game?.players?.[game?.currentPlayer]?.socketId === myId
  const canAct = isMyTurn && game?.phase !== 'idle' && game?.phase !== 'showdown'
  const maxRaise = (myGamePlayer?.stack || 0) + (myGamePlayer?.streetBet || 0)
  const minRaise = Math.min(Math.max((game?.currentBet || 0) * 2, (game?.currentBet || 0) + 20), maxRaise)

  // Get hole cards for a player (host sees all, players see only theirs)
  function getCards(p) {
    if (!game) return []
    if (p.socketId === myId) return myCards
    if (isHost && allCards[p.socketId]) return allCards[p.socketId]
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
        <input
          autoFocus
          placeholder="Your name"
          value={nameInput}
          onChange={e => setNameInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && joinTable()}
          style={{ width:'100%', background:'#111', border:'1px solid #333', borderRadius:8, color:'#e8e0d0', padding:'10px 14px', fontSize:14, marginBottom:12, outline:'none', boxSizing:'border-box' }}
        />
        <button onClick={joinTable} style={{ width:'100%', background:GLD, border:'none', borderRadius:8, color:'#1a1a1a', padding:'11px 0', fontSize:14, fontWeight:700, cursor:'pointer' }}>
          Join table →
        </button>
      </div>
    </div>
  )

  // ── TABLE ──────────────────────────────────────────────────────────────────
  const players = game?.players || roomPlayers.map((p, i) => ({ ...p, seat: i, folded: false, holeCards: [] }))

  return (
    <div style={{ background:'#0a0a0a', minHeight:'100vh', fontFamily:'sans-serif', color:'#e8e0d0', padding:14, display:'flex', flexDirection:'column', gap:10 }}>

      {/* Top bar */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div style={{ display:'flex', alignItems:'baseline', gap:10 }}>
          <span style={{ fontSize:18, fontWeight:700, color:GLD, letterSpacing:2 }}>
            FELT<span style={{ color:'#666', fontWeight:400 }}>CLUB</span>
          </span>
          <span style={{ fontSize:11, color:'#444' }}>NL Hold'em · $10/$20</span>
          {isHost && <span style={{ fontSize:10, background:'#2a1a0a', color:GLD, border:`1px solid ${GLD}44`, borderRadius:10, padding:'2px 8px' }}>HOST</span>}
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          {/* Host controls */}
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
              {game?.phase === 'showdown' ? 'Next hand →' : 'Deal hand →'}
            </button>
          )}
          {!isHost && !game && (
            <span style={{ fontSize:12, color:'#555' }}>Waiting for host to deal…</span>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && <div style={{ background:'#2a1a1a', border:'1px solid #6a3a3a', borderRadius:8, padding:'8px 14px', fontSize:13, color:'#e07070' }}>{error}</div>}

      {/* Waiting for players */}
      {roomPlayers.length < 2 && !game && (
        <div style={{ background:'#111', border:'1px solid #222', borderRadius:10, padding:20, textAlign:'center', color:'#555', fontSize:13 }}>
          <div style={{ fontSize:20, marginBottom:8 }}>🃏</div>
          Share this with your friends to join:<br />
          <span style={{ color:GLD, fontSize:12, fontFamily:'monospace' }}>http://localhost:5173</span>
          <div style={{ marginTop:10, color:'#3a3a3a', fontSize:12 }}>{roomPlayers.length} / 6 players joined</div>
        </div>
      )}

      {/* Table */}
      <div style={{ position:'relative', height:430, flexShrink:0 }}>
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
          {/* Community cards */}
          <div style={{ display:'flex', gap:5 }}>
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
              <div style={{ display:'flex', gap:2 }}>
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
            </div>
          )
        })}
      </div>

      {/* Action bar */}
      <div style={{ minHeight:52 }}>
        {canAct ? (
          <div style={{ display:'flex', gap:8, alignItems:'center', padding:'9px 12px', background:'#141414', borderRadius:8, border:'1px solid #1e1e1e', flexWrap:'wrap' }}>
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
          <div style={{ padding:'10px 14px', background:'#111', borderRadius:8, fontSize:11, color:'#383838', border:'1px solid #161616', minHeight:52, display:'flex', alignItems:'center' }}>
            {!game ? 'Waiting for host to start the game…'
              : game.phase === 'idle' ? 'Hand over — waiting for next hand…'
              : game.phase === 'showdown' ? 'Showdown! Waiting for next hand…'
              : `Waiting for ${game.players?.[game.currentPlayer]?.name || '...'}…`}
          </div>
        )}
      </div>

      {/* Log + players online */}
      <div style={{ display:'flex', gap:10 }}>
        <div ref={logRef} style={{ flex:1, background:'#0d0d0d', borderRadius:8, padding:'8px 12px', height:80, overflowY:'auto', fontSize:11, lineHeight:2, border:'1px solid #161616' }}>
          {(game?.log || ['Waiting for game to start…']).map((l, i, a) => (
            <div key={i} style={{ color: l.startsWith('──') ? '#3a6a3a' : i >= a.length - 3 ? '#999' : '#3e3e3e', fontWeight: l.startsWith('──') ? 600 : 400 }}>{l}</div>
          ))}
        </div>
        <div style={{ width:140, background:'#0d0d0d', borderRadius:8, padding:'8px 10px', border:'1px solid #161616' }}>
          <div style={{ fontSize:10, color:'#444', textTransform:'uppercase', letterSpacing:0.8, marginBottom:6 }}>Online — {roomPlayers.length}</div>
          {roomPlayers.map(p => (
            <div key={p.socketId} style={{ fontSize:11, color: p.socketId === myId ? GLD : '#666', padding:'2px 0', display:'flex', alignItems:'center', gap:5 }}>
              <div style={{ width:5, height:5, borderRadius:'50%', background:'#5dbb5d', flexShrink:0 }} />
              {p.name}{p.socketId === myId ? ' ✦' : ''}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
