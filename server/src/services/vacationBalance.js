import db from '../db/database.js'

// Compte les jours ouvrables (lundi→vendredi) d'une période [start, end] inclusive,
// bornée à l'année civile `year`. Les dates sont en 'YYYY-MM-DD'. Retourne 0 si une
// borne manque, si la plage est inversée, ou si l'intersection avec l'année est vide.
// La logique miroir côté client vit dans client/src/lib/vacationBalance.js — garder
// les deux identiques.
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

// Solde de vacances payées d'un employé pour une année civile.
// Seules les périodes `paid = 1` décomptent du droit annuel.
// Retourne null si l'employé n'existe pas.
export function vacationBalance(employeeId, year = new Date().getFullYear()) {
  const emp = db.prepare('SELECT vacation_days_per_year FROM employees WHERE id = ?').get(employeeId)
  if (!emp) return null
  const rows = db.prepare('SELECT start_date, end_date, paid FROM vacations WHERE employee_id = ?').all(employeeId)
  let used = 0
  for (const r of rows) {
    if (!r.paid) continue
    used += businessDaysInYear(r.start_date, r.end_date, year)
  }
  used = Math.round(used * 100) / 100
  const allowance = Number(emp.vacation_days_per_year) || 0
  const remaining = Math.round((allowance - used) * 100) / 100
  return { year, allowance, used_days: used, remaining, over_limit: remaining < 0 }
}
