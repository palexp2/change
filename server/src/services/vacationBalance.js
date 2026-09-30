import db from '../db/database.js'

// Salaire brut d'une ligne de paie, base de l'accumulation des vacances :
// heures régulières ET fériées × taux, férié 1/20, paie de vacances, commission.
// Les remboursements de dépenses n'en sont pas. Une paie de vacances fait donc
// elle-même croître la banque (pour les vacances suivantes).
const GROSS_SQL = `
  COALESCE(pi.hourly_rate, 0) * (COALESCE(pi.regular_hours, 0) + COALESCE(pi.holiday_hours, 0))
  + COALESCE(pi.holiday_1_20, 0) + COALESCE(pi.vacation, 0) + COALESCE(pi.commission, 0)`

// Date d'une ligne de paie : fin de période de la paie, sinon début de la ligne.
const ITEM_DATE_SQL = `COALESCE(p.period_end, pi.start_date)`

// Banque de vacances d'un employé, en dollars.
// Sans point de référence : Σ (brut de chaque paie × %) − paies de vacances
// versées (`paie_items.vacation`).
// Avec point de référence (« au 2026-09-24, la banque valait X $ ») : X + la
// même somme limitée aux paies postérieures à cette date. Le % a changé dans le
// passé sans historique : seul le point de référence fait foi pour l'avant.
// `since` (facultatif) remplace la date enregistrée — la fiche l'envoie pendant
// la saisie, avant que l'autosave ne l'ait écrite.
// `gross` et `paid_out` sont renvoyés tels quels pour que la fiche recalcule
// la banque à l'instant où l'on change le % ou le montant de référence.
// Retourne null si l'employé n'existe pas.
export function vacationBalance(employeeId, since) {
  const emp = db.prepare('SELECT vacation_pct, vacation_ref_date, vacation_ref_balance FROM employees WHERE id = ?').get(employeeId)
  if (!emp) return null
  const refDate = (since === undefined ? emp.vacation_ref_date : since) || null
  const sums = db.prepare(`
    SELECT COALESCE(SUM(${GROSS_SQL}), 0) AS gross,
           COALESCE(SUM(COALESCE(pi.vacation, 0)), 0) AS paid_out
      FROM paie_items pi LEFT JOIN paies p ON p.id = pi.paie_id
     WHERE pi.employee_id = ?
       ${refDate ? `AND ${ITEM_DATE_SQL} > ?` : ''}
  `).get(employeeId, ...(refDate ? [refDate] : []))
  const pct = Number(emp.vacation_pct) || 0
  const r2 = n => Math.round(n * 100) / 100
  const refBalance = refDate ? r2(Number(emp.vacation_ref_balance) || 0) : 0
  const accrued = r2(sums.gross * pct / 100)
  const balance = r2(refBalance + accrued - sums.paid_out)
  return {
    pct, gross: r2(sums.gross), accrued, paid_out: r2(sums.paid_out),
    ref_date: refDate, ref_balance: refBalance,
    balance, over_limit: balance < 0,
  }
}
