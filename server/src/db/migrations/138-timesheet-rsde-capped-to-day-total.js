/**
 * 138 — RSDE d'une journée plafonné à son total payé.
 *
 * Une pause allongée après la saisie du RSDE laissait le RSDE plus long que la
 * journée (Antoine Lambert, 14 oct. 2026 : 4 h 44 de RSDE pour 3 h 44 payées,
 * « 127 % »). Le code rabote désormais à chaque modification de la journée
 * (capRdToDay, routes/timesheets.js) ; ceci répare l'existant de la même façon.
 */
import db from '../database.js'

export const id = '138-timesheet-rsde-capped-to-day-total'
export const description = 'Feuilles de temps : RSDE ramené au total payé de la journée'

const toMin = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))

export function up(migrationDb) {
  const d = migrationDb || db
  const days = d.prepare(`
    SELECT id, start_time, end_time, break_minutes FROM timesheet_days
    WHERE deleted_at IS NULL AND start_time IS NOT NULL AND end_time IS NOT NULL
  `).all()
  for (const day of days) {
    const total = Math.max(0, toMin(day.end_time) - toMin(day.start_time) - (Number(day.break_minutes) || 0))
    const lines = d.prepare('SELECT id, duration_minutes FROM timesheet_entries WHERE day_id = ? AND rsde = 1 ORDER BY sort_order DESC').all(day.id)
    let excess = lines.reduce((s, e) => s + (Number(e.duration_minutes) || 0), 0) - total
    for (const e of lines) {
      if (excess <= 0) break
      const cut = Math.min(excess, Number(e.duration_minutes) || 0)
      excess -= cut
      const mins = (Number(e.duration_minutes) || 0) - cut
      if (mins > 0) d.prepare(`UPDATE timesheet_entries SET duration_minutes = ?, rsde_start = NULL, rsde_end = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(mins, e.id)
      else d.prepare('DELETE FROM timesheet_entries WHERE id = ?').run(e.id)
    }
  }
}
