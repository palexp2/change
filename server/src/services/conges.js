import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { sendSlack } from './slack.js'
import { logSystemRun, isSystemAutomationActive } from './systemAutomations.js'
import { emitEntity } from './realtimeEmitters.js'
import { quebecHolidays as paieHolidays } from './paieSchedule.js'

// Congés saisis par l'employé depuis sa feuille de temps (bouton « Congé »).
// Même modèle que la table Congés d'Airtable RH : employé, début, fin, jours
// payés (0,5 = demi-journée). Chaque ajout / annulation avise #absences.

export const CONGE_SLACK_ID = 'sys_conge_slack'
const DEFAULTS = {
  slack_channel: '#absences',
  message: ':palm_tree: {nom} sera en congé {quand}.',
  cancel_message: ':x: Congé annulé : {nom} ne sera finalement pas en congé {quand}.',
}

const normName = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()

// Fiche employé d'un utilisateur : lien direct, sinon courriel, sinon nom.
export function employeeForUser(userId) {
  const u = db.prepare('SELECT id, name, email, employee_id FROM users WHERE id = ?').get(userId)
  if (!u) return null
  const cols = 'id, first_name, last_name'
  if (u.employee_id) {
    const e = db.prepare(`SELECT ${cols} FROM employees WHERE id = ?`).get(u.employee_id)
    if (e) return e
  }
  const all = db.prepare(`SELECT ${cols}, email_work FROM employees`).all()
  return all.find(e => e.email_work && u.email && e.email_work.toLowerCase() === u.email.toLowerCase())
    || all.find(e => normName(`${e.first_name || ''} ${e.last_name || ''}`) === normName(u.name))
    || null
}

const iso = d => d.toISOString().slice(0, 10)
const utc = s => new Date(s + 'T00:00:00Z')
// Jours fériés : la liste de la paie (fériés observés, lendemain de Noël compris) fait foi.
const holidayCache = new Map()
export function quebecHolidays(y) {
  if (!holidayCache.has(y)) holidayCache.set(y, new Set(paieHolidays(y).map(h => h.date)))
  return holidayCache.get(y)
}

// Jours ouvrables du congé, sans fins de semaine ni fériés (« Jours de travail » d'Airtable).
export function workdays(start, end) {
  let n = 0
  for (let d = utc(start); iso(d) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const w = d.getUTCDay()
    if (w !== 0 && w !== 6 && !quebecHolidays(d.getUTCFullYear()).has(iso(d))) n++
  }
  return n
}

const WD = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
const dayLabel = s => `${WD[utc(s).getUTCDay()]} ${s.slice(0, 10)}`
const fmtDays = n => String(n).replace('.', ',')

// « lundi 2026-10-05 », « du lundi 2026-10-05 au vendredi 2026-10-09 (5 jours) », « lundi 2026-10-05 (demi-journée) ».
export function whenLabel(v) {
  const days = v.days ?? workdays(v.start_date, v.end_date)
  if (v.start_date === v.end_date) return `${dayLabel(v.start_date)}${days === 0.5 ? ' (demi-journée)' : ''}`
  return `du ${dayLabel(v.start_date)} au ${dayLabel(v.end_date)} (${fmtDays(days)} jour${days > 1 ? 's' : ''})`
}

function config() {
  let cfg = {}
  try { cfg = JSON.parse(db.prepare('SELECT action_config FROM automations WHERE id = ?').get(CONGE_SLACK_ID)?.action_config || '{}') } catch {}
  const out = { ...DEFAULTS }
  for (const k of Object.keys(out)) if (cfg[k] != null && String(cfg[k]).trim()) out[k] = String(cfg[k]).trim()
  return out
}

async function notify(kind, v, emp) {
  if (!isSystemAutomationActive(CONGE_SLACK_ID)) return
  const cfg = config()
  const nom = `${emp.first_name || ''} ${emp.last_name || ''}`.trim()
  const text = (kind === 'cancel' ? cfg.cancel_message : cfg.message).replaceAll('{nom}', nom).replaceAll('{quand}', whenLabel(v))
  const t0 = Date.now()
  const triggerData = { vacation_id: v.id, kind, employee: nom }
  try {
    const r = await sendSlack({ channel: cfg.slack_channel, text })
    logSystemRun(CONGE_SLACK_ID, { status: r.sent ? 'success' : 'error', result: r.sent ? `${cfg.slack_channel} : ${text}` : null, error: r.sent ? null : 'Slack non configuré', duration_ms: Date.now() - t0, triggerData })
  } catch (e) {
    logSystemRun(CONGE_SLACK_ID, { status: 'error', error: e, duration_ms: Date.now() - t0, triggerData })
  }
}

export function listConges(employeeId, from) {
  return db.prepare('SELECT * FROM vacations WHERE employee_id = ? AND (end_date >= ? OR ? IS NULL) ORDER BY start_date')
    .all(employeeId, from || null, from || null)
}

// Ajoute un congé. `half` = demi-journée (un seul jour). Rend la ligne créée.
export function addConge({ employee, start_date, end_date, half, paid = true, userId }) {
  const end = end_date && end_date >= start_date ? end_date : start_date
  // Que des fins de semaine / fériés (quelqu'un qui travaille ces jours-là) : on compte les jours du calendrier.
  const wd = workdays(start_date, end) || Math.round((utc(end) - utc(start_date)) / 86400000) + 1
  const days = half && start_date === end ? 0.5 : wd
  const id = newRecordId()
  db.prepare('INSERT INTO vacations (id, employee_id, start_date, end_date, paid, days, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, employee.id, start_date, end, paid ? 1 : 0, days, userId || null)
  const row = db.prepare('SELECT * FROM vacations WHERE id = ?').get(id)
  emitEntity('vacation', 'created', id, row, userId)
  notify('add', row, employee)
  return row
}

export function removeConge({ employee, id, userId }) {
  const row = db.prepare('SELECT * FROM vacations WHERE id = ? AND employee_id = ?').get(id, employee.id)
  if (!row) return false
  db.prepare('DELETE FROM vacations WHERE id = ?').run(id)
  emitEntity('vacation', 'deleted', id, row, userId)
  notify('cancel', row, employee)
  return true
}
