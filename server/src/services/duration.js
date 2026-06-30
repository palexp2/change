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

// ── Durées au format secondes (type de champ personnalisé « Duration ») ──────
// Les champs custom de type 'duration' stockent des SECONDES (REAL) pour offrir
// la parité Airtable avec un affichage hh:mm:ss (et pas seulement h:mm comme la
// banque d'heures, qui reste en minutes via parseDurationToMinutes/formatMinutes).

// Formats d'affichage supportés. 'h:mm' = heures:minutes ; 'h:mm:ss' = avec les
// secondes. Toute valeur hors liste retombe sur 'h:mm'.
export const DURATION_FORMATS = ['h:mm', 'h:mm:ss']
export function normalizeDurationFormat(fmt) {
  return DURATION_FORMATS.includes(fmt) ? fmt : 'h:mm'
}

// Parse une saisie de durée en SECONDES. Le découpage par « : » est interprété
// selon le NOMBRE de segments, indépendamment du format d'affichage configuré —
// ainsi « 1:30 » = 1h30 et « 1:30:45 » = 1h30m45s quoi qu'il arrive. Accepte :
//  - "1:30:45"  → 5445  (h:mm:ss)
//  - "1:30"     → 5400  (h:mm)
//  - "1h30"     → 5400
//  - "30m"      → 1800
//  - "45s"      → 45
//  - "1.5"      → 5400  (heures décimales)
//  - "90"       → 5400  (entier nu = minutes, cohérent avec la banque d'heures)
//  - number     → interprété comme des secondes (valeur déjà stockée)
//  - null / ""  → 0
// Retourne un entier de secondes, ou null si non parseable.
export function parseDurationToSeconds(input) {
  if (input == null || input === '') return 0
  if (typeof input === 'number' && Number.isFinite(input)) {
    return Math.max(0, Math.round(input))
  }
  const raw = String(input).trim().toLowerCase()
  if (!raw) return 0

  // H:MM:SS
  let m = /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(raw)
  if (m) {
    const min = parseInt(m[2], 10), sec = parseInt(m[3], 10)
    if (min >= 60 || sec >= 60) return null
    return parseInt(m[1], 10) * 3600 + min * 60 + sec
  }
  // H:MM
  m = /^(\d+):(\d{1,2})$/.exec(raw)
  if (m) {
    const min = parseInt(m[2], 10)
    if (min >= 60) return null
    return parseInt(m[1], 10) * 3600 + min * 60
  }
  // 1h30, 1h
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

  // 1.5 → heures décimales
  if (/^\d+\.\d+$/.test(raw)) return Math.round(parseFloat(raw) * 3600)
  // entier nu → minutes
  if (/^\d+$/.test(raw)) return parseInt(raw, 10) * 60
  return null
}

// Formate un nombre de secondes selon le format ('h:mm' ou 'h:mm:ss'). Pas de
// zéro initial sur les heures ; toujours 2 chiffres sur minutes/secondes.
export function formatDurationSeconds(totalSeconds, format = 'h:mm') {
  const fmt = normalizeDurationFormat(format)
  if (totalSeconds == null || !Number.isFinite(Number(totalSeconds))) {
    return fmt === 'h:mm:ss' ? '0:00:00' : '0:00'
  }
  const total = Math.max(0, Math.round(Number(totalSeconds)))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (fmt === 'h:mm:ss') {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${h}:${String(m).padStart(2, '0')}`
}
