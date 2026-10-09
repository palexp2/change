/**
 * 110 — Vue « Mois » par défaut pour ceux qui remplissent la feuille du Drive.
 *
 * Demande de Charles (2026-10-03) : la feuille de temps de Boréal montre,
 * pour les personnes qui ont un onglet dans la feuille mensuelle
 * feuille_de_temps_{mois}_{année}, la même grille (un jour par ligne : arrivée,
 * départ, pause, heures RSDE, description, projet), modifiable sur place. Les
 * autres gardent la vue Jour / Semaine.
 *
 * Qui : les comptes dont le nom est celui d'un onglet importé en septembre ou
 * octobre 2026 (rd_month_hours). Le choix reste ensuite à la personne
 * (bascule Jour | Semaine | Mois).
 */
export const id = '110-timesheet-month-mode-for-sheet-users'
export const description = 'users.timesheet_default_mode = month pour les personnes présentes dans la feuille R&D du Drive'

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()

export function up(db) {
  const names = new Set(db.prepare(`
    SELECT DISTINCT employee_name FROM rd_month_hours WHERE month >= '2026-09' AND deleted_at IS NULL
  `).all().map(r => norm(r.employee_name)))
  const set = db.prepare(`UPDATE users SET timesheet_default_mode = 'month' WHERE id = ?`)
  let updated = 0
  for (const u of db.prepare(`SELECT id, name FROM users WHERE deleted_at IS NULL`).all()) {
    if (names.has(norm(u.name))) { set.run(u.id); updated++ }
  }
  return { updated }
}
