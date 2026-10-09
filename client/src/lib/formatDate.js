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
// Jour d'une date métier pour les mentions au fil du texte. Toute date affichée
// est en YYYY-MM-DD (demande de Pierre-Alexandre Papillon, 2026-10-05) : on ne
// rend plus « 2 sept. ».
export function fmtDayShort(d) {
  const s = String(d || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '—'
}

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

// Heure seule au format HH:MM (24h). Utile quand le jour est déjà porté par un
// séparateur (fil d'interactions) : répéter la date sur chaque entrée est du bruit.
// Renvoie '' si la valeur n'a pas de composante horaire.
export function fmtTime(d) {
  if (!d) return ''
  const s = typeof d === 'string' ? d : ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return ''
  const dt = new Date(d)
  if (isNaN(dt)) return ''
  return `${pad(dt.getHours())}:${pad(dt.getMinutes())}`
}

// Formats de date proposés à l'utilisateur pour l'affichage d'un champ date
// (cf. « Champs personnalisés » du CLAUDE.md). Stockés dans `options.format`
// d'un champ custom, au même titre que le format d'un champ duration.
// Toujours YYYY-MM-DD [HH:MM] : les anciens formats (« 20 août 2026 »,
// « 2:05 PM ») encore stockés retombent sur leur équivalent ISO 24 h.
export const DATE_DISPLAY_FORMATS = [
  { value: 'iso_date',      label: 'ISO — date seule',      hint: '2026-08-20' },
  { value: 'iso_24h',       label: 'ISO + heure 24 h',       hint: '2026-08-20 14:05' },
]
const LEGACY_DATE_FORMATS = { local_date: 'iso_date', local_datetime: 'iso_24h', iso_12h: 'iso_24h' }

export function normalizeDateFormat(fmt) {
  if (LEGACY_DATE_FORMATS[fmt]) return LEGACY_DATE_FORMATS[fmt]
  return DATE_DISPLAY_FORMATS.some(f => f.value === fmt) ? fmt : 'iso_date'
}

// Le format choisi montre-t-il l'heure ? Si oui, la saisie du champ propose
// aussi l'heure (sinon le format « + heure » n'aurait rien à afficher).
export function dateFormatHasTime(fmt) {
  const f = normalizeDateFormat(fmt)
  return f === 'iso_24h'
}

// Valeur stockée → valeur d'un <input type="datetime-local"> (YYYY-MM-DDTHH:MM,
// fuseau du navigateur). Une date métier sans heure part à minuit.
export function toDateTimeLocalInput(v) {
  if (!v) return ''
  const s = String(v)
  const dateOnly = s.match(/^(\d{4}-\d{2}-\d{2})$/) || s.match(/^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?Z$/)
  if (dateOnly) return `${dateOnly[1]}T00:00`
  const dt = new Date(s)
  if (isNaN(dt)) return ''
  return `${ymdLocal(dt)}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`
}

// Saisie datetime-local → ISO avec le décalage local (« 2026-08-20T20:00:00-04:00 »).
// Pas de `toISOString()` : 20 h à Montréal = minuit UTC, que fmtDate prendrait
// pour une date sans heure (encodage Airtable).
export function fromDateTimeLocalInput(s) {
  if (!s) return ''
  const dt = new Date(s)
  if (isNaN(dt)) return ''
  const off = -dt.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${ymdLocal(dt)}T${pad(dt.getHours())}:${pad(dt.getMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

// Rendu d'une date selon le format choisi par l'utilisateur. Une valeur
// « date métier » sans composante horaire (YYYY-MM-DD, ou minuit UTC encodé
// par Airtable) n'a pas d'heure à afficher : les variantes avec heure
// replient sur leur équivalent sans heure. On extrait directement les champs
// Y/M/D de la chaîne plutôt que de passer par `new Date()`, pour la même
// raison que fmtDate : éviter le décalage d'un jour au rendu en fuseau local.
// `dateOnlyAsMidnight` : une date sans heure s'affiche à 00:00 dans les formats
// « + heure » au lieu de replier sur la date seule.
export function fmtDateWithFormat(d, format, { dateOnlyAsMidnight = false } = {}) {
  if (!d) return '—'
  const fmt = normalizeDateFormat(format)
  if (fmt === 'iso_date') return fmtDate(d)
  const s = typeof d === 'string' ? d : ''
  const dateOnlyMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/) || s.match(/^(\d{4})-(\d{2})-(\d{2})T00:00:00(?:\.0+)?Z$/)
  let dt
  if (dateOnlyMatch) {
    const [, y, m, day] = dateOnlyMatch
    if (dateOnlyAsMidnight && dateFormatHasTime(fmt)) {
      dt = new Date(Number(y), Number(m) - 1, Number(day))
    } else return fmtDate(d)
  } else dt = new Date(d)
  if (isNaN(dt)) return '—'
  if (fmt === 'iso_24h') return `${ymdLocal(dt)} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`
  return fmtDate(d)
}
