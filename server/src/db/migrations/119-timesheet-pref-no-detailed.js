/**
 * 119 — Plus de mode « détaillé » dans les feuilles de temps (demande de
 * Guillaume, 2026-10-07) : la préférence de ceux qui l'avaient revient à
 * « simplifié ». Les journées elles-mêmes ont été converties par la 118.
 */
export const id = '119-timesheet-pref-no-detailed'
export const description = 'feuilles de temps : préférence « détaillé » ramenée à « simplifié »'

export function up(db) {
  const { changes } = db.prepare(`UPDATE users SET timesheet_default_mode = 'simple' WHERE timesheet_default_mode = 'detailed'`).run()
  const days = db.prepare(`UPDATE timesheet_days SET mode = 'simple' WHERE mode = 'detailed'`).run().changes
  return { users: changes, days }
}
