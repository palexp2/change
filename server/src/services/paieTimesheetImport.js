import db from '../db/database.js'
import { dayPayableMinutes } from './timesheetHours.js'

const normName = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()

// Compte Boréal d'un employé : le lien explicite, sinon le même nom.
export function userForEmployee(employee) {
  const linked = db.prepare('SELECT id, name FROM users WHERE employee_id = ?').get(employee.id)
  if (linked) return linked
  const target = normName(`${employee.first_name || ''} ${employee.last_name || ''}`)
  if (!target) return null
  return db.prepare('SELECT id, name FROM users WHERE name IS NOT NULL').all().find(u => normName(u.name) === target) || null
}

// L'employé a-t-il saisi quelque chose dans Boréal sur la période ? Sinon ses
// heures vivent ailleurs (Airtable) et on n'y touche pas.
export function hasTimesheetData(userId, start, end) {
  return !!db.prepare(`
    SELECT 1 FROM timesheet_days d WHERE d.user_id = ? AND d.deleted_at IS NULL AND d.date >= ? AND d.date <= ?
      AND ((d.start_time IS NOT NULL AND d.end_time IS NOT NULL) OR EXISTS (SELECT 1 FROM timesheet_entries e WHERE e.day_id = d.id AND e.duration_minutes > 0))
    UNION ALL
    SELECT 1 FROM timesheet_weeks w WHERE w.user_id = ? AND w.deleted_at IS NULL AND w.week_start >= ? AND w.week_start <= ? AND w.minutes > 0
    LIMIT 1
  `).get(userId, start, end, userId, start, end)
}

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
// - Journée : arrivée/départ/pause quand les deux heures sont remplies, sinon la
//   somme des lignes d'activité payables (activity_code.payable != 0, null = payable)
//   — règle commune, voir services/timesheetHours.js.
// - Mode semaine: le total déclaré, rattaché au DIMANCHE de la semaine — une semaine
//   à cheval sur deux paies tombe donc entière dans celle qui contient son dimanche.
//   Pas de proratisation : l'employé a déclaré un chiffre, on ne le découpe pas.
export function computePayableMinutes(userId, start, end) {
  const days = db.prepare(`
    SELECT td.start_time, td.end_time, td.break_minutes,
      (SELECT COALESCE(SUM(te.duration_minutes), 0) FROM timesheet_entries te
         LEFT JOIN activity_codes ac ON te.activity_code_id = ac.id
        WHERE te.day_id = td.id AND (ac.payable IS NULL OR ac.payable = 1)) AS entries_minutes
    FROM timesheet_days td
    WHERE td.user_id = ? AND td.deleted_at IS NULL
      AND td.date >= ? AND td.date <= ?
  `).all(userId, start, end)
  let daily = 0
  for (const d of days) daily += dayPayableMinutes(d, d.entries_minutes)

  const weekly = db.prepare(`
    SELECT COALESCE(SUM(minutes), 0) as total
    FROM timesheet_weeks
    WHERE user_id = ? AND deleted_at IS NULL
      AND week_start >= ? AND week_start <= ?
  `).get(userId, start, end).total

  return daily + weekly
}

// Nombre de feuilles de temps NON approuvées (draft/submitted/rejected) ayant des heures sur la période.
// Sert à alerter le gestionnaire avant de finaliser la paie : des heures non signées y sont incluses.
function countUnapprovedDays(userId, start, end) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM timesheet_days
    WHERE user_id = ? AND deleted_at IS NULL
      AND date >= ? AND date <= ?
      AND COALESCE(status, 'draft') != 'approved'
  `).get(userId, start, end).n
}

// Importe les heures des feuilles de temps dans une paie donnée.
//   - Pour chaque paie_item (un par employé):
//     - Si l'employé a des heures régulières contractuelles (employees.hours_per_week > 0):
//       on garde regular_hours tel quel et on remonte l'écart avec les heures réelles dans le
//       récap (information seulement — l'écart n'est plus reporté nulle part).
//     - Sinon, on écrase regular_hours avec le total des heures payables — seulement
//       si l'employé a saisi quelque chose dans Boréal (sinon ses heures sont tenues
//       dans Airtable et restent telles quelles).
//   - opts.keep(item, hours) → true : ne pas écraser cette ligne (synchro auto).
// Retourne un récap: { paie_id, period_start, period_end, results: [...], changed: [ids] }
export function importTimesheetsForPaie(paieId, opts = {}) {
  const paie = db.prepare('SELECT * FROM paies WHERE id = ?').get(paieId)
  if (!paie) throw new Error('Paie introuvable')
  const bounds = computePeriodBounds(paie)
  if (!bounds) throw new Error('Paie sans period_end — impossible de calculer la période')
  const { start, end } = bounds

  // Persiste period_start si absent (bénin, cohérence des affichages)
  if (!paie.period_start) {
    db.prepare(`UPDATE paies SET period_start = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(start, paieId)
  }

  const items = db.prepare('SELECT * FROM paie_items WHERE paie_id = ?').all(paieId)
  const results = []
  const changed = []
  const updateHours = db.prepare(`UPDATE paie_items SET regular_hours = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
  // Valeur recopiée de Boréal : la synchro auto reconnaîtra ensuite une correction faite dans Airtable.
  const saveState = db.prepare(`INSERT INTO paie_timesheet_sync_state (paie_item_id, written_hours) VALUES (?, ?)
    ON CONFLICT(paie_item_id) DO UPDATE SET written_hours = excluded.written_hours, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)

  db.transaction(() => {
    for (const item of items) {
      const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(item.employee_id)
      if (!employee) { results.push({ employee_id: item.employee_id, skipped: 'employee_not_found' }); continue }
      const user = userForEmployee(employee)
      if (!user) {
        results.push({ employee_id: employee.id, employee_name: [employee.first_name, employee.last_name].filter(Boolean).join(' '), skipped: 'no_user_link' })
        continue
      }
      if (!hasTimesheetData(user.id, start, end)) {
        results.push({ employee_id: employee.id, employee_name: [employee.first_name, employee.last_name].filter(Boolean).join(' '), skipped: 'no_timesheet' })
        continue
      }
      const payableMinutes = computePayableMinutes(user.id, start, end)
      const totalHours = Math.round((payableMinutes / 60) * 100) / 100
      const unapprovedDays = countUnapprovedDays(user.id, start, end)

      const contractualHours = Number(employee.hours_per_week) > 0
      if (contractualHours) {
        results.push({
          employee_id: employee.id,
          employee_name: [employee.first_name, employee.last_name].filter(Boolean).join(' '),
          mode: 'contractual',
          timesheet_hours: totalHours,
          regular_hours: Number(item.regular_hours) || 0,
          diff_hours: Math.round((totalHours - (Number(item.regular_hours) || 0)) * 100) / 100,
          unapproved_days: unapprovedDays,
        })
      } else {
        if (opts.keep?.(item, totalHours)) {
          results.push({ employee_id: employee.id, employee_name: [employee.first_name, employee.last_name].filter(Boolean).join(' '), skipped: 'edited_in_airtable', timesheet_hours: totalHours, regular_hours: Number(item.regular_hours) || 0 })
          continue
        }
        if (item.regular_hours == null || Math.abs(Number(item.regular_hours) - totalHours) > 0.001) {
          updateHours.run(totalHours, item.id)
          changed.push(item.id)
        }
        saveState.run(item.id, totalHours)
        results.push({
          item_id: item.id,
          employee_id: employee.id,
          employee_name: [employee.first_name, employee.last_name].filter(Boolean).join(' '),
          mode: 'direct',
          timesheet_hours: totalHours,
          regular_hours: totalHours,
          unapproved_days: unapprovedDays,
        })
      }
    }
  })()

  return { paie_id: paieId, period_start: start, period_end: end, results, changed }
}
