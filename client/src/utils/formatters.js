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

// Taille de fichier lisible, base 1024, unités françaises (o, Ko, Mo, Go).
export function formatBytes(bytes) {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} Mo`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} Go`
}

// Numéro de téléphone nord-américain : « (418) 555-1234 ». Retourne '' pour
// une valeur vide, et la valeur telle quelle si elle n'a pas 10 chiffres
// (après retrait d'un éventuel préfixe 1).
export function fmtPhone(val) {
  if (!val) return ''
  const digits = String(val).replace(/\D/g, '')
  const d = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
  return val
}

// Adresse postale sur une ligne : « 123 rue X, Québec, QC, G1S 2P1, Canada ».
// Retourne '' si l'objet est absent ou n'a aucune composante.
export function fmtAddress(a) {
  if (!a) return ''
  return [a.line1, a.city, a.province, a.postal_code, a.country].filter(Boolean).join(', ')
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
