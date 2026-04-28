/**
 * Postmark email adapter for field-rule automations.
 *
 * action_config shape:
 *   {
 *     to: 'ops@example.com' | ['a@x.com','b@x.com'],   // OR
 *     toEnv: 'NOTIFY_EMAIL_OPS',                        // env var holding the address(es)
 *     subject: '...',
 *     bodyHtml: '...',        // at least one of bodyHtml / bodyText is required
 *     bodyText: '...',
 *     streamEnv: 'POSTMARK_STREAM_OPS',                 // optional: pick a non-default stream
 *     from: 'alice@orisha.io',                          // optional: override the default from
 *     fromEnv: 'POSTMARK_FROM_OPS',                     // [legacy] env var override
 *   }
 *
 * Templates in subject/bodyHtml/bodyText are rendered upstream (renderActionConfig).
 * HTML is NOT re-escaped here — the renderer rejects `<script` and the caller is
 * expected to write static HTML around whitelisted {{columns}}.
 */
import * as postmark from 'postmark'
import { resolveFromAddress } from '../postmarkConfig.js'

let cachedClient = null
function getClient() {
  if (cachedClient) return cachedClient
  const token = process.env.POSTMARK_API_KEY
  if (!token) throw new Error('POSTMARK_API_KEY manquant')
  cachedClient = new postmark.ServerClient(token)
  return cachedClient
}

function resolveRecipients(ac) {
  if (ac.toEnv) {
    const raw = process.env[ac.toEnv]
    if (!raw) throw new Error(`Variable d'environnement manquante: ${ac.toEnv}`)
    return raw
  }
  if (Array.isArray(ac.to)) return ac.to.filter(Boolean).join(',')
  return ac.to || null
}

export async function sendEmail({ rule, rendered }) {
  const ac = rule.action_config || {}
  const to = resolveRecipients(ac)
  if (!to || !String(to).trim()) {
    throw new Error('Destinataire email requis (to ou toEnv)')
  }
  const subject = rendered.subject
  if (!subject || !String(subject).trim()) {
    throw new Error('Template `subject` manquant ou vide')
  }
  const htmlBody = rendered.bodyHtml
  const textBody = rendered.bodyText
  if (!htmlBody && !textBody) {
    throw new Error('Template `bodyHtml` ou `bodyText` requis')
  }

  const from = ac.from
    || (ac.fromEnv ? process.env[ac.fromEnv] : null)
    || resolveFromAddress()
  if (!from) throw new Error('Adresse expéditeur manquante (action_config.from ou défaut Postmark)')

  const stream = ac.streamEnv ? process.env[ac.streamEnv] : null

  const payload = {
    From: from,
    To: to,
    Subject: subject,
  }
  if (htmlBody) payload.HtmlBody = htmlBody
  if (textBody) payload.TextBody = textBody
  if (stream) payload.MessageStream = stream

  await getClient().sendEmail(payload)
}
