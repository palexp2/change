export const id = '076-timesheet-weeks-sunday'
export const description = 'Feuilles de temps : semaines du dimanche au samedi'

export function up(db) {
  // Les anciens totaux sont indivisibles : conserver leurs heures et leur ID,
  // en rattachant chaque lundi au dimanche précédent. Les journées ne bougent pas.
  // Le filtre rend aussi la migration idempotente.
  const result = db.prepare(`
    UPDATE timesheet_weeks
    SET week_start = date(week_start, '-1 day')
    WHERE strftime('%w', week_start) = '1'
  `).run()
  return { shifted: result.changes }
}
