// Public feedback endpoint for the installation follow-up email buttons.
// No auth (customers are not logged in). The only input we trust is the answer
// enum — company lookups are strict so a bogus `company` param results in a
// 204-style no-op. On 'stuck' or 'painful' we create a task for Marc-Antoine.

import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db/database.js'
import { logSystemRun } from '../services/systemAutomations.js'

const router = Router()

const VALID_ANSWERS = new Set(['great', 'painful', 'nextWeek', 'stuck'])
const MARC_ANTOINE_EMAIL = 'marc-antoine@orisha.io'

const ANSWER_LABELS = {
  great:    { fr: 'Super, installation terminée', en: "Great, it's done" },
  painful:  { fr: "C'était pénible",              en: 'It was painful' },
  nextWeek: { fr: 'Prévu la semaine prochaine',    en: 'Plans to do it next week' },
  stuck:    { fr: 'Bloqué',                        en: 'Stuck' },
}

// Simple public HTML response — customer clicked the button, no UI beyond thanks.
function thanksPage(lang, answer) {
  const isFrench = lang === 'French'
  const label = ANSWER_LABELS[answer]?.[isFrench ? 'fr' : 'en'] || answer
  const title = isFrench ? 'Merci !' : 'Thanks!'
  const body = isFrench
    ? `Merci pour ton retour. Réponse enregistrée : <strong>${label}</strong>.`
    : `Thanks for your feedback. Response recorded: <strong>${label}</strong>.`
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:40px 20px;color:#333}.card{max-width:500px;margin:0 auto;background:#fff;padding:30px;border-radius:6px;text-align:center}h1{color:#22b14c;margin:0 0 20px}p{font-size:16px;line-height:1.5}</style>
</head><body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`
}

// GET /api/public/installation-feedback?answer=stuck&lang=French&company=<uuid>
router.get('/', (req, res) => {
  const started = Date.now()
  const { answer, lang, company } = req.query

  if (!VALID_ANSWERS.has(answer)) {
    return res.status(400).send('Invalid answer')
  }

  const language = lang === 'French' ? 'French' : 'English'
  const companyRow = company
    ? db.prepare('SELECT id, name FROM companies WHERE id = ? AND deleted_at IS NULL').get(company)
    : null

  // Find shipping contact (the one that received the email). Use same logic
  // as the selection query: first shipping adresse by created_at.
  let contactRow = null
  if (companyRow) {
    contactRow = db.prepare(`
      SELECT ct.id, ct.first_name, ct.last_name, ct.email
      FROM adresses a
      JOIN contacts ct ON ct.id = a.contact_id
      WHERE a.company_id = ? AND a.address_type = 'Livraison'
      ORDER BY a.created_at ASC, a.id ASC
      LIMIT 1
    `).get(companyRow.id)
  }

  let taskId = null
  if (companyRow && (answer === 'stuck' || answer === 'painful')) {
    const assignee = db.prepare('SELECT id, name FROM users WHERE email = ?').get(MARC_ANTOINE_EMAIL)
    if (assignee) {
      taskId = uuidv4()
      const title = answer === 'stuck'
        ? `Installation bloquée — ${companyRow.name}`
        : `Installation pénible — ${companyRow.name}`
      const description = [
        `Client : ${companyRow.name}`,
        contactRow ? `Contact : ${contactRow.first_name || ''} ${contactRow.last_name || ''} <${contactRow.email || '—'}>` : null,
        `Réponse : ${ANSWER_LABELS[answer].fr}`,
        `Langue du client : ${language}`,
        '',
        "Déclenché automatiquement par le bouton dans l'email de suivi d'installation.",
      ].filter(Boolean).join('\n')
      db.prepare(`
        INSERT INTO tasks (id, title, description, status, priority, company_id, contact_id, assigned_to, created_at, updated_at)
        VALUES (?, ?, ?, 'À faire', 'Haute', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `).run(taskId, title, description, companyRow.id, contactRow?.id || null, assignee.id)
    }
  }

  const appUrl = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
  logSystemRun('sys_installation_followup', {
    status: 'success',
    result: [
      `Feedback reçu — ${ANSWER_LABELS[answer]?.fr || answer}`,
      `Client : ${companyRow?.name || '∅'}`,
      companyRow ? `${appUrl}/erp/companies/${companyRow.id}` : null,
      `Langue : ${language}`,
      taskId
        ? `Tâche créée pour Marc-Antoine : ${taskId}\n${appUrl}/erp/tasks/${taskId}`
        : `Pas de tâche (réponse = ${answer})`,
    ].filter(Boolean).join('\n'),
    duration_ms: Date.now() - started,
    triggerData: { answer, language, company_id: company, task_id: taskId },
  })

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(thanksPage(language, answer))
})

export default router
