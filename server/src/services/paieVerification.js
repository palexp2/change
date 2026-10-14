import db from '../db/database.js'
import { computePeriodBounds, userForEmployee, hasTimesheetData, computePayableMinutes } from './paieTimesheetImport.js'

// Vérification d'une paie : chaque montant saisi (Airtable) à côté de sa
// source, pour qu'un humain valide vite. Rien n'est écrit ici.
//
//   heures      → feuille de temps Boréal, semaine par semaine
//   férié 1/20  → 1/20 du gagné aux 2 paies précédentes, sans remboursements ni
//                 commissions (ce que Nethris retient ; la formule Airtable, elle,
//                 garde les remboursements — d'où l'écart récurrent de Martin)
//   commission  → payée seulement à partir de 200 $
//
// Un point « à regarder » (flag) = la valeur saisie ne tombe pas sur la source.

const COMMISSION_MIN = 200
const r2 = n => Math.round(n * 100) / 100
const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const num = v => (v == null || v === '' ? null : Number(v))

function hoursCheck(item, employee, bounds) {
  const reg = num(item.regular_hours)
  const user = userForEmployee(employee)
  if (!user || !hasTimesheetData(user.id, bounds.start, bounds.end)) {
    return { value: reg, source: 'none', weeks: [] }
  }
  const mid = addDays(bounds.start, 6)
  const weeks = [
    { start: bounds.start, end: mid },
    { start: addDays(mid, 1), end: bounds.end },
  ].map(w => ({ ...w, hours: computePayableMinutes(user.id, w.start, w.end) / 60 }))
  const total = weeks.reduce((s, w) => s + w.hours, 0)
  const contractual = Number(employee.hours_per_week) > 0
  const out = { value: reg, source: 'boreal', user_id: user.id, weeks, total, contractual }
  // Heures à contrat : la paie garde les heures du contrat, Boréal n'est qu'indicatif.
  if (!contractual && reg != null && Math.abs(reg - total) > 0.005) {
    out.flag = 'mismatch'
  }
  if (reg != null && Math.abs(reg * 100 - Math.round(reg * 100)) > 1e-6) out.flag = 'decimals'
  return out
}

function holidayCheck(item, paie) {
  const fe = num(item.holiday_1_20)
  if (fe == null) return null
  const prev = db.prepare(`
    SELECT p.id, p.period_end, pi.total_pay, pi.expense_reimb, pi.commission
    FROM paie_items pi JOIN paies p ON p.id = pi.paie_id
    WHERE pi.employee_id = ? AND p.period_end < ?
    ORDER BY p.period_end DESC LIMIT 2
  `).all(item.employee_id, paie.period_end)
  const rows = prev.map(p => ({
    paie_id: p.id, period_end: p.period_end,
    total_pay: num(p.total_pay) || 0, expense_reimb: num(p.expense_reimb) || 0, commission: num(p.commission) || 0,
    gains: r2((num(p.total_pay) || 0) - (num(p.expense_reimb) || 0) - (num(p.commission) || 0)),
  }))
  const expected = r2(rows.reduce((s, p) => s + p.gains, 0) / 20)
  const out = { value: fe, source: 'calc', previous: rows, expected }
  if (Math.abs(expected - fe) > 0.01) out.flag = rows.some(p => p.expense_reimb) ? 'includes_reimb' : 'mismatch'
  return out
}

export function buildPaieVerification(paieId) {
  const paie = db.prepare('SELECT * FROM paies WHERE id = ?').get(paieId)
  if (!paie) return null
  const bounds = computePeriodBounds(paie)
  const items = db.prepare(`
    SELECT pi.*, e.first_name, e.last_name, e.hours_per_week
    FROM paie_items pi LEFT JOIN employees e ON e.id = pi.employee_id
    WHERE pi.paie_id = ? ORDER BY e.first_name, e.last_name
  `).all(paieId)

  const rows = items.map(item => {
    const employee = { id: item.employee_id, first_name: item.first_name, last_name: item.last_name, hours_per_week: item.hours_per_week }
    const name = [item.first_name, item.last_name].filter(Boolean).join(' ')
    const c = num(item.commission)
    const cells = {
      hours: bounds ? hoursCheck(item, employee, bounds) : { value: num(item.regular_hours), source: 'none', weeks: [] },
      holiday: holidayCheck(item, paie),
      vacation: num(item.vacation) ? { value: num(item.vacation), source: 'releve' } : null,
      reimb: num(item.expense_reimb) ? { value: num(item.expense_reimb), source: 'qb' } : null,
      commission: c ? { value: c, source: 'vendeurs', ...(c < COMMISSION_MIN ? { flag: 'under_min', min: COMMISSION_MIN } : {}) } : null,
    }
    return {
      item_id: item.id, employee_id: item.employee_id, name,
      hourly_rate: num(item.hourly_rate), total_pay: num(item.total_pay), notes: item.notes || null,
      cells,
    }
  })

  const flags = []
  for (const r of rows) for (const [k, c] of Object.entries(r.cells)) if (c?.flag) flags.push({ item_id: r.item_id, name: r.name, field: k, flag: c.flag })
  const sum = k => r2(rows.reduce((s, r) => s + (r.cells[k]?.value || 0), 0))
  return {
    paie_id: paie.id, period_start: bounds?.start || paie.period_start, period_end: paie.period_end,
    verified_by: paie.verified_by || null, verified_at: paie.verified_at || null,
    rows, flags,
    totals: {
      hours: sum('hours'), holiday: sum('holiday'), vacation: sum('vacation'),
      reimb: sum('reimb'), commission: sum('commission'),
      pay: r2(rows.reduce((s, r) => s + (r.total_pay || 0), 0)),
    },
  }
}
