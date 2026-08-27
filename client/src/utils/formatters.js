import { fmtDate } from '../lib/formatDate.js'

// ---- Formatage monétaire unifié ----
// Source unique de vérité pour l'affichage des montants. Remplace les ~48
// réimplémentations locales de `new Intl.NumberFormat('fr-CA', { style: 'currency', … })`.
//
// amount   : montant en unité principale (dollars), PAS en cents — diviser par 100 avant si besoin.
// currency : code ISO ('CAD' par défaut), normalisé en majuscules.
// opts :
//   - fallback             : valeur retournée pour un montant nul/invalide (défaut '—')
//   - zeroIsEmpty          : si true, 0 (et autres falsy) renvoie le fallback (défaut false → 0 est formaté)
//   - maximumFractionDigits / minimumFractionDigits : transmis à Intl tels quels
//   - locale               : force la locale (défaut 'fr-CA')
export function fmtMoney(amount, currency = 'CAD', opts = {}) {
  const { fallback = '—', zeroIsEmpty = false, maximumFractionDigits, minimumFractionDigits, locale = 'fr-CA' } = opts
  const num = Number(amount)
  if (amount == null || amount === '' || Number.isNaN(num)) return fallback
  if (zeroIsEmpty && !num) return fallback
  const intlOpts = { style: 'currency', currency: String(currency || 'CAD').toUpperCase() }
  if (maximumFractionDigits != null) intlOpts.maximumFractionDigits = maximumFractionDigits
  if (minimumFractionDigits != null) intlOpts.minimumFractionDigits = minimumFractionDigits
  try {
    return new Intl.NumberFormat(locale, intlOpts).format(num)
  } catch {
    // Code devise invalide → on retombe sur CAD plutôt que de jeter.
    return new Intl.NumberFormat(locale, { ...intlOpts, currency: 'CAD' }).format(num)
  }
}

// Raccourci pour le cas le plus courant : montant en dollars canadiens.
export function fmtCad(amount, opts = {}) {
  return fmtMoney(amount, 'CAD', opts)
}

// Pendant de fmtCad à la saisie : « 2 737,95 $ » → 2737.95. Accepte la virgule
// décimale (clavier fr-CA), les espaces (fines, insécables) et le symbole $.
// Retourne null si la saisie est vide ou illisible — jamais NaN.
export function parseAmountInput(value) {
  if (value == null) return null
  let s = String(value).replace(/[\s\u00a0\u202f$]/g, '')
  if (!s) return null
  // « 1 234,56 » / « 1.234,56 » → la virgule est le séparateur décimal.
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export function formatRelativeTime(dateStr) {
  if (!dateStr) return '—'
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'à l\'instant'
  if (mins < 60) return `il y a ${mins}min`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `il y a ${hrs}h`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `il y a ${days}j`
  return fmtDate(dateStr)
}
