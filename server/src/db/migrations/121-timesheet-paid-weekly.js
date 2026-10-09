/**
 * 121 — « Payé à la semaine » (demande de Pierre-Alexandre Papillon,
 * 2026-10-08) : la feuille de temps de ces employés masque Début / Fin /
 * Pause / Total. Marqués d'office : ceux qui déclaraient un seul chiffre par
 * semaine avant la 120 (semaines mises à la corbeille par elle).
 */
export const id = '121-timesheet-paid-weekly'
export const description = 'users.timesheet_paid_weekly = 1 pour ceux qui saisissaient à la semaine'

export function up(db) {
  try { db.exec('ALTER TABLE users ADD COLUMN timesheet_paid_weekly INTEGER DEFAULT 0') } catch { /* déjà là */ }
  const { changes } = db.prepare(`
    UPDATE users SET timesheet_paid_weekly = 1
    WHERE id IN (SELECT DISTINCT user_id FROM timesheet_weeks)
  `).run()
  return { users: changes }
}
