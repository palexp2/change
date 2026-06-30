// Miroir client de server/src/services/vacationBalance.js — garder les deux
// identiques. Calcule le solde de vacances payées pour un affichage instantané
// sans aller-retour serveur.

// Jours ouvrables (lundi→vendredi) d'une période [start, end] inclusive, bornée
// à l'année civile `year`. Dates en 'YYYY-MM-DD'. 0 si borne manquante, plage
// inversée, ou intersection vide avec l'année.
export function businessDaysInYear(start, end, year) {
  if (!start || !end) return 0
  const yStart = `${year}-01-01`
  const yEnd = `${year}-12-31`
  const s = start < yStart ? yStart : start
  const e = end > yEnd ? yEnd : end
  if (e < s) return 0
  const sd = new Date(`${s}T00:00:00Z`)
  const ed = new Date(`${e}T00:00:00Z`)
  if (isNaN(sd) || isNaN(ed)) return 0
  let count = 0
  for (const d = new Date(sd); d <= ed; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay()
    if (wd !== 0 && wd !== 6) count++
  }
  return count
}

// Solde de vacances payées à partir des périodes (rows) et du droit annuel.
// Seules les périodes `paid` décomptent. allowance en jours.
export function vacationBalance(rows, allowance, year = new Date().getFullYear()) {
  let used = 0
  for (const r of rows || []) {
    if (!r.paid) continue
    used += businessDaysInYear(r.start_date, r.end_date, year)
  }
  used = Math.round(used * 100) / 100
  const alw = Number(allowance) || 0
  const remaining = Math.round((alw - used) * 100) / 100
  return { year, allowance: alw, used_days: used, remaining, over_limit: remaining < 0 }
}
