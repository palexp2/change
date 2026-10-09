/**
 * 118 — Les journées « détaillées » des feuilles de temps passent en simplifié.
 *
 * Demande de Guillaume (2026-10-07) : ne garder que Simplifié et Semaine. Pour
 * chaque journée détaillée :
 *   • début = heure de début de la première activité (09:00 si absente) ;
 *   • fin = début + toutes les lignes ; pause = lignes non payables — le total
 *     payé ne bouge pas (avant : somme des lignes payables) ;
 *   • les lignes R&D restent (fusionnées en une seule s'il y en a plusieurs,
 *     comme le mode simplifié les tient) ;
 *   • les lignes hors R&D disparaissent, regroupées dans `notes` de la journée.
 * Une journée qui avait déjà début ET fin les garde (c'était déjà le chiffre payé).
 * Copie de sauvegarde : uploads/backups/timesheet-detailed-2026-10-07.json.
 */
export const id = '118-timesheet-detailed-to-simple'
export const description = 'feuilles de temps : journées détaillées converties en simplifié, notes de journée'

const toMin = t => (t && /^\d{1,2}:\d{2}$/.test(t) ? Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]) : null)
const toTime = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const toDur = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`

export function up(db) {
  const cols = db.prepare(`SELECT name FROM pragma_table_info('timesheet_days')`).all().map(r => r.name)
  if (!cols.includes('notes')) db.exec('ALTER TABLE timesheet_days ADD COLUMN notes TEXT')

  const days = db.prepare(`SELECT * FROM timesheet_days WHERE mode = 'detailed' AND deleted_at IS NULL`).all()
  const entriesOf = db.prepare(`
    SELECT e.*, ac.name AS code_name, ac.payable
    FROM timesheet_entries e LEFT JOIN activity_codes ac ON ac.id = e.activity_code_id
    WHERE e.day_id = ? ORDER BY e.sort_order ASC, e.created_at ASC`)
  const del = db.prepare('DELETE FROM timesheet_entries WHERE id = ?')
  const mergeRd = db.prepare('UPDATE timesheet_entries SET duration_minutes = ?, description = ? WHERE id = ?')
  const setDay = db.prepare(`UPDATE timesheet_days SET mode = 'simple', start_time = ?, end_time = ?, break_minutes = ?, notes = ?,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)

  let converted = 0
  for (const d of days) {
    const entries = entriesOf.all(d.id)
    if (!entries.length) { setDay.run(d.start_time, d.end_time, d.break_minutes || 0, d.notes || null, d.id); converted++; continue }

    const total = entries.reduce((s, e) => s + (Number(e.duration_minutes) || 0), 0)
    const unpaid = entries.filter(e => e.payable === 0).reduce((s, e) => s + (Number(e.duration_minutes) || 0), 0)
    const keepClock = d.start_time && d.end_time
    const start = d.start_time || '09:00'
    const end = keepClock ? d.end_time : toTime(Math.min(toMin(start) + total, 23 * 60 + 59))
    const brk = keepClock ? (d.break_minutes || 0) : unpaid

    const rd = entries.filter(e => e.rsde)
    if (rd.length > 1) {
      const desc = [...new Set(rd.map(e => (e.description || '').trim()).filter(Boolean))].join(' · ') || null
      mergeRd.run(rd.reduce((s, e) => s + (Number(e.duration_minutes) || 0), 0), desc, rd[0].id)
      for (const e of rd.slice(1)) del.run(e.id)
    }
    const notes = entries.filter(e => !e.rsde).map(e => {
      del.run(e.id)
      const desc = (e.description || '').trim()
      if (e.payable === 0 && !desc) return null // simple pause : déjà dans « pause »
      return `${e.code_name || 'Autre'} ${toDur(Number(e.duration_minutes) || 0)}${desc ? ' — ' + desc : ''}`
    })
    setDay.run(start, end, brk, [d.notes, ...notes].filter(Boolean).join('\n') || null, d.id)
    converted++
  }
  return { converted }
}
