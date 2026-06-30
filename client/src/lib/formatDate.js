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
