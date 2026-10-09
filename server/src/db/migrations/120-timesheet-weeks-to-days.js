/**
 * 120 — Les feuilles de temps « à la semaine » deviennent des journées.
 *
 * Demande de Guillaume (2026-10-08) : le total de chaque semaine est réparti
 * également du lundi au vendredi (reste en minutes donné aux premiers jours).
 * Chaque journée : début 09:00, fin = début + sa part, pause 0 — le total payé
 * de la semaine ne bouge pas. Les lignes d'activité de la semaine qui portent
 * des minutes passent au jour qu'elles représentent (sheet_date, sinon lundi).
 * Les semaines (vides comprises) sont ensuite mises à la corbeille, et la
 * préférence « semaine » revient à « simplifié ».
 * Copie de sauvegarde : uploads/backups/timesheet-weeks-2026-10-08.json.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { newRecordId } from '../../utils/recordId.js'

export const id = '120-timesheet-weeks-to-days'
export const description = 'feuilles de temps : semaines réparties en journées du lundi au vendredi'

const toTime = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function up(db) {
  const weeks = db.prepare('SELECT * FROM timesheet_weeks WHERE deleted_at IS NULL').all()
  const entriesOf = db.prepare('SELECT * FROM timesheet_week_entries WHERE week_id = ? ORDER BY sort_order, created_at')

  const backupDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../uploads/backups')
  fs.mkdirSync(backupDir, { recursive: true })
  fs.writeFileSync(path.join(backupDir, 'timesheet-weeks-2026-10-08.json'),
    JSON.stringify(weeks.map(w => ({ ...w, entries: entriesOf.all(w.id) })), null, 2))

  const dayOf = db.prepare('SELECT * FROM timesheet_days WHERE user_id = ? AND date = ? AND deleted_at IS NULL')
  const insDay = db.prepare(`INSERT INTO timesheet_days (id, user_id, date, mode, start_time, end_time, break_minutes)
    VALUES (?, ?, ?, 'simple', ?, ?, 0)`)
  const setClock = db.prepare(`UPDATE timesheet_days SET start_time = ?, end_time = ?, break_minutes = 0,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
  const insEntry = db.prepare(`INSERT INTO timesheet_entries (id, day_id, sort_order, description, activity_code_id, duration_minutes, rsde)
    VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM timesheet_entries WHERE day_id = ?), ?, ?, ?, ?)`)
  const trashWeek = db.prepare(`UPDATE timesheet_weeks SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)

  const ensureDay = (userId, date) => {
    const d = dayOf.get(userId, date)
    if (d) return d.id
    const idNew = newRecordId()
    insDay.run(idNew, userId, date, null, null)
    return idNew
  }

  let days = 0
  for (const w of weeks) {
    const total = Number(w.minutes) || 0
    if (total > 0) {
      const base = Math.floor(total / 5)
      for (let i = 0; i < 5; i++) {
        const share = base + (i < total % 5 ? 1 : 0)
        const date = addDays(w.week_start, i + 1) // week_start = dimanche
        const existing = dayOf.get(w.user_id, date)
        if (existing?.start_time && existing?.end_time) throw new Error(`journée ${date} déjà saisie (${w.user_id})`)
        const dayId = existing ? existing.id : ensureDay(w.user_id, date)
        setClock.run('09:00', toTime(9 * 60 + share), dayId)
        days++
      }
    }
    for (const e of entriesOf.all(w.id)) {
      if (!(Number(e.duration_minutes) > 0)) continue
      const dayId = ensureDay(w.user_id, e.sheet_date || addDays(w.week_start, 1))
      insEntry.run(newRecordId(), dayId, dayId, e.description, e.activity_code_id, e.duration_minutes, e.rsde)
    }
    trashWeek.run(w.id)
  }
  const prefs = db.prepare(`UPDATE users SET timesheet_default_mode = 'simple' WHERE timesheet_default_mode = 'week'`).run().changes
  return { weeks: weeks.length, days, prefs }
}
