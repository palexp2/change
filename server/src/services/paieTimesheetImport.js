import { v4 as uuidv4 } from 'uuid'
import db from '../db/database.js'

// Calcule les bornes de la période de paie.
// Règle: paies de 14 jours. period_start = paie précédente.period_end + 1 jour si disponible,
// sinon period_end - 13 jours.
export function computePeriodBounds(paie) {
  const end = paie.period_end
  if (!end) return null
  if (paie.period_start) return { start: paie.period_start, end }
  const prev = db.prepare(`
    SELECT period_end FROM paies
    WHERE period_end IS NOT NULL AND period_end < ? AND id != ?
    ORDER BY period_end DESC LIMIT 1
  `).get(end, paie.id)
  let start
  if (prev?.period_end) {
    const d = new Date(prev.period_end + 'T00:00:00')
    d.setDate(d.getDate() + 1)
    start = d.toISOString().slice(0, 10)
  } else {
    const d = new Date(end + 'T00:00:00')
    d.setDate(d.getDate() - 13)
    start = d.toISOString().slice(0, 10)
  }
  return { start, end }
}

// Temps (en minutes) payables d'un user sur une plage [start, end] inclusive.
// - Mode detailed: somme des timesheet_entries dont activity_code.payable != 0 (null = payable)
// - Mode simple:  max(0, end_time - start_time - break_minutes)
function computePayableMinutes(userId, start, end) {
  const detailed = db.prepare(`
    SELECT COALESCE(SUM(te.duration_minutes), 0) as total
    FROM timesheet_entries te
    JOIN timesheet_days td ON te.day_id = td.id
    LEFT JOIN activity_codes ac ON te.activity_code_id = ac.id
    WHERE td.user_id = ?
      AND td.deleted_at IS NULL
      AND td.mode = 'detailed'
      AND td.date >= ? AND td.date <= ?
      AND (ac.payable IS NULL OR ac.payable = 1)
  `).get(userId, start, end).total

  const simpleDays = db.prepare(`
    SELECT start_time, end_time, break_minutes
    FROM timesheet_days
    WHERE user_id = ? AND mode = 'simple' AND deleted_at IS NULL
      AND date >= ? AND date <= ?
      AND start_time IS NOT NULL AND end_time IS NOT NULL
  `).all(userId, start, end)
  const toMin = (t) => {
    const [h, m] = String(t).split(':').map(n => parseInt(n, 10) || 0)
    return h * 60 + m
  }
  let simple = 0
  for (const d of simpleDays) {
    simple += Math.max(0, toMin(d.end_time) - toMin(d.start_time) - (Number(d.break_minutes) || 0))
  }
  return detailed + simple
}

// Importe les heures des feuilles de temps dans une paie donnée.
//   - Pour chaque paie_item (un par employé):
//     - Si l'employé a des heures régulières contractuelles (employees.hours_per_week > 0) OU
//       si paie_items.regular_hours est déjà saisi manuellement (>0): on garde regular_hours et
//       on enregistre la différence dans hour_bank_entries (excédent = +, déficit = -).
//     - Sinon, on écrase regular_hours avec le total des heures payables.
//   - Les précédentes entrées 'timesheet_import' pour cette paie sont supprimées (soft) avant le
//     recalcul, pour que la resynchronisation soit idempotente.
// Retourne un récap: { paie_id, period_start, period_end, results: [...] }
export function importTimesheetsForPaie(paieId) {
  const paie = db.prepare('SELECT * FROM paies WHERE id = ?').get(paieId)
  if (!paie) throw new Error('Paie introuvable')
  const bounds = computePeriodBounds(paie)
  if (!bounds) throw new Error('Paie sans period_end — impossible de calculer la période')
  const { start, end } = bounds

  // Persiste period_start si absent (bénin, cohérence des affichages)
  if (!paie.period_start) {
    db.prepare(`UPDATE paies SET period_start = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(start, paieId)
  }

  // Idempotence: on annule les anciennes entrées d'import pour cette paie
  db.prepare(`
    UPDATE hour_bank_entries
    SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE paie_id = ? AND source = 'timesheet_import' AND deleted_at IS NULL
  `).run(paieId)

  const items = db.prepare('SELECT * FROM paie_items WHERE paie_id = ?').all(paieId)
  const results = []
  const insertBank = db.prepare(`
    INSERT INTO hour_bank_entries (id, employee_id, paie_id, paie_item_id, date, hours, source, notes)
    VALUES (?, ?, ?, ?, ?, ?, 'timesheet_import', ?)
  `)
  const updateHours = db.prepare(`UPDATE paie_items SET regular_hours = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)

  db.transaction(() => {
    for (const item of items) {
      const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(item.employee_id)
      if (!employee) { results.push({ employee_id: item.employee_id, skipped: 'employee_not_found' }); continue }
      const user = db.prepare('SELECT id FROM users WHERE employee_id = ?').get(employee.id)
      if (!user) {
        results.push({ employee_id: employee.id, employee_name: [employee.first_name, employee.last_name].filter(Boolean).join(' '), skipped: 'no_user_link' })
        continue
      }
      const payableMinutes = computePayableMinutes(user.id, start, end)
      const totalHours = Math.round((payableMinutes / 60) * 100) / 100

      const contractualHours = Number(employee.hours_per_week) > 0
      if (contractualHours) {
        const diff = Math.round((totalHours - (Number(item.regular_hours) || 0)) * 100) / 100
        if (Math.abs(diff) > 0.009) {
          const bankId = uuidv4()
          const label = diff > 0 ? 'excédent' : 'déficit'
          insertBank.run(
            bankId, employee.id, paieId, item.id, end, diff,
            `Import feuilles de temps (${start} → ${end}): ${label} de ${Math.abs(diff).toFixed(2)}h ` +
            `(${totalHours.toFixed(2)}h réelles vs ${Number(item.regular_hours || 0).toFixed(2)}h en paie)`
          )
        }
        results.push({
          employee_id: employee.id,
          employee_name: [employee.first_name, employee.last_name].filter(Boolean).join(' '),
          mode: 'bank',
          timesheet_hours: totalHours,
          regular_hours: Number(item.regular_hours) || 0,
          bank_diff: diff,
        })
      } else {
        updateHours.run(totalHours, item.id)
        results.push({
          employee_id: employee.id,
          employee_name: [employee.first_name, employee.last_name].filter(Boolean).join(' '),
          mode: 'direct',
          timesheet_hours: totalHours,
          regular_hours: totalHours,
        })
      }
    }
  })()

  return { paie_id: paieId, period_start: start, period_end: end, results }
}
