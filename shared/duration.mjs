// Lecture des durées saisies — partagé client / serveur. Le FORMATAGE reste
// propre à chaque côté (le client affiche les heures sur 2 chiffres « 08:30 »,
// le serveur produit « 8:30 » pour les conversions de type et les formules).

// Saisie → MINUTES (banque d'heures, feuille de temps). Accepte :
//  - "90"   → 90      - "1:30" → 90     - "1h30" → 90     - "30m" → 30
//  - "1.5"  → 90 (heures décimales)     - number → minutes - null / "" → 0
// Retourne un entier de minutes, ou null si non parseable.
export function parseDurationToMinutes(input) {
  if (input == null || input === '') return 0
  if (typeof input === 'number' && Number.isFinite(input)) {
    return Math.max(0, Math.round(input))
  }
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

// ── Durées en secondes (type de champ personnalisé « Duration ») ─────────────
// Les champs custom de type 'duration' stockent des SECONDES (REAL) pour offrir
// la parité Airtable avec un affichage hh:mm:ss.

// Formats d'affichage supportés ; toute valeur hors liste retombe sur 'h:mm'.
export const DURATION_FORMATS = ['h:mm', 'h:mm:ss']
export function normalizeDurationFormat(fmt) {
  return DURATION_FORMATS.includes(fmt) ? fmt : 'h:mm'
}

// Saisie → SECONDES. Le découpage par « : » suit le NOMBRE de segments, quel
// que soit le format d'affichage : « 1:30 » = 1h30, « 1:30:45 » = 1h30m45s.
//  - "1:30:45" → 5445   - "1:30" → 5400   - "1h30" → 5400   - "30m" → 1800
//  - "45s" → 45         - "1.5" → 5400 (heures décimales)
//  - "90" → 5400 (entier nu = minutes, cohérent avec la banque d'heures)
//  - number → secondes (valeur déjà stockée)   - null / "" → 0
// Retourne un entier de secondes, ou null si non parseable.
export function parseDurationToSeconds(input) {
  if (input == null || input === '') return 0
  if (typeof input === 'number' && Number.isFinite(input)) {
    return Math.max(0, Math.round(input))
  }
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
