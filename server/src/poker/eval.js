/** 5-card hand strength for comparison (higher wins). */

function eval5(h) {
  const rs = h.map(c => c.r).sort((a, b) => b - a)
  const fl = h.map(c => c.s).every((s, _, a) => s === a[0])
  const fr = {}
  rs.forEach(r => {
    fr[r] = (fr[r] || 0) + 1
  })
  const fe = Object.entries(fr).sort((a, b) => b[1] - a[1] || b[0] - a[0])
  const cnt = fe.map(([, v]) => v)
  const byr = fe.map(([k]) => +k)
  const u = [...new Set(rs)].sort((a, b) => b - a)
  let st = false
  let sh = 0
  if (u.length === 5) {
    if (u[0] - u[4] === 4) {
      st = true
      sh = u[0]
    } else if (`${u}` === '14,5,4,3,2') {
      st = true
      sh = 5
    }
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

function cmpS(a, b) {
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0)
    if (d) return d
  }
  return 0
}

function* combk(arr, k, start = 0, prefix = []) {
  if (k === 0) {
    yield prefix
    return
  }
  for (let i = start; i <= arr.length - k; i++) {
    yield* combk(arr, k, i + 1, [...prefix, arr[i]])
  }
}

/** NLHE: best 5-card hand from any 2 hole + 5 board (7 choose 5). */
export function bestNLHE(hole, board) {
  const all = [...hole, ...board]
  let best = null
  for (const five of combk(all, 5)) {
    const s = eval5(five)
    if (!best || cmpS(s, best) > 0) best = s
  }
  return best
}

/**
 * PLO (PLO4/5/6): must use exactly 2 hole cards and exactly 3 board cards.
 * Tries all C(hole,2) × C(board,3) combinations and returns the strongest 5-card score.
 */
export function bestPLOHand(hole, board) {
  if (!hole || hole.length < 2 || !board || board.length < 3) return null
  let best = null
  for (const h2 of combk(hole, 2)) {
    for (const b3 of combk(board, 3)) {
      const s = eval5([...h2, ...b3])
      if (!best || cmpS(s, best) > 0) best = s
    }
  }
  return best
}

/** @deprecated Use bestPLOHand; kept for callers that still import bestOmaha. */
export function bestOmaha(hole, board) {
  return bestPLOHand(hole, board)
}

export function compareScores(a, b) {
  return cmpS(a, b)
}

export const HAND_NAMES = [
  'High card',
  'Pair',
  'Two pair',
  'Three of a kind',
  'Straight',
  'Flush',
  'Full house',
  'Four of a kind',
  'Straight flush',
]
