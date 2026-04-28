// Parse a duration input to minutes.
// Accepts:
//  - "90"        → 90 minutes
//  - "1:30"      → 90 minutes
//  - "1h30"      → 90 minutes
//  - "1.5"       → 90 minutes (hours as decimal)
//  - number      → interpreted as minutes
//  - null / ""   → 0
// Returns an integer number of minutes, or null if the input is unparseable.
export function parseDurationToMinutes(input) {
  if (input == null || input === '') return 0
  if (typeof input === 'number' && Number.isFinite(input)) {
    return Math.max(0, Math.round(input))
  }
  const raw = String(input).trim().toLowerCase()
  if (!raw) return 0

  // HH:MM or H:MM
  let m = /^(\d+):(\d{1,2})$/.exec(raw)
  if (m) {
    const h = parseInt(m[1], 10)
    const min = parseInt(m[2], 10)
    if (min >= 60) return null
    return h * 60 + min
  }
  // 1h30, 1h, 30m
  m = /^(\d+)h(\d{0,2})$/.exec(raw)
  if (m) {
    const h = parseInt(m[1], 10)
    const min = m[2] ? parseInt(m[2], 10) : 0
    if (min >= 60) return null
    return h * 60 + min
  }
  m = /^(\d+)m$/.exec(raw)
  if (m) return parseInt(m[1], 10)

  // 1.5 → hours decimal
  if (/^\d+\.\d+$/.test(raw)) {
    return Math.round(parseFloat(raw) * 60)
  }
  // bare integer → minutes
  if (/^\d+$/.test(raw)) {
    return parseInt(raw, 10)
  }
  return null
}

// Format minutes as H:MM (no leading zero on hours, always 2 digits on minutes).
export function formatMinutes(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return '0:00'
  const total = Math.max(0, Math.round(minutes))
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${h}:${String(m).padStart(2, '0')}`
}
