// Parse duration text to minutes. Accepts "90", "1:30", "1h30", "1.5".
// Returns integer minutes, or null if unparseable (empty is 0).
export function parseDurationToMinutes(input) {
  if (input == null || input === '') return 0
  if (typeof input === 'number') return Math.max(0, Math.round(input))
  const raw = String(input).trim().toLowerCase()
  if (!raw) return 0
  let m = /^(\d+):(\d{1,2})$/.exec(raw)
  if (m) {
    const min = parseInt(m[2], 10)
    if (min >= 60) return null
    return parseInt(m[1], 10) * 60 + min
  }
  m = /^(\d+)h(\d{0,2})$/.exec(raw)
  if (m) {
    const min = m[2] ? parseInt(m[2], 10) : 0
    if (min >= 60) return null
    return parseInt(m[1], 10) * 60 + min
  }
  m = /^(\d+)m$/.exec(raw)
  if (m) return parseInt(m[1], 10)
  if (/^\d+\.\d+$/.test(raw)) return Math.round(parseFloat(raw) * 60)
  if (/^\d+$/.test(raw)) return parseInt(raw, 10)
  return null
}

// "1:30" format from minutes.
export function formatMinutes(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return '0:00'
  const total = Math.max(0, Math.round(minutes))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// Cumulate entries to compute an "end time" from 00:00. Returns H:MM strings.
export function cumulativeEndTimes(entries) {
  let acc = 0
  return entries.map(e => {
    acc += Number(e.duration_minutes) || 0
    return formatMinutes(acc)
  })
}

// ISO Monday-start week number (YYYY-Www) for grouping.
export function weekKey(dateStr) {
  // dateStr: 'YYYY-MM-DD'
  const d = new Date(dateStr + 'T00:00:00')
  // ISO week: Thursday in same week
  const target = new Date(d)
  const dayNr = (d.getDay() + 6) % 7
  target.setDate(d.getDate() - dayNr + 3)
  const firstThu = new Date(target.getFullYear(), 0, 4)
  const week = 1 + Math.round(((target - firstThu) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7)
  return `${target.getFullYear()}-W${String(week).padStart(2, '0')}`
}
