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
      } catch {
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
      } catch {
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
      VALUES (?,?,strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(connector_oauth_id) DO UPDATE SET
        last_history_id=excluded.last_history_id, last_synced_at=excluded.last_synced_at
    `).run(oauthId, newHistoryId)

    if (imported > 0) console.log(`📧 Gmail ${account_email}: ${imported} nouveaux courriels`)
  } catch (e) {
    console.error(`❌ Gmail sync ${account_email}:`, e.message)
  }
}

/**
 * Envoie un courriel via Gmail OAuth.
 * Sélection du compte expéditeur, par ordre de priorité :
 *   1. options.accountEmail explicite (ex : picker UI)
 *   2. options.userId → compte Google dont l'email matche celui de l'utilisateur ERP
 * Aucun fallback silencieux : si aucun des deux ne matche, on lève une erreur
 * plutôt qu'envoyer depuis le compte de quelqu'un d'autre.
 * Requiert le scope gmail.send — les comptes connectés avant l'ajout du scope
 * doivent être reconnectés.
 *
 * @param {string} to
 * @param {string} subject
 * @param {string} htmlBody
 * @param {Object} [options]
 * @param {string} [options.cc]
 * @param {Array<{filename: string, content: Buffer, contentType?: string}>} [options.attachments]
 * @param {string} [options.userId] ID de l'utilisateur ERP actif
 * @param {string} [options.accountEmail] Compte Gmail explicite à utiliser
 * @returns {Promise<{account_email: string, message_id: string, thread_id: string}>}
 */
export async function sendEmail(to, subject, htmlBody, options = {}) {
  const { cc, attachments, userId, accountEmail } = options

  let account = null
  if (accountEmail) {
    account = db.prepare(
      `SELECT * FROM connector_oauth
       WHERE connector='google' AND refresh_token IS NOT NULL AND account_email=?`
    ).get(accountEmail)
    if (!account) throw new Error(`Compte Gmail "${accountEmail}" non connecté`)
  }
  if (!account && userId) {
    account = db.prepare(`
      SELECT co.* FROM connector_oauth co
      JOIN users u ON lower(u.email) = lower(co.account_email)
      WHERE co.connector='google' AND co.refresh_token IS NOT NULL AND u.id=?
      LIMIT 1
    `).get(userId)
    if (!account) {
      throw new Error('Votre compte Gmail n\'est pas connecté — connectez-le depuis Connectors, ou sélectionnez un autre compte.')
    }
  }
  if (!account) throw new Error('Aucun compte Gmail fourni (accountEmail ou userId requis)')

  const gmail = await getGmailClient(account.id)
  const subjectHeader = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`

  let raw
  if (attachments && attachments.length > 0) {
    const boundary = `=_orisha_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
    const lines = [
      `To: ${to}`,
      ...(cc ? [`Cc: ${cc}`] : []),
      `Subject: ${subjectHeader}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      htmlBody,
    ]
    for (const att of attachments) {
      const b64 = Buffer.from(att.content).toString('base64').replace(/(.{76})/g, '$1\r\n')
      lines.push(
        '',
        `--${boundary}`,
        `Content-Type: ${att.contentType || 'application/octet-stream'}; name="${att.filename}"`,
        `Content-Disposition: attachment; filename="${att.filename}"`,
        'Content-Transfer-Encoding: base64',
        '',
        b64,
      )
    }
    lines.push('', `--${boundary}--`)
    raw = Buffer.from(lines.join('\r\n')).toString('base64url')
  } else {
    const rawLines = [
      `To: ${to}`,
      ...(cc ? [`Cc: ${cc}`] : []),
      'Content-Type: text/html; charset=utf-8',
      'MIME-Version: 1.0',
      `Subject: ${subjectHeader}`,
      '',
      htmlBody,
    ]
    raw = Buffer.from(rawLines.join('\r\n')).toString('base64url')
  }

  const resp = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
  return {
    account_email: account.account_email,
    message_id: resp.data.id,
    thread_id: resp.data.threadId,
  }
}

export async function syncAllMailboxes() {
  const accounts = db.prepare(`
    SELECT * FROM connector_oauth WHERE connector='google' AND refresh_token IS NOT NULL
  `).all()

  for (const account of accounts) {
    await syncAccount(account)
  }
}
