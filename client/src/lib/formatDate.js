function pad(n) {
  return String(n).padStart(2, '0')
}

// YYYY-MM-DD dans le fuseau du navigateur.
function ymdLocal(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// YYYY-MM-DD en UTC (pour les dates métier encodées minuit UTC par Airtable).
function ymdUTC(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

// Format d'affichage unifié des dates : YYYY-MM-DD.
export function fmtDate(d) {
  if (!d) return '—'
  const s = typeof d === 'string' ? d : ''
  // Déjà "YYYY-MM-DD" — date métier sans composante horaire : rendue telle quelle.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  // Pattern "YYYY-MM-DDT00:00:00[.000]Z" — encodage Airtable d'un champ date-only :
  // l'utilisateur a choisi un jour calendaire qu'Airtable stocke comme minuit UTC.
  // Le rendre dans le fuseau du navigateur le décale d'un jour (ex. minuit UTC du
  // 1er avril → 31 mars 20h à Montréal). On force le rendu en UTC pour préserver
  // la date du sélecteur. Les vrais timestamps `new Date().toISOString()` ont des
  // millisecondes non nulles donc ne matchent pas.
  if (/^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?Z$/.test(s)) {
    return ymdUTC(new Date(s))
  }
  const dt = new Date(d)
  if (isNaN(dt)) return '—'
  return ymdLocal(dt)
}

// Date locale (fuseau du navigateur) au format YYYY-MM-DD.
// NE PAS utiliser `new Date().toISOString().slice(0, 10)` pour ça : ça renvoie l'UTC,
// donc à 23:00 EST le jour J, on obtient J+1 — les défauts de formulaires (date
// d'écriture comptable, date de paiement, etc.) partent au lendemain.
export function localISODate(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Format d'affichage unifié des dates+heures : YYYY-MM-DD HH:MM (24h, sans secondes).
export function fmtDateTime(d) {
  if (!d) return '—'
  const s = typeof d === 'string' ? d : ''
  // Date métier sans heure : pas de composante horaire à afficher.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const dt = new Date(d)
  if (isNaN(dt)) return '—'
  return `${ymdLocal(dt)} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`
}

// Formats de date proposés à l'utilisateur pour l'affichage d'un champ date
// (cf. « Champs personnalisés » du CLAUDE.md). Stockés dans `options.format`
// d'un champ custom, au même titre que le format d'un champ duration.
export const DATE_DISPLAY_FORMATS = [
  { value: 'iso_date',      label: 'ISO — date seule',      hint: '2026-08-20' },
  { value: 'iso_24h',       label: 'ISO + heure 24 h',       hint: '2026-08-20 14:05' },
  { value: 'iso_12h',       label: 'ISO + heure 12 h',       hint: '2026-08-20 2:05 PM' },
  { value: 'local_date',    label: 'Locale — date seule',    hint: '20 août 2026' },
  { value: 'local_datetime', label: 'Locale + heure',         hint: '20 août 2026, 14 h 05' },
]

export function normalizeDateFormat(fmt) {
  return DATE_DISPLAY_FORMATS.some(f => f.value === fmt) ? fmt : 'iso_date'
}

const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

// Rendu d'une date selon le format choisi par l'utilisateur. Une valeur
// « date métier » sans composante horaire (YYYY-MM-DD, ou minuit UTC encodé
// par Airtable) n'a pas d'heure à afficher : les variantes avec heure
// replient sur leur équivalent sans heure. On extrait directement les champs
// Y/M/D de la chaîne plutôt que de passer par `new Date()`, pour la même
// raison que fmtDate : éviter le décalage d'un jour au rendu en fuseau local.
export function fmtDateWithFormat(d, format) {
  if (!d) return '—'
  const fmt = normalizeDateFormat(format)
  if (fmt === 'iso_date') return fmtDate(d)
  const s = typeof d === 'string' ? d : ''
  const dateOnlyMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/) || s.match(/^(\d{4})-(\d{2})-(\d{2})T00:00:00(?:\.0+)?Z$/)
  if (dateOnlyMatch) {
    if (fmt !== 'local_date' && fmt !== 'local_datetime') return fmtDate(d)
    const [, y, m, day] = dateOnlyMatch
    return `${parseInt(day, 10)} ${MONTHS_FR[parseInt(m, 10) - 1]} ${y}`
  }
  const dt = new Date(d)
  if (isNaN(dt)) return '—'
  if (fmt === 'iso_24h') return `${ymdLocal(dt)} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`
  if (fmt === 'iso_12h') {
    let h = dt.getHours()
    const ampm = h >= 12 ? 'PM' : 'AM'
    h = h % 12 || 12
    return `${ymdLocal(dt)} ${h}:${pad(dt.getMinutes())} ${ampm}`
  }
  if (fmt === 'local_date') return dt.toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' })
  if (fmt === 'local_datetime') return dt.toLocaleString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return fmtDate(d)
}
