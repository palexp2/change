// Page publique des boutons du courriel de suivi d'installation
// (services/installationFollowup.js). Pas d'auth : le jeton `t` (id aléatoire du
// courriel envoyé) est le secret ; seule l'énumération `a` est acceptée.
// La réponse se consigne sur installation_followups (un nouveau clic la
// remplace) ; « Je suis bloqué » crée une tâche pour Philippe, une seule fois.
// La page de remerciement ne promet rien et offre une note facultative.

import { Router } from 'express'
import { newRecordId } from '../utils/recordId.js'
import db from '../db/database.js'
import { logSystemRun } from '../services/systemAutomations.js'
import { APP_URL } from '../config/appUrl.js'
import { ANSWERS } from '../services/installationFollowup.js'
import { emitOrder } from '../services/realtimeEmitters.js'

const router = Router()

const AUTOMATION_ID = 'sys_installation_followup'
const TASK_ASSIGNEE_EMAIL = 'philippe@orisha.io'

export const ANSWER_LABELS = {
  great:    { fr: 'Fait',                          en: 'Done' },
  painful:  { fr: 'Pénible',                       en: 'Painful' },
  nextWeek: { fr: 'La semaine prochaine',          en: 'Next week' },
  stuck:    { fr: 'Bloqué',                        en: 'Stuck' },
}

const PAGE = {
  fr: {
    great:    ['🎉', 'Bravo !', 'Bonne saison avec Orisha.'],
    painful:  ['🙏', 'Merci de nous le dire.', 'Ça nous aide à rendre la prochaine plus simple.'],
    nextWeek: ['📅', 'Parfait !', 'Bonne installation.'],
    stuck:    ['🛠️', 'Merci, c’est noté.', ''],
    note: 'Un mot à ajouter ?', send: 'Envoyer', thanks: 'Merci !', call: 'Besoin d’aide ? 1-888-267-4742',
  },
  en: {
    great:    ['🎉', 'Well done!', 'Have a great season with Orisha.'],
    painful:  ['🙏', 'Thanks for telling us.', 'It helps us make the next one easier.'],
    nextWeek: ['📅', 'Sounds good!', 'Happy installing.'],
    stuck:    ['🛠️', 'Thanks, noted.', ''],
    note: 'Anything to add?', send: 'Send', thanks: 'Thank you!', call: 'Need help? 1-888-267-4742',
  },
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function page(lang, inner) {
  const p = PAGE[lang]
  return `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orisha</title>
<style>body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#eef2ef;color:#1f2937;padding:40px 16px}
.c{max-width:460px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;text-align:center}
.bar{height:6px;background:#22b14c}.in{padding:30px 26px}.ic{font-size:44px;line-height:1}
h1{font-size:22px;margin:14px 0 6px}p{color:#6b7280;margin:0 0 6px;font-size:15px}
label{display:block;text-align:left;font-size:14px;font-weight:bold;margin:22px 0 6px}
textarea{width:100%;box-sizing:border-box;height:90px;border:1px solid #d1d5db;border-radius:8px;padding:10px;font:inherit;font-size:15px}
button{margin-top:10px;background:#167030;color:#fff;border:0;border-radius:8px;padding:11px 22px;font-size:15px;font-weight:bold;cursor:pointer}
.ft{padding:14px;border-top:1px solid #eef0f2;font-size:13px;color:#6b7280}</style></head>
<body><div class="c"><div class="bar"></div><div class="in">${inner}</div><div class="ft">${p.call}</div></div></body></html>`
}

function thanksPage(lang, answer, token) {
  const p = PAGE[lang]
  const [icon, title, sub] = p[answer]
  return page(lang, `<div class="ic">${icon}</div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}
<form method="post" action="/erp/api/public/installation-feedback/note">
<input type="hidden" name="t" value="${esc(token)}"><label for="n">${p.note}</label>
<textarea id="n" name="note" maxlength="2000"></textarea><button type="submit">${p.send}</button></form>`)
}

const langOf = row => (row?.lang === 'English' ? 'en' : 'fr')

function loadFollowup(token) {
  if (!token || typeof token !== 'string' || token.length > 64) return null
  return db.prepare(`
    SELECT f.*, c.name AS company_name, o.order_number, e.to_address
    FROM installation_followups f
    LEFT JOIN companies c ON c.id = f.company_id
    LEFT JOIN orders o ON o.id = f.order_id
    LEFT JOIN emails e ON e.id = f.email_id
    WHERE f.email_id = ?`).get(token)
}

function createStuckTask(f) {
  const assignee = db.prepare('SELECT id FROM users WHERE email = ?').get(TASK_ASSIGNEE_EMAIL)
  if (!assignee) return null
  const contact = f.to_address ? db.prepare('SELECT id FROM contacts WHERE lower(email) = lower(?) AND deleted_at IS NULL').get(f.to_address) : null
  const id = newRecordId()
  const description = [
    `Client : ${f.company_name || '—'}`,
    f.order_number ? `Commande : #${f.order_number}` : null,
    f.to_address ? `Courriel : ${f.to_address}` : null,
    `Langue : ${f.lang === 'English' ? 'anglais' : 'français'}`,
    '',
    'Réponse « Je suis bloqué » au courriel de suivi d’installation.',
  ].filter(v => v !== null).join('\n')
  db.prepare(`INSERT INTO tasks (id, title, description, status, priority, company_id, contact_id, assigned_to, created_at, updated_at)
    VALUES (?, ?, ?, 'À faire', 'Haute', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    .run(id, `Installation bloquée — ${f.company_name || 'client'}`, description, f.company_id, contact?.id || null, assignee.id)
  return id
}

// GET /api/public/installation-feedback?t=<jeton>&a=stuck
router.get('/', (req, res) => {
  const started = Date.now()
  const answer = String(req.query.a || '')
  const token = String(req.query.t || '')
  if (!ANSWERS.includes(answer)) return res.status(400).send('Invalid answer')

  const f = loadFollowup(token)
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  // Jeton inconnu (courriel d'essai, lien recopié) : la page, sans rien consigner.
  if (!f) return res.send(thanksPage('fr', answer, ''))

  let taskId = f.task_id
  if (answer === 'stuck' && !taskId) taskId = createStuckTask(f)
  db.prepare(`UPDATE installation_followups SET answer = ?, answered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), task_id = ? WHERE email_id = ?`)
    .run(answer, taskId || null, token)
  if (f.order_id) try { emitOrder('updated', f.order_id, null) } catch { /* temps réel indisponible */ }

  logSystemRun(AUTOMATION_ID, {
    status: 'success',
    result: [
      `Réponse reçue — ${ANSWER_LABELS[answer].fr}`,
      `Client : ${f.company_name || f.company_id}`,
      f.order_id ? `${APP_URL}/erp/orders/${f.order_id}` : null,
      taskId && taskId !== f.task_id ? `Tâche créée pour Philippe : ${APP_URL}/erp/tasks` : null,
    ].filter(Boolean).join('\n'),
    duration_ms: Date.now() - started,
    triggerData: { answer, company_id: f.company_id, order_id: f.order_id, task_id: taskId || null },
  })
  res.send(thanksPage(langOf(f), answer, token))
})

// POST /api/public/installation-feedback/note — note facultative de la page.
router.post('/note', (req, res) => {
  const token = String(req.body?.t || '')
  const note = String(req.body?.note || '').trim().slice(0, 2000)
  const f = loadFollowup(token)
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  const lang = langOf(f)
  if (f && note) {
    db.prepare('UPDATE installation_followups SET note = ? WHERE email_id = ?').run(note, token)
    if (f.task_id) {
      db.prepare(`UPDATE tasks SET description = COALESCE(description, '') || ? , updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
        .run(`\n\nNote du client :\n${note}`, f.task_id)
    }
    if (f.order_id) try { emitOrder('updated', f.order_id, null) } catch { /* temps réel indisponible */ }
    logSystemRun(AUTOMATION_ID, {
      status: 'success',
      result: `Note du client — ${f.company_name || f.company_id}\n${note}`,
      duration_ms: 0,
      triggerData: { company_id: f.company_id, order_id: f.order_id },
    })
  }
  res.send(page(lang, `<div class="ic">💚</div><h1>${PAGE[lang].thanks}</h1>`))
})

export default router
