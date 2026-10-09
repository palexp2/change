import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { APP_URL } from '../config/appUrl.js'
import { emitEntity } from './realtimeEmitters.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'

// Carte refusée à l'ajout d'un produit à un abonnement existant (soumission ou
// page avec acceptation) : rien n'a été débité ni modifié, le client voit
// « Paiement refusé ». Une tâche de suivi est créée (Charles, 2026-10-09).
// Ne lève jamais : la page d'erreur du client passe avant.

export const PAYMENT_FAILED_TASK_ID = 'sys_payment_failed_task'

function assigneeEmail() {
  let cfg = {}
  try { cfg = JSON.parse(db.prepare('SELECT action_config FROM automations WHERE id = ?').get(PAYMENT_FAILED_TASK_ID)?.action_config || '{}') } catch { /* défauts */ }
  return String(cfg.assignee_email || 'philippe@orisha.io').trim()
}

/**
 * @param {{ source: 'soumission'|'page', soumissionId?: string, token?: string, acceptanceId?: string|number, error?: string }} ctx
 */
export function createPaymentFailedTask(ctx) {
  const started = Date.now()
  try {
    if (!isSystemAutomationActive(PAYMENT_FAILED_TASK_ID)) return null
    let companyId = null, contactId = null, what = '', url = ''
    if (ctx.source === 'soumission') {
      const s = db.prepare('SELECT id, quote_number, title, company_id, contact_id FROM soumissions WHERE id = ?').get(ctx.soumissionId)
      if (!s) return null
      companyId = s.company_id; contactId = s.contact_id
      what = `soumission ${s.quote_number ? `#${s.quote_number}` : s.title || s.id}`
      url = `${APP_URL}/erp/soumissions/${s.id}`
    } else {
      const a = db.prepare(`SELECT a.id, a.contact_id, pf.original_name FROM page_acceptances a
        JOIN public_files pf ON pf.id = a.public_file_id WHERE a.id = ? AND pf.token = ?`).get(Number(ctx.acceptanceId) || 0, ctx.token)
      if (!a) return null
      contactId = a.contact_id
      companyId = contactId ? db.prepare('SELECT company_id FROM contacts WHERE id = ?').pluck().get(contactId) : null
      what = `page « ${a.original_name} »`
      url = `${APP_URL}/erp/acceptations/${a.id}`
    }
    const assignee = db.prepare('SELECT id, name FROM users WHERE lower(email) = lower(?)').get(assigneeEmail())
    if (!assignee) {
      logSystemRun(PAYMENT_FAILED_TASK_ID, { status: 'error', error: `Utilisateur introuvable : ${assigneeEmail()}`, triggerData: ctx })
      return null
    }
    // Une seule tâche ouverte par soumission / acceptation (le client peut réessayer).
    const open = db.prepare(`SELECT id FROM tasks WHERE assigned_to = ? AND deleted_at IS NULL AND status IN ('À faire','En cours') AND description LIKE ?`)
      .get(assignee.id, `%${url}%`)
    if (open) return null
    const name = (companyId && db.prepare('SELECT name FROM companies WHERE id = ?').pluck().get(companyId))
      || (contactId && db.prepare(`SELECT TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) FROM contacts WHERE id = ?`).pluck().get(contactId))
      || 'client'
    const id = newRecordId()
    const title = `Paiement refusé — ${name}`
    const description = [
      `Carte refusée à l'ajout à l'abonnement (${what}) : rien n'a été débité ni modifié.`,
      ctx.error ? `Stripe : ${ctx.error}` : null,
      url,
    ].filter(Boolean).join('\n')
    db.prepare(`
      INSERT INTO tasks (id, title, description, status, priority, due_date, company_id, contact_id, assigned_to, created_at, updated_at)
      VALUES (?, ?, ?, 'À faire', 'Haute', date('now'), ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(id, title, description, companyId || null, contactId || null, assignee.id)
    emitEntity('task', 'created', id, db.prepare('SELECT * FROM tasks WHERE id = ?').get(id))
    logSystemRun(PAYMENT_FAILED_TASK_ID, {
      status: 'success',
      result: `Tâche créée pour ${assignee.name} : ${title}\n${APP_URL}/erp/tasks/${id}`,
      duration_ms: Date.now() - started,
      triggerData: { ...ctx, task_id: id },
    })
    return id
  } catch (e) {
    console.error('payment failed task:', e.message)
    return null
  }
}
