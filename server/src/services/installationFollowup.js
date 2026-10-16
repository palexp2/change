// Courriel de suivi d'installation — part 21 jours après le PREMIER envoi
// expédié d'une entreprise (sa première commande expédiée), au courriel de
// l'adresse de livraison de cet envoi. Aucune copie cachée.
// Les boutons du courriel mènent à une page publique (routes/installation-feedback.js)
// qui consigne la réponse dans installation_followups et, sur « Je suis bloqué »,
// crée une tâche pour Philippe. La fiche commande montre la réponse en pastille.
//
// Un seul envoi par entreprise : la ligne installation_followups (clé company_id)
// et companies.installation_followup_sent_at sont écrites dans la même transaction
// que le courriel ; la requête d'éligibilité les exclut.
//
// Garde-fou : INSTALLATION_FOLLOWUP_EARLIEST_SHIPMENT borne le passé — sans lui,
// l'activation enverrait le courriel à des clients expédiés il y a des mois.

import { emitCompany } from './realtimeEmitters.js'
import { newRecordId } from '../utils/recordId.js'
import { APP_URL } from '../config/appUrl.js'
import { getPostmarkClient } from './postmarkConfig.js'

export const INSTALLATION_FOLLOWUP_EARLIEST_SHIPMENT = '2026-09-23'

export const MIN_DAYS_AFTER_SHIPMENT = 21

export const ANSWERS = ['great', 'painful', 'nextWeek', 'stuck']

// Premier envoi expédié de chaque entreprise (statut « Envoyé » + date).
const FIRST_SHIPMENT_CTE = `
  first_shipment AS (
    SELECT o.company_id, o.id AS order_id, s.id AS shipment_id, s.shipped_at,
           COALESCE(s.address_id, o.address_id) AS address_id,
           ROW_NUMBER() OVER (PARTITION BY o.company_id ORDER BY s.shipped_at ASC, s.id ASC) AS rn
    FROM shipments s
    JOIN orders o ON o.id = s.order_id
    WHERE s.shipped_at IS NOT NULL AND s.status = 'Envoyé'
      AND s.deleted_at IS NULL AND o.deleted_at IS NULL AND o.company_id IS NOT NULL
  )`

// Requête pure — `db` passé en paramètre pour les tests en mémoire.
export function selectEligibleCompanies(db, {
  nowIso = new Date().toISOString(),
  minDays = MIN_DAYS_AFTER_SHIPMENT,
  earliestShipment = INSTALLATION_FOLLOWUP_EARLIEST_SHIPMENT,
  includeAlreadySent = false,
} = {}) {
  const idempotencyClause = includeAlreadySent ? '' : `AND c.installation_followup_sent_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM installation_followups f WHERE f.company_id = c.id)`
  return db.prepare(`
    WITH ${FIRST_SHIPMENT_CTE},
    candidates AS (
      SELECT
        c.id AS company_id, c.name AS company_name, c.language AS company_language,
        fs.order_id, fs.shipment_id, fs.shipped_at AS first_shipped_at, fs.address_id,
        a.contact_id,
        TRIM(COALESCE(NULLIF(TRIM(ct.email), ''), a.courriel_du_contact)) AS contact_email,
        COALESCE(ct.first_name, a.nom_complet_du_contact) AS contact_first_name,
        COALESCE(ct.language, a.langue_du_contact) AS contact_language
      FROM companies c
      JOIN first_shipment fs ON fs.company_id = c.id AND fs.rn = 1
      LEFT JOIN adresses a  ON a.id = fs.address_id
      LEFT JOIN contacts ct ON ct.id = a.contact_id
      WHERE c.deleted_at IS NULL
        ${idempotencyClause}
        AND fs.shipped_at >= ?
        AND julianday(?) - julianday(fs.shipped_at) >= ?
    )
    SELECT * FROM candidates
    WHERE contact_email LIKE '%_@_%'
    ORDER BY first_shipped_at ASC
  `).all(earliestShipment, nowIso, minDays)
}

function pickLanguage(row) {
  const lang = (row.contact_language || row.company_language || '').toLowerCase()
  return lang.startsWith('fr') ? 'French' : 'English'
}

const firstWord = s => String(s || '').trim().split(/\s+/)[0] || ''

// Le jeton d'une réponse = l'id du courriel envoyé (aléatoire, unique).
export function buildFeedbackUrl(appUrl, answer, token) {
  const u = new URL(`${appUrl}/erp/api/public/installation-feedback`)
  u.searchParams.set('t', token)
  u.searchParams.set('a', answer)
  return u.toString()
}

export const STRINGS = {
  French: {
    subject: "Comment s'est passée l'installation ?",
    hello: 'Salut',
    question: "Comment s'est passée l'installation&nbsp;?",
    sub: 'Un clic suffit.',
    great: "C'est fait, tout roule",
    painful: "C'était pénible",
    nextWeek: 'La semaine prochaine',
    stuck: 'Je suis bloqué',
    help: 'Besoin d’un coup de main&nbsp;?',
    call: 'Appelle-nous au <a href="tel:18882674742" style="color:#167030;font-weight:bold;text-decoration:none">1-888-267-4742</a>',
  },
  English: {
    subject: 'How did the installation go?',
    hello: 'Hi',
    question: 'How did the installation go?',
    sub: 'One click is all it takes.',
    great: "It's done, all good",
    painful: 'It was painful',
    nextWeek: 'Next week',
    stuck: "I'm stuck",
    help: 'Need a hand?',
    call: 'Call us at <a href="tel:18882674742" style="color:#167030;font-weight:bold;text-decoration:none">1-888-267-4742</a>',
  },
}

const ICONS = { great: '✅', painful: '😮‍💨', nextWeek: '📅', stuck: '🆘' }

export function buildInstallationEmailHtml({ language, firstName, token, emailId, appUrl }) {
  const t = STRINGS[language] || STRINGS.French
  const choice = answer => `<td width="50%" style="padding:6px">
      <a href="${buildFeedbackUrl(appUrl, answer, token)}" style="display:block;border:1px solid #d9e7dd;border-radius:10px;background:#f6fbf7;padding:18px 12px;text-align:center;text-decoration:none;color:#1f2937;font-size:15px;font-weight:bold;line-height:1.3">
        <span style="display:block;font-size:26px;line-height:1;margin-bottom:8px">${ICONS[answer]}</span>${t[answer]}
      </a></td>`
  const name = firstWord(firstName)
  const pixel = emailId ? `<img src="${appUrl}/erp/api/track/email/${emailId}.gif" width="1" height="1" alt="" style="display:none;border:0;width:1px;height:1px">` : ''

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.subject}</title></head>
<body style="margin:0;padding:0;background:#eef2ef;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
<table width="100%" cellspacing="0" cellpadding="0" style="background:#eef2ef"><tr><td align="center" style="padding:28px 12px">
  <table width="560" cellspacing="0" cellpadding="0" style="max-width:100%;background:#fff;border-radius:14px;overflow:hidden">
    <tr><td style="background:#22b14c;height:6px;line-height:6px;font-size:0">&nbsp;</td></tr>
    <tr><td align="center" style="padding:28px 24px 8px"><img src="https://orisha.us-east-1.linodeobjects.com/logo.png" alt="Orisha" width="120" style="display:block;max-width:120px"></td></tr>
    <tr><td align="center" style="padding:18px 32px 4px;font-size:16px;color:#4b5563">${t.hello}${name ? ` ${name}` : ''} 👋</td></tr>
    <tr><td align="center" style="padding:4px 32px 4px;font-size:24px;font-weight:bold;line-height:1.3;color:#111827">${t.question}</td></tr>
    <tr><td align="center" style="padding:0 32px 18px;font-size:14px;color:#6b7280">${t.sub}</td></tr>
    <tr><td style="padding:0 22px 22px">
      <table width="100%" cellspacing="0" cellpadding="0">
        <tr>${choice('great')}${choice('painful')}</tr>
        <tr>${choice('nextWeek')}${choice('stuck')}</tr>
      </table>
    </td></tr>
    <tr><td align="center" style="padding:18px 32px 26px;border-top:1px solid #eef0f2;font-size:14px;color:#4b5563;line-height:1.6">${t.help}<br>${t.call}</td></tr>
  </table>
  <div style="padding:16px;font-size:11px;color:#8a9490;text-align:center">Automatisation Orisha Inc. · 1535 ch. Ste-Foy, bureau 220 · Québec, QC G1S 2P1</div>
</td></tr></table>
${pixel}
</body></html>`
}

// Courriel + interaction + ligne de suivi + drapeau entreprise, en une transaction.
function recordSend(db, { row, subject, html, emailId, to, fromAddress, language }) {
  const interactionId = newRecordId()
  db.transaction(() => {
    db.prepare(`INSERT INTO interactions (id, contact_id, company_id, type, direction, timestamp)
      VALUES (?, ?, ?, 'email', 'out', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).run(interactionId, row.contact_id, row.company_id)
    db.prepare(`INSERT INTO emails (id, interaction_id, subject, body_html, from_address, to_address, automated)
      VALUES (?, ?, ?, ?, ?, ?, 1)`).run(emailId, interactionId, subject, html, fromAddress, to)
    db.prepare(`INSERT INTO installation_followups (company_id, order_id, shipment_id, email_id, lang, sent_at)
      VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).run(row.company_id, row.order_id, row.shipment_id, emailId, language)
    db.prepare(`UPDATE companies SET installation_followup_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(row.company_id)
  })()
  try { emitCompany('updated', row.company_id, null) } catch { /* temps réel absent (tests) */ }
  return { interactionId }
}

// Courriel d'essai pour l'admin : aucune écriture ; les boutons pointent sur un
// jeton bidon (la page de remerciement s'ouvre, rien n'est consigné).
export async function sendInstallationTestEmail(db, {
  to,
  language = 'French',
  appUrl = APP_URL,
  fromAddress = process.env.POSTMARK_FROM,
  postmarkToken = process.env.POSTMARK_API_KEY,
  sendFn = null,
} = {}) {
  if (!to || !/@/.test(to)) throw new Error('Adresse email de test invalide')
  const lang = language === 'French' ? 'French' : 'English'
  const html = buildInstallationEmailHtml({ language: lang, firstName: 'Alex', token: 'test', emailId: null, appUrl })
  const subject = `[TEST] ${STRINGS[lang].subject}`
  const send = sendFn || (emailData => getPostmarkClient(postmarkToken).sendEmail(emailData))
  await send({ From: fromAddress, To: to, Subject: subject, HtmlBody: html })
  return { to, language: lang, subject }
}

// Une passe : sélection, envoi, consignation. `sendFn` injecté pour les tests.
export async function sendInstallationFollowups(db, {
  appUrl = APP_URL,
  fromAddress = process.env.POSTMARK_FROM,
  postmarkToken = process.env.POSTMARK_API_KEY,
  dryRun = false,
  sendFn = null,
  nowIso,
  earliestShipment,
} = {}) {
  const selectOpts = {}
  if (nowIso) selectOpts.nowIso = nowIso
  if (earliestShipment) selectOpts.earliestShipment = earliestShipment
  const eligible = selectEligibleCompanies(db, selectOpts)
  const results = { total: eligible.length, sent: 0, errors: 0, skipped: 0, details: [] }
  if (eligible.length === 0) return results

  const send = sendFn || (emailData => getPostmarkClient(postmarkToken).sendEmail(emailData))

  for (const row of eligible) {
    const base = { company_id: row.company_id, company_name: row.company_name, to: row.contact_email }
    try {
      const language = pickLanguage(row)
      const emailId = newRecordId()
      const html = buildInstallationEmailHtml({ language, firstName: row.contact_first_name, token: emailId, emailId, appUrl })
      const subject = STRINGS[language].subject
      if (dryRun) {
        results.skipped++
        results.details.push({ ...base, language, action: 'dry-run' })
        continue
      }
      await send({ From: fromAddress, To: row.contact_email, Subject: subject, HtmlBody: html })
      const { interactionId } = recordSend(db, { row, subject, html, emailId, to: row.contact_email, fromAddress, language })
      results.sent++
      results.details.push({ ...base, language, email_id: emailId, interaction_id: interactionId, action: 'sent' })
    } catch (e) {
      results.errors++
      results.details.push({ ...base, error: e.message, action: 'error' })
    }
  }
  return results
}

// État du suivi pour la fiche commande : null si la commande ne porte pas le
// premier envoi de l'entreprise. { state: 'planned', due_at } avant l'envoi,
// { state: 'sent', sent_at, answer, answered_at, note, task_id } ensuite.
export function orderFollowupState(db, orderId, { active = true } = {}) {
  const sent = db.prepare(`SELECT sent_at, answer, answered_at, note, task_id FROM installation_followups WHERE order_id = ?`).get(orderId)
  if (sent) return { state: 'sent', ...sent }
  if (!active) return null
  const first = db.prepare(`WITH ${FIRST_SHIPMENT_CTE}
    SELECT fs.shipped_at FROM first_shipment fs
    JOIN orders o ON o.company_id = fs.company_id AND o.id = ?
    JOIN companies c ON c.id = fs.company_id AND c.installation_followup_sent_at IS NULL
    WHERE fs.rn = 1 AND fs.order_id = o.id AND fs.shipped_at >= ?`).get(orderId, INSTALLATION_FOLLOWUP_EARLIEST_SHIPMENT)
  if (!first) return null
  const due = new Date(first.shipped_at)
  due.setUTCDate(due.getUTCDate() + MIN_DAYS_AFTER_SHIPMENT)
  return { state: 'planned', due_at: due.toISOString().slice(0, 10) }
}
