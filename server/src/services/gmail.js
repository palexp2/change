import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { getGmailClient } from '../connectors/google.js'

const DOMAIN = 'orisha.io'

function parseEmailAddress(raw) {
  if (!raw) return ''
  const match = raw.match(/<(.+?)>/)
  return match ? match[1].toLowerCase() : raw.toLowerCase().trim()
}

function getHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ''
}

function decodeBody(part) {
  if (!part) return ''
  if (part.body?.data) return Buffer.from(part.body.data, 'base64').toString('utf8')
  if (part.parts) {
    for (const p of part.parts) { const t = decodeBody(p); if (t) return t }
  }
  return ''
}

function extractBodies(payload) {
  let html = '', text = ''
  const walk = (part) => {
    if (part.mimeType === 'text/html') html = html || decodeBody(part)
    else if (part.mimeType === 'text/plain') text = text || decodeBody(part)
    else if (part.parts) part.parts.forEach(walk)
  }
  walk(payload)
  return { html, text }
}

function findOrCreateContact(emailAddress, displayName) {
  if (!emailAddress) return null
  const existing = db.prepare('SELECT id, company_id FROM contacts WHERE email=?').get(emailAddress)
  if (existing) return { contactId: existing.id, companyId: existing.company_id }

  const parts = (displayName || '').replace(/<.*>/, '').trim().split(' ')
  const id = uuid()
  db.prepare('INSERT INTO contacts (id, first_name, last_name, email) VALUES (?,?,?,?)')
    .run(id, parts[0] || '', parts.slice(1).join(' ') || '', emailAddress)
  return { contactId: id, companyId: null }
}

async function syncAccount(oauthRow) {
  const { id: oauthId, account_email } = oauthRow
  let gmail
  try { gmail = await getGmailClient(oauthId) }
  catch (e) { console.error(`❌ Gmail client ${account_email}:`, e.message); return }

  const ownerUser = db.prepare('SELECT id FROM users WHERE email=?').get(account_email)
  const userId = ownerUser?.id || null

  const state = db.prepare('SELECT * FROM gmail_sync_state WHERE connector_oauth_id=?').get(oauthId)

  try {
    let messages = []
    let newHistoryId = state?.last_history_id

    if (state?.last_history_id) {
      try {
        const hist = await gmail.users.history.list({
          userId: 'me', startHistoryId: state.last_history_id, historyTypes: ['messageAdded'],
        })
        for (const record of (hist.data.history || [])) {
          for (const m of (record.messagesAdded || [])) messages.push(m.message)
        }
        newHistoryId = hist.data.historyId || newHistoryId
      } catch (histErr) {
        console.log(`⚠️ Gmail ${account_email}: history expiré, resync complet`)
        const list = await gmail.users.messages.list({ userId: 'me', maxResults: 50 })
        messages = list.data.messages || []
      }
    } else {
      const list = await gmail.users.messages.list({ userId: 'me', maxResults: 100 })
      messages = list.data.messages || []
    }

    let imported = 0
    for (const msgRef of messages) {
      if (db.prepare('SELECT id FROM emails WHERE gmail_message_id=?').get(msgRef.id)) continue

      let msg
      try {
        msg = await gmail.users.messages.get({ userId: 'me', id: msgRef.id, format: 'full' })
      } catch (getMsgErr) {
        // Message supprimé/inaccessible entre le list et le get — on skip
        continue
      }

      const headers = msg.data.payload.headers
      const fromEmail = parseEmailAddress(getHeader(headers, 'from'))
      const toEmail = parseEmailAddress(getHeader(headers, 'to'))
      const dateHeader = getHeader(headers, 'date')
      const timestamp = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString()
      const { html, text } = extractBodies(msg.data.payload)

      const direction = fromEmail.endsWith(`@${DOMAIN}`) ? 'out' : 'in'
      const externalEmail = direction === 'out' ? toEmail : fromEmail
      const externalName = direction === 'out' ? getHeader(headers, 'to') : getHeader(headers, 'from')

      const { contactId, companyId } = findOrCreateContact(externalEmail, externalName) || {}
      const interactionId = uuid()
      const emailId = uuid()

      db.prepare(`
        INSERT INTO interactions (id, contact_id, company_id, user_id, type, direction, timestamp)
        VALUES (?,?,?,?,?,?,?)
      `).run(interactionId, contactId || null, companyId || null, userId, 'email', direction, timestamp)

      db.prepare(`
        INSERT OR IGNORE INTO emails (id, interaction_id, subject, body_html, body_text, from_address, to_address, cc, gmail_message_id, gmail_thread_id)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(
        emailId, interactionId,
        getHeader(headers, 'subject'), html, text,
        fromEmail, toEmail, getHeader(headers, 'cc'),
        msgRef.id, msg.data.threadId
      )

      newHistoryId = msg.data.historyId || newHistoryId
      imported++
    }

    db.prepare(`
      INSERT INTO gmail_sync_state (connector_oauth_id, last_history_id, last_synced_at)
      VALUES (?,?,datetime('now'))
      ON CONFLICT(connector_oauth_id) DO UPDATE SET
        last_history_id=excluded.last_history_id, last_synced_at=excluded.last_synced_at
    `).run(oauthId, newHistoryId)

    if (imported > 0) console.log(`📧 Gmail ${account_email}: ${imported} nouveaux courriels`)
  } catch (e) {
    console.error(`❌ Gmail sync ${account_email}:`, e.message)
  }
}

/**
 * Envoie un courriel au nom du premier compte Google OAuth.
 * Requiert le scope gmail.send (les comptes connectés avant cette mise à jour
 * doivent être reconnectés pour obtenir ce scope).
 */
export async function sendEmail(to, subject, htmlBody) {
  const account = db.prepare(
    `SELECT * FROM connector_oauth WHERE connector='google' AND refresh_token IS NOT NULL LIMIT 1`
  ).get()
  if (!account) throw new Error('Aucun compte Google configuré')

  const gmail = await getGmailClient(account.id)

  // RFC 2822 raw message, encodé en base64url
  const rawLines = [
    `To: ${to}`,
    'Content-Type: text/html; charset=utf-8',
    'MIME-Version: 1.0',
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    '',
    htmlBody,
  ]
  const raw = Buffer.from(rawLines.join('\r\n')).toString('base64url')

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
}

export async function syncAllMailboxes() {
  const accounts = db.prepare(`
    SELECT * FROM connector_oauth WHERE connector='google' AND refresh_token IS NOT NULL
  `).all()

  for (const account of accounts) {
    await syncAccount(account)
  }
}
