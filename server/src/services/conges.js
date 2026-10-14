import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { sendSlack } from './slack.js'
import { logSystemRun, isSystemAutomationActive } from './systemAutomations.js'
import { emitEntity } from './realtimeEmitters.js'

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
function nthMonday(y, m, n) { const d = new Date(Date.UTC(y, m, 1)); d.setUTCDate(1 + ((8 - d.getUTCDay()) % 7) + 7 * (n - 1)); return iso(d) }
// Férié tombant la fin de semaine → lundi suivant (Noël, St-Jean, Canada, Jour de l'An).
function observed(y, m, day) { const d = new Date(Date.UTC(y, m, day)); const w = d.getUTCDay(); if (w === 6) d.setUTCDate(day + 2); if (w === 0) d.setUTCDate(day + 1); return iso(d) }
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451)
  return new Date(Date.UTC(y, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1))
}
// Jours fériés du Québec (mêmes dates que la table « Jours fériés » d'Airtable RH).
export function quebecHolidays(y) {
  const gf = easter(y); gf.setUTCDate(gf.getUTCDate() - 2)
  const may25 = new Date(Date.UTC(y, 4, 25)); may25.setUTCDate(25 - (((may25.getUTCDay() + 6) % 7) || 7))
  return new Set([observed(y, 0, 1), iso(gf), iso(may25), observed(y, 5, 24), observed(y, 6, 1),
    nthMonday(y, 8, 1), nthMonday(y, 9, 2), observed(y, 11, 25)])
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
const MO = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
const dayLabel = (s, withMonth = true) => { const d = utc(s); return `${WD[d.getUTCDay()]} ${d.getUTCDate() === 1 ? '1er' : d.getUTCDate()}${withMonth ? ` ${MO[d.getUTCMonth()]}` : ''}` }
const fmtDays = n => String(n).replace('.', ',')

// « lundi 5 octobre », « du lundi 5 au vendredi 9 octobre (5 jours) », « lundi 5 octobre (demi-journée) ».
export function whenLabel(v) {
  const days = v.days ?? workdays(v.start_date, v.end_date)
  if (v.start_date === v.end_date) return `${dayLabel(v.start_date)}${days === 0.5 ? ' (demi-journée)' : ''}`
  const sameMonth = v.start_date.slice(0, 7) === v.end_date.slice(0, 7)
  return `du ${dayLabel(v.start_date, !sameMonth)} au ${dayLabel(v.end_date)} (${fmtDays(days)} jour${days > 1 ? 's' : ''})`
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
