// Installation follow-up email — sent 21 days after a NEW customer's first shipment.
// "New customer" = company with exactly one order AND no prior follow-up sent.
// Email goes to the contact linked to the shipping address of that first shipment.
// On 'stuck' or 'painful' feedback we auto-create a task for Marc-Antoine.
//
// Idempotency: companies.installation_followup_sent_at is set to strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
// after a successful send. The eligibility query skips any company where it is
// already populated, so a second run always returns 0 rows.
//
// Safety net: INSTALLATION_FOLLOWUP_EARLIEST_SHIPMENT caps how far back we look.
// When the feature is first activated this prevents a retroactive blast to
// customers whose first shipment happened months or years ago.

import * as postmark from 'postmark'
import { v4 as uuidv4 } from 'uuid'

// Only shipments on or after this date are eligible. Bump this if you need to
// include older customers; the flag + lifecycle_phase + order-count filters are
// still honoured, so it is safe to relax.
export const INSTALLATION_FOLLOWUP_EARLIEST_SHIPMENT = '2026-04-16'

const MIN_DAYS_AFTER_SHIPMENT = 21

// Pure DB query — returns the rows that SHOULD receive the email right now.
// Takes `db` explicitly so tests can run it against an in-memory database.
export function selectEligibleCompanies(db, {
  nowIso = new Date().toISOString(),
  minDays = MIN_DAYS_AFTER_SHIPMENT,
  earliestShipment = INSTALLATION_FOLLOWUP_EARLIEST_SHIPMENT,
  includeAlreadySent = false,
} = {}) {
  const idempotencyClause = includeAlreadySent ? '' : 'AND c.installation_followup_sent_at IS NULL'
  return db.prepare(`
    WITH first_shipment AS (
      SELECT o.company_id,
             s.id   AS shipment_id,
             s.shipped_at,
             s.address_id,
             ROW_NUMBER() OVER (
               PARTITION BY o.company_id
               ORDER BY s.shipped_at ASC, s.id ASC
             ) AS rn
      FROM shipments s
      JOIN orders o ON o.id = s.order_id
      WHERE s.shipped_at IS NOT NULL
        AND s.deleted_at IS NULL
        AND o.deleted_at IS NULL
    )
    SELECT
      c.id              AS company_id,
      c.name            AS company_name,
      c.language        AS company_language,
      fs.shipment_id    AS shipment_id,
      fs.shipped_at     AS first_shipped_at,
      fs.address_id     AS address_id,
      a.contact_id      AS contact_id,
      ct.email          AS contact_email,
      ct.first_name     AS contact_first_name,
      ct.language       AS contact_language
    FROM companies c
    JOIN first_shipment fs ON fs.company_id = c.id AND fs.rn = 1
    LEFT JOIN adresses a   ON a.id = fs.address_id
    LEFT JOIN contacts ct  ON ct.id = a.contact_id
    WHERE c.deleted_at IS NULL
      AND c.lifecycle_phase = 'Customer'
      ${idempotencyClause}
      AND (
        SELECT COUNT(*) FROM orders o2
        WHERE o2.company_id = c.id AND o2.deleted_at IS NULL
      ) = 1
      AND ct.email IS NOT NULL
      AND ct.email LIKE '%@%'
      AND fs.shipped_at >= ?
      AND julianday(?) - julianday(fs.shipped_at) >= ?
    ORDER BY fs.shipped_at ASC
  `).all(earliestShipment, nowIso, minDays)
}

function pickLanguage(row) {
  const lang = (row.contact_language || row.company_language || '').toLowerCase()
  return lang.startsWith('fr') || lang === 'français' || lang === 'francais' ? 'French' : 'English'
}

// Public — exported so tests can assert on the feedback link format.
export function buildFeedbackUrl(appUrl, answer, language, companyId) {
  const u = new URL(`${appUrl}/erp/api/public/installation-feedback`)
  u.searchParams.set('answer', answer)
  u.searchParams.set('lang', language)
  u.searchParams.set('company', companyId)
  return u.toString()
}

export function buildInstallationEmailHtml({ language, firstName, companyId, emailId, appUrl }) {
  const isFrench = language === 'French'
  const strings = isFrench
    ? {
        subject: "Comment s'est passé l'installation ?",
        greeting: 'Salut',
        prompt: "Comment s'est passé l'installation",
        great: "Super c'est fait !",
        painful: "C'était pénible",
        nextWeek: 'Je compte le faire la semaine prochaine',
        stuck: 'Je suis bloqué',
        help: "Besoin d'aide ? <a href=\"tel:18882674742\" style=\"color:#22b14c;\">Appelle-nous</a>",
      }
    : {
        subject: 'How did the installation go?',
        greeting: 'Hey',
        prompt: 'How did the installation go',
        great: "Great, it's done!",
        painful: 'It was painful',
        nextWeek: 'I plan to do it next week',
        stuck: "I'm stuck",
        help: '<a href="https://www.orisha.io/contact" style="color:#22b14c;">Need help?</a>',
      }

  const btn = (answer, label) => {
    const href = buildFeedbackUrl(appUrl, answer, language, companyId)
    return `<a href="${href}" style="background-color:#22b14c;color:#fff;padding:15px 25px;text-align:center;text-decoration:none;display:inline-block;border-radius:5px;font-size:16px;font-weight:bold;box-shadow:0 4px 8px rgba(0,0,0,0.2);margin:5px;">${label}</a>`
  }

  const pixelUrl = `${appUrl}/erp/api/track/email/${emailId}.gif`

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Installation follow-up</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,sans-serif;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#f4f4f4;">
    <tr><td align="center">
      <table width="600" border="0" cellspacing="0" cellpadding="0" style="background-color:#ffffff;border-radius:4px;overflow:hidden;">
        <tr><td align="center" style="padding:20px;">
          <img src="https://orisha.us-east-1.linodeobjects.com/logo.png" alt="Orisha" style="max-width:150px;display:block;">
        </td></tr>
        <tr><td style="background-color:#22b14c;height:5px;line-height:5px;font-size:0;"></td></tr>
        <tr><td style="padding:20px;">
          <p style="margin:0 0 10px 0;font-size:16px;color:#333;">${strings.greeting} ${firstName || ''},</p>
          <br>
          <p style="margin:0 0 20px 0;font-size:16px;color:#333;">${strings.prompt}</p>
          <br><br>
          <p style="text-align:center;margin:20px 0;">
            ${btn('great', strings.great)}
            ${btn('painful', strings.painful)}
          </p>
          <p style="text-align:center;margin:20px 0;">
            ${btn('nextWeek', strings.nextWeek)}
            ${btn('stuck', strings.stuck)}
          </p>
        </td></tr>
        <tr><td style="padding:20px;text-align:center;">
          <p style="margin:0;font-size:16px;color:#333;">${strings.help}</p>
        </td></tr>
        <tr><td align="center" style="padding:20px;background-color:#f4f4f4;font-size:12px;color:#777;">
          Automatisation Orisha Inc. 1535 ch. Ste-Foy Bureau 220 Québec, QC G1S 2P1
        </td></tr>
      </table>
    </td></tr>
  </table>
  <img src="${pixelUrl}" width="1" height="1" alt="" style="display:none;border:0;width:1px;height:1px">
</body>
</html>`
}

// Marks a company as having received the follow-up, and records the interaction/email
// + sets companies.installation_followup_sent_at. All writes happen in a single
// transaction so we never end up with a sent email and no flag (or vice versa).
function recordSend(db, { row, subject, html, emailId, to, fromAddress }) {
  const interactionId = uuidv4()
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO interactions (id, contact_id, company_id, type, direction, timestamp)
      VALUES (?, ?, ?, 'email', 'out', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(interactionId, row.contact_id, row.company_id)
    db.prepare(`
      INSERT INTO emails (id, interaction_id, subject, body_html, from_address, to_address, automated)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(emailId, interactionId, subject, html, fromAddress, to)
    db.prepare(`
      UPDATE companies SET installation_followup_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
    `).run(row.company_id)
  })
  tx()
  return { interactionId }
}

// Send ONE test email so an admin can preview the template in their own inbox
// before enabling the automation. No DB writes, no flag changes, no tasks.
// The HTML is prepended with a visible TEST banner and the feedback buttons
// point at a dummy company id (clicks land on the thanks page but create no task).
export async function sendInstallationTestEmail(db, {
  to,
  language = 'French',
  appUrl = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, ''),
  fromAddress = process.env.POSTMARK_FROM,
  postmarkToken = process.env.POSTMARK_API_KEY,
  sendFn = null,
} = {}) {
  if (!to || !/@/.test(to)) throw new Error('Adresse email de test invalide')
  const lang = language === 'French' ? 'French' : 'English'
  const emailId = uuidv4()
  const fakeCompanyId = '00000000-0000-0000-0000-000000000000'

  const base = buildInstallationEmailHtml({
    language: lang,
    firstName: lang === 'French' ? 'Alex' : 'Alex',
    companyId: fakeCompanyId,
    emailId,
    appUrl,
  })
  const banner = lang === 'French'
    ? '<div style="background:#fef3c7;border:2px solid #f59e0b;padding:12px;text-align:center;font-weight:bold;color:#92400e;">⚠️ COURRIEL DE TEST — ceci est un aperçu, ne pas y répondre. Les boutons ouvrent la page de confirmation mais ne créent aucune tâche.</div>'
    : '<div style="background:#fef3c7;border:2px solid #f59e0b;padding:12px;text-align:center;font-weight:bold;color:#92400e;">⚠️ TEST EMAIL — preview only, do not reply. Buttons open the confirmation page but do not create any task.</div>'
  const html = base.replace('<body ', '<body data-test="1" ').replace(/(<body[^>]*>)/, `$1${banner}`)
  const subject = lang === 'French'
    ? "[TEST] Comment s'est passé l'installation ?"
    : '[TEST] How did the installation go?'

  const send = sendFn || (async (emailData) => {
    const client = new postmark.ServerClient(postmarkToken)
    return client.sendEmail(emailData)
  })
  await send({ From: fromAddress, To: to, Subject: subject, HtmlBody: html })
  return { to, language: lang, subject }
}

// Run one pass: select eligible companies, send each email, record results.
// `sendFn` is the Postmark sender, injected so tests can stub it.
export async function sendInstallationFollowups(db, {
  appUrl = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, ''),
  fromAddress = process.env.POSTMARK_FROM,
  postmarkToken = process.env.POSTMARK_API_KEY,
  dryRun = false,
  sendFn = null,
  // Forwarded to selectEligibleCompanies so tests can pin a deterministic "now"
  // and relax the shipment-cutoff. Never pass these in production.
  nowIso,
  earliestShipment,
} = {}) {
  const selectOpts = {}
  if (nowIso) selectOpts.nowIso = nowIso
  if (earliestShipment) selectOpts.earliestShipment = earliestShipment
  const eligible = selectEligibleCompanies(db, selectOpts)
  const results = { total: eligible.length, sent: 0, errors: 0, skipped: 0, details: [] }

  if (eligible.length === 0) return results

  const send = sendFn || (async (emailData) => {
    const client = new postmark.ServerClient(postmarkToken)
    return client.sendEmail(emailData)
  })

  for (const row of eligible) {
    try {
      const language = pickLanguage(row)
      const emailId = uuidv4()
      const html = buildInstallationEmailHtml({
        language,
        firstName: row.contact_first_name,
        companyId: row.company_id,
        emailId,
        appUrl,
      })
      const subject = language === 'French'
        ? "Comment s'est passé l'installation ?"
        : 'How did the installation go?'

      if (dryRun) {
        results.skipped++
        results.details.push({
          company_id: row.company_id,
          company_name: row.company_name,
          to: row.contact_email,
          language,
          action: 'dry-run',
        })
        continue
      }

      await send({
        From: fromAddress,
        To: row.contact_email,
        Subject: subject,
        HtmlBody: html,
      })

      const { interactionId } = recordSend(db, {
        row, subject, html, emailId, to: row.contact_email, fromAddress,
      })

      results.sent++
      results.details.push({
        company_id: row.company_id,
        company_name: row.company_name,
        to: row.contact_email,
        language,
        email_id: emailId,
        interaction_id: interactionId,
        action: 'sent',
      })
    } catch (e) {
      results.errors++
      results.details.push({
        company_id: row.company_id,
        company_name: row.company_name,
        to: row.contact_email,
        error: e.message,
        action: 'error',
      })
    }
  }

  return results
}
