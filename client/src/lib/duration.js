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

// ── Durées en secondes (type de champ personnalisé « Duration ») ─────────────
// Miroir de server/src/services/duration.js. Les champs custom de type
// 'duration' stockent des SECONDES pour permettre un affichage hh:mm:ss.
export const DURATION_FORMATS = ['h:mm', 'h:mm:ss']
export function normalizeDurationFormat(fmt) {
  return DURATION_FORMATS.includes(fmt) ? fmt : 'h:mm'
}

// Parse une saisie de durée en SECONDES (voir le serveur pour les formats).
export function parseDurationToSeconds(input) {
  if (input == null || input === '') return 0
  if (typeof input === 'number' && Number.isFinite(input)) return Math.max(0, Math.round(input))
  const raw = String(input).trim().toLowerCase()
  if (!raw) return 0
  let m = /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(raw)
  if (m) {
    const min = parseInt(m[2], 10), sec = parseInt(m[3], 10)
    if (min >= 60 || sec >= 60) return null
    return parseInt(m[1], 10) * 3600 + min * 60 + sec
  }
  m = /^(\d+):(\d{1,2})$/.exec(raw)
  if (m) {
    const min = parseInt(m[2], 10)
    if (min >= 60) return null
    return parseInt(m[1], 10) * 3600 + min * 60
  }
  m = /^(\d+)h(\d{0,2})$/.exec(raw)
  if (m) {
    const min = m[2] ? parseInt(m[2], 10) : 0
    if (min >= 60) return null
    return parseInt(m[1], 10) * 3600 + min * 60
  }
  m = /^(\d+)m$/.exec(raw)
  if (m) return parseInt(m[1], 10) * 60
  m = /^(\d+)s$/.exec(raw)
  if (m) return parseInt(m[1], 10)
  if (/^\d+\.\d+$/.test(raw)) return Math.round(parseFloat(raw) * 3600)
  if (/^\d+$/.test(raw)) return parseInt(raw, 10) * 60
  return null
}

// Formate un nombre de secondes selon le format ('h:mm' ou 'h:mm:ss').
export function formatDurationSeconds(totalSeconds, format = 'h:mm') {
  const fmt = normalizeDurationFormat(format)
  if (totalSeconds == null || !Number.isFinite(Number(totalSeconds))) {
    return fmt === 'h:mm:ss' ? '0:00:00' : '0:00'
  }
  const total = Math.max(0, Math.round(Number(totalSeconds)))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (fmt === 'h:mm:ss') return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${h}:${String(m).padStart(2, '0')}`
}

// Durée courte en SECONDES pour l'affichage : « 3m 20s » / « 45s ».
// Retourne null pour 0/absent (l'appelant décide du fallback).
export function fmtDurationSeconds(s) {
  if (!s) return null
  const m = Math.floor(s / 60), sec = s % 60
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`
}

// Durée courte en MINUTES pour l'affichage : « 2h30m » / « 45m ».
// Retourne '—' pour 0/absent. Ne pas confondre avec fmtDurationSeconds.
export function fmtDurationMinutes(mins) {
  if (!mins) return '—'
  const h = Math.floor(mins / 60), m = mins % 60
  return h === 0 ? `${m}m` : `${h}h${m > 0 ? m + 'm' : ''}`
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
