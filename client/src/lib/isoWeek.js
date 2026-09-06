// Bucketing hebdomadaire — même convention que les graphiques du dashboard.
//
// Les séries hebdomadaires du serveur sont bucketées en SQLite avec
// `date(col, '-' || ((strftime('%w', col) + 6) % 7) || ' days')`, c'est-à-dire
// le LUNDI de la semaine, calculé sur la valeur stockée (UTC). On reproduit
// exactement ce calcul côté client — en UTC et sur la seule partie date de la
// valeur — pour que le filtre « semaine du … » d'une liste retienne les mêmes
// records que la barre cliquée sur le graphique.

/** Lundi (YYYY-MM-DD) de la semaine d'une date ISO, ou null si illisible. */
export function weekStartOf(value) {
  if (!value) return null
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

/** Libellé humain d'un lundi de semaine (« 24 août 2026 »). */
export function fmtWeekStart(weekKey) {
  if (!weekKey) return ''
  const d = new Date(`${String(weekKey).slice(0, 10)}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return String(weekKey)
  return d.toLocaleDateString('fr-CA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}
