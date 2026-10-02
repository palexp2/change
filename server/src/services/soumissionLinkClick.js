import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { APP_URL } from '../config/appUrl.js'
import { emitEntity } from './realtimeEmitters.js'
import { isSelfHit } from './emailTracking.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'

// Clic sur un bouton « S'abonner » / « Acheter » d'une soumission
// (/erp/pay/soumission/:id/:kind) : une note entrante au fil du contact et de
// l'entreprise ; au-delà du délai après l'envoi, une tâche de relance. Ne lève
// jamais : le client doit toujours atteindre le paiement.

export const CLICK_AUTOMATION_ID = 'sys_soumission_link_click'
export const LATE_CLICK_TASK_AUTOMATION_ID = 'sys_soumission_late_click_task'

const KIND_LABELS = { abonnement: 'S’abonner', achat: 'Acheter' }
const BOT_UA = /bot|crawl|spider|slurp|preview|scanner|safelinks|proofpoint|mimecast|barracuda/i

function lateTaskConfig() {
  let cfg = {}
  try { cfg = JSON.parse(db.prepare('SELECT action_config FROM automations WHERE id = ?').get(LATE_CLICK_TASK_AUTOMATION_ID)?.action_config || '{}') } catch { /* défauts */ }
  const hours = cfg.delay_hours === '' || cfg.delay_hours == null ? NaN : Number(cfg.delay_hours)
  return {
    assigneeEmail: String(cfg.assignee_email || 'philippe@orisha.io').trim(),
    delayHours: Number.isFinite(hours) && hours >= 0 ? hours : 24,
  }
}

function createLateClickTask(s, kind, label, clickedAt) {
  const started = Date.now()
  const { assigneeEmail, delayHours } = lateTaskConfig()
  const hoursSince = (Date.parse(clickedAt) - Date.parse(s.sent_at)) / 3600e3
  if (!(hoursSince > delayHours)) return null
  const assignee = db.prepare('SELECT id, name FROM users WHERE lower(email) = lower(?)').get(assigneeEmail)
  if (!assignee) {
    logSystemRun(LATE_CLICK_TASK_AUTOMATION_ID, { status: 'error', error: `Utilisateur introuvable : ${assigneeEmail}`, triggerData: { soumission_id: s.id, kind } })
    return null
  }
  const url = `${APP_URL}/erp/soumissions/${s.id}`
  // Une seule tâche ouverte par soumission : un client qui revient trois fois
  // sur le paiement ne donne pas trois relances.
  const open = db.prepare(`
    SELECT id FROM tasks WHERE assigned_to = ? AND deleted_at IS NULL AND status IN ('À faire','En cours') AND description LIKE ?
  `).get(assignee.id, `%${url}%`)
  if (open) return null
  const id = newRecordId()
  const name = s.company_name || s.contact_name || s.title || 'client'
  const title = `Relancer ${name} — « ${label} » cliqué`
  const description = [
    `Soumission ${s.quote_number ? `#${s.quote_number}` : s.title || s.id} : bouton « ${label} » ouvert ${Math.round(hoursSince)} h après l'envoi.`,
    url,
  ].join('\n')
  db.prepare(`
    INSERT INTO tasks (id, title, description, status, priority, due_date, company_id, contact_id, assigned_to, created_at, updated_at)
    VALUES (?, ?, ?, 'À faire', 'Haute', ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `).run(id, title, description, clickedAt.slice(0, 10), s.company_id || null, s.contact_id || null, assignee.id)
  emitEntity('task', 'created', id, db.prepare('SELECT * FROM tasks WHERE id = ?').get(id))
  logSystemRun(LATE_CLICK_TASK_AUTOMATION_ID, {
    status: 'success',
    result: `Tâche créée pour ${assignee.name} : ${title}\n${APP_URL}/erp/tasks/${id}`,
    duration_ms: Date.now() - started,
    triggerData: { soumission_id: s.id, kind, task_id: id, hours_since_sent: Math.round(hoursSince) },
  })
  return id
}

export function recordSoumissionLinkClick(req, soumissionId, kind) {
  try {
    if (req.method !== 'GET' || isSelfHit(req) || BOT_UA.test(req.get('user-agent') || '')) return
    const label = KIND_LABELS[kind]
    if (!label) return
    const s = db.prepare(`
      SELECT s.id, s.title, s.quote_number, s.company_id, s.contact_id, s.sent_at,
        co.name AS company_name, TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS contact_name
      FROM soumissions s
      LEFT JOIN companies co ON co.id = s.company_id
      LEFT JOIN contacts c ON c.id = s.contact_id
      WHERE s.id = ?
    `).get(soumissionId)
    if (!s) return
    const clickedAt = new Date().toISOString()
    let interactionId = null
    if (isSystemAutomationActive(CLICK_AUTOMATION_ID) && (s.company_id || s.contact_id)) {
      const started = Date.now()
      interactionId = newRecordId()
      const title = `Lien « ${label} » ouvert`
      const notes = `Soumission ${s.quote_number ? `#${s.quote_number}` : s.title || ''}`.trim()
      db.transaction(() => {
        db.prepare(`INSERT INTO interactions (id, contact_id, company_id, type, direction, timestamp) VALUES (?, ?, ?, 'note', 'in', ?)`)
          .run(interactionId, s.contact_id || null, s.company_id || null, clickedAt)
        db.prepare('INSERT INTO meetings (id, interaction_id, title, notes) VALUES (?, ?, ?, ?)')
          .run(newRecordId(), interactionId, title, notes)
      })()
      emitEntity('interaction', 'created', interactionId, {
        id: interactionId, contact_id: s.contact_id, company_id: s.company_id, type: 'note', direction: 'in',
        timestamp: clickedAt, meeting_title: title, contact_name: s.contact_name, company_name: s.company_name,
      })
      logSystemRun(CLICK_AUTOMATION_ID, {
        status: 'success',
        result: `${title} — ${s.company_name || s.contact_name || '∅'} (${notes})`,
        duration_ms: Date.now() - started,
        triggerData: { soumission_id: s.id, kind, interaction_id: interactionId },
      })
    }
    if (s.sent_at && isSystemAutomationActive(LATE_CLICK_TASK_AUTOMATION_ID)) createLateClickTask(s, kind, label, clickedAt)
  } catch (e) {
    console.error('soumission link click:', soumissionId, kind, e.message)
  }
}
