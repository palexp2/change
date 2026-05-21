import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import {
  buildRelanceList, regenerateEmail,
  getAllOverrides, setOverride, GLOBAL_SCOPE,
  saveUserDraft, getDraft, markDraftSent,
} from '../services/relanceEmail.js'
import { sendEmail } from '../services/gmail.js'

const router = Router()
router.use(requireAuth)

router.get('/qualification-calls', (req, res) => {
  res.json({ data: buildRelanceList() })
})

router.get('/settings', (req, res) => {
  res.json(getAllOverrides())
})

// Renvoie le compte Gmail connecté pour l'utilisateur courant (l'expéditeur
// effectif si on appelle /send). null si aucun compte Google n'est lié à un
// utilisateur dont l'email matche, ou si le refresh token a expiré.
// Utilisé par la modale d'envoi pour afficher l'expéditeur réel avant confirmation.
router.get('/gmail-account', (req, res) => {
  const account = db.prepare(`
    SELECT co.account_email
    FROM connector_oauth co
    JOIN users u ON lower(u.email) = lower(co.account_email)
    WHERE co.connector='google' AND co.refresh_token IS NOT NULL AND u.id = ?
    LIMIT 1
  `).get(req.user.id)
  res.json({ accountEmail: account?.account_email || null })
})

// PUT /settings/global  ou  PUT /settings/qc/:qcId
router.put('/settings/global', (req, res) => {
  const value = setOverride(GLOBAL_SCOPE, req.body?.instructions)
  res.json({ scope: GLOBAL_SCOPE, instructions: value })
})

router.put('/settings/qc/:qcId', (req, res) => {
  const { qcId } = req.params
  if (!qcId) return res.status(400).json({ error: 'qcId requis' })
  const value = setOverride(qcId, req.body?.instructions)
  res.json({ scope: qcId, instructions: value })
})

router.post('/regenerate', async (req, res) => {
  const { qualification_call_id, temperature, general_rules, specific_instructions } = req.body || {}
  if (!qualification_call_id) return res.status(400).json({ error: 'qualification_call_id requis' })
  try {
    const out = await regenerateEmail({
      qcId: qualification_call_id,
      temperature,
      generalRules: general_rules,
      specificInstructions: specific_instructions,
    })
    res.json(out)
  } catch (e) {
    res.status(500).json({ error: e.message || 'Erreur de génération' })
  }
})

// Autosave d'une édition manuelle par-dessus la sortie IA persistée.
// La régénération IA (POST /regenerate) sauvegarde aussi son draft mais avec
// ai_subject/ai_body en plus — c'est l'autre voie d'écriture.
router.put('/draft/:qcId', (req, res) => {
  const { qcId } = req.params
  const { subject, body } = req.body || {}
  if (!qcId) return res.status(400).json({ error: 'qcId requis' })
  if (typeof subject !== 'string' || typeof body !== 'string') {
    return res.status(400).json({ error: 'subject et body requis (string)' })
  }
  saveUserDraft(qcId, { subject, body })
  res.json({ ok: true })
})

// Convertit le texte plat IA en HTML pour l'envoi Gmail :
//   - échappe < > & " '
//   - linkifie URLs http(s):// et emails (sur les segments hors markdown)
//   - aplatit les liens markdown [label](url) en <a href="url">label</a>
//   - préserve les sauts de ligne via <br>
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
function bodyToHtml(text) {
  const mdLinkRe = /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g
  const urlRe = /\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?]/g
  const emailRe = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g

  const afterMd = []
  let lastIdx = 0
  for (const m of text.matchAll(mdLinkRe)) {
    if (m.index > lastIdx) afterMd.push({ type: 'text', value: text.slice(lastIdx, m.index) })
    afterMd.push({ type: 'mdlink', label: m[1], href: m[2] })
    lastIdx = m.index + m[0].length
  }
  if (lastIdx < text.length) afterMd.push({ type: 'text', value: text.slice(lastIdx) })

  const parts = []
  for (const p of afterMd) {
    if (p.type !== 'text') { parts.push(p); continue }
    let li = 0
    for (const m of p.value.matchAll(urlRe)) {
      if (m.index > li) parts.push({ type: 'text', value: p.value.slice(li, m.index) })
      parts.push({ type: 'url', value: m[0] })
      li = m.index + m[0].length
    }
    if (li < p.value.length) parts.push({ type: 'text', value: p.value.slice(li) })
  }

  return parts.map(p => {
    if (p.type === 'mdlink') return `<a href="${escapeHtml(p.href)}">${escapeHtml(p.label)}</a>`
    if (p.type === 'url') return `<a href="${escapeHtml(p.value)}">${escapeHtml(p.value)}</a>`
    const esc = escapeHtml(p.value)
    const withEmails = esc.replace(emailRe, (e) => `<a href="mailto:${e}">${e}</a>`)
    return withEmails.replace(/\n/g, '<br>')
  }).join('')
}

// POST /send/:qcId — envoie le draft IA persisté via le Gmail de l'utilisateur
// connecté. Destinataire = contact principal de la company (premier par ordre
// de création, même règle que buildRelanceList). Pas d'override du destinataire :
// si on veut envoyer ailleurs, on édite le contact côté CRM. L'envoi crée une
// interaction + un row emails (mêmes colonnes que la sync Gmail).
// Aucun fallback template : si pas de draft, on rejette (l'utilisateur doit
// d'abord cliquer 'Générer avec l'IA' sur la carte).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

router.post('/send/:qcId', async (req, res) => {
  const { qcId } = req.params
  if (!qcId) return res.status(400).json({ error: 'qcId requis' })
  const overrideTo = typeof req.body?.to === 'string' ? req.body.to.trim() : ''

  const qc = db.prepare('SELECT id, company_id FROM qualification_calls WHERE id = ?').get(qcId)
  if (!qc) return res.status(404).json({ error: 'Qualification call introuvable' })
  if (!qc.company_id) return res.status(400).json({ error: 'QC non lié à une company' })

  // Contact principal (premier par ordre de création) — utilisé pour le
  // rattachement CRM (interactions.contact_id) et comme destinataire par défaut.
  const contact = db.prepare(`
    SELECT id, first_name, last_name, email
    FROM contacts WHERE company_id = ?
    ORDER BY created_at ASC LIMIT 1
  `).get(qc.company_id)

  // Destinataire : override saisi dans la modale, sinon email du contact.
  const recipient = overrideTo || contact?.email || null
  if (!recipient) {
    return res.status(400).json({ error: 'Aucun destinataire (ni override, ni contact avec courriel)' })
  }
  if (!EMAIL_RE.test(recipient)) {
    return res.status(400).json({ error: `Adresse invalide : ${recipient}` })
  }

  const draft = getDraft(qcId)
  if (!draft) {
    return res.status(400).json({ error: 'Aucun courriel généré — clique \'Générer avec l\'IA\' d\'abord' })
  }
  const { subject, body } = draft

  const htmlBody = bodyToHtml(body)

  let sent
  try {
    sent = await sendEmail(recipient, subject, htmlBody, { userId: req.user.id })
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Échec d\'envoi Gmail' })
  }

  // Si l'override correspond à un contact existant de la company, on l'attache
  // à l'interaction; sinon on garde le contact principal comme rattachement.
  let interactionContactId = contact?.id || null
  if (overrideTo) {
    const matched = db.prepare(
      `SELECT id FROM contacts WHERE company_id = ? AND lower(email) = lower(?) LIMIT 1`
    ).get(qc.company_id, recipient)
    if (matched) interactionContactId = matched.id
  }

  // Trace l'envoi côté CRM — même schéma que la sync Gmail (interactions + emails)
  // pour que le courriel apparaisse dans la timeline du contact et de l'entreprise.
  const interactionId = randomUUID()
  const emailRowId = randomUUID()
  const ts = new Date().toISOString()
  db.prepare(`
    INSERT INTO interactions (id, contact_id, company_id, user_id, type, direction, timestamp)
    VALUES (?, ?, ?, ?, 'email', 'out', ?)
  `).run(interactionId, interactionContactId, qc.company_id, req.user.id || null, ts)
  db.prepare(`
    INSERT INTO emails (id, interaction_id, subject, body_html, from_address, to_address, gmail_message_id, gmail_thread_id, automated, open_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
  `).run(emailRowId, interactionId, subject, htmlBody, sent.account_email, recipient, sent.message_id, sent.thread_id || null)

  markDraftSent(qcId, {
    subject, body,
    to: recipient,
    from: sent.account_email,
    messageId: sent.message_id,
  })

  res.json({
    ok: true,
    sent: { to: recipient, from: sent.account_email, messageId: sent.message_id, at: ts },
  })
})

export default router
