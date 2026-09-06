import { join, extname } from 'path'
import { newRecordId } from '../utils/recordId.js'
import { createHash } from 'crypto'
import { writeFileSync } from 'fs'
import db from '../db/database.js'
import { getGmailClient, canCreateDrafts, invoiceTrashMailboxes, isInvoiceOnlyMailbox, mailboxList } from '../connectors/google.js'
import { runExtractionAndUpdate } from './saleReceiptExtraction.js'
import { emitEntity } from './realtimeEmitters.js'
import { buildEmailBodyPdf, htmlToText, isBillingSender, looksLikeInvoiceEmail, looksLikeInvoiceMessage, stripTrackingUrls } from '../utils/emailBodyPdf.js'
import { renderEmailHtmlPdf } from '../utils/emailHtmlPdf.js'
import { logSync } from './syncLog.js'
import { ensureUploadsDir } from '../config/uploads.js'

const DOMAIN = 'orisha.io'
const INVOICE_LABEL_NAME = 'ERP/Factures'
// Adresse dédiée aux factures fournisseurs. C'est un alias (pas un compte connecté) :
// tout message qui y est adressé/livré atterrit dans les boîtes connectées et doit être
// ingéré comme facture MÊME SANS le label ERP/Factures. L'alias livrant le même message
// dans plusieurs boîtes, la dédup inter-boîtes se fait par Message-ID RFC822.
const INVOICE_RECIPIENT = 'factures@orisha.io'
// Boîtes en autodétection : toute facture reçue y est ingérée, sans label ni
// passage par factures@. Liste d'adresses JSON dans connector_config
// (google / invoice_autodetect_mailboxes), pilotée depuis la page Connecteurs.
// Désactivé par défaut : sur une boîte de vente, les « factures » sortantes et
// les documents clients pollueraient les reçus fournisseurs.
const INVOICE_AUTODETECT_KEY = 'invoice_autodetect_mailboxes'
// Fenêtre de rattrapage. À l'activation d'une boîte, seules les factures du
// dernier mois remontent — pas tout l'historique.
const INVOICE_AUTODETECT_DAYS = 30
// Requête Gmail large : on laisse Gmail pré-filtrer sur les mots-clés, puis
// looksLikeInvoiceMessage tranche localement (sujet / nom de PJ / expéditeur).
const INVOICE_AUTODETECT_QUERY =
  '-in:sent -in:chats -in:drafts -from:me ' +
  '(facture OR factures OR invoice OR invoices OR receipt OR reçu OR relevé OR statement OR billing OR facturation)'

function autoDetectMailboxes() {
  return mailboxList(INVOICE_AUTODETECT_KEY)
}
// Restriction d'expéditeurs, par boîte : { "boite@x.com": ["anthropic.com"] }.
// Une entrée vide ou absente = aucune restriction (comportement historique des
// boîtes Orisha). Sur une boîte personnelle, c'est ce qui empêche l'autodétection
// de remonter les achats privés dans les reçus de l'entreprise : seuls les
// expéditeurs listés sont ingérés. Le label ERP/Factures et l'alias factures@
// restent des intentions humaines explicites — ils ne sont jamais filtrés ici.
const INVOICE_AUTODETECT_SENDERS_KEY = 'invoice_autodetect_senders'
function autoDetectSenders(email) {
  const row = db.prepare(
    `SELECT value FROM connector_config WHERE connector='google' AND key=?`
  ).get(INVOICE_AUTODETECT_SENDERS_KEY)
  if (!row?.value) return []
  try {
    const map = JSON.parse(row.value)
    const list = map?.[String(email || '').toLowerCase()]
    return Array.isArray(list) ? list.map(s => String(s).toLowerCase().trim()).filter(Boolean) : []
  } catch { return [] }
}
// Une entrée vaut soit une adresse complète (billing@anthropic.com), soit un
// domaine (anthropic.com) — auquel cas les sous-domaines comptent aussi, les
// fournisseurs expédiant souvent depuis mail.<domaine> ou em.<domaine>.
export function senderAllowed(fromHeader, allowed) {
  if (allowed.length === 0) return true
  const addr = parseEmailAddress(fromHeader)
  if (!addr) return false
  return allowed.some(a => addr === a || addr.endsWith(`@${a}`) || addr.endsWith(`.${a}`))
}
const RECEIPT_ATTACHMENT_EXTS = ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp']
const RECEIPT_MIME_PREFIXES = ['application/pdf', 'image/']
// Les images de signature courriel (logos sociaux, pixels de suivi) sont
// avalées comme faux reçus. Une vraie capture/photo de reçu pèse plusieurs Ko ;
// une icône 32×32 fait < ~2 Ko. On rejette donc les images trop petites — c'est
// le seul critère : une photo de facture collée dans le corps du courriel arrive
// inline (Content-ID) mais pèse plusieurs dizaines de Ko, il faut la conserver.
const MIN_RECEIPT_IMAGE_BYTES = 20 * 1024

const receiptsDir = ensureUploadsDir('receipts')

// Dédup par contenu : la même facture arrive sous plusieurs Message-ID (transfert
// interne, fournisseur qui relance, boîte du comptable en copie). Le hash du
// fichier est le seul identifiant stable. On tient compte des reçus supprimés :
// une suppression est un rejet explicite, on ne réimporte pas.
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}
function contentAlreadyImported(hash) {
  return !!db.prepare('SELECT 1 FROM sale_receipts WHERE content_sha256=?').get(hash)
}

async function resolveLabelId(gmail, name) {
  const res = await gmail.users.labels.list({ userId: 'me' })
  const label = (res.data.labels || []).find(l => l.name === name)
  return label?.id || null
}

// Distingue un vrai reçu d'une icône de signature / pixel de suivi.
// Critère unique : la taille. Les logos sociaux, séparateurs et pixels de suivi
// pèsent quelques Ko ; une vraie photo/capture de facture — même collée inline
// dans le corps via un Content-ID — pèse plusieurs dizaines de Ko. On conserve
// donc toute image ≥ 20 Ko, qu'elle soit en pièce jointe ou inline.
function looksLikeSignatureAsset(part, mime) {
  if (!mime.startsWith('image/')) return false  // ne filtre jamais les PDF
  const size = part.body?.size || 0
  if (size > 0 && size < MIN_RECEIPT_IMAGE_BYTES) return true
  return false
}

export function collectAttachments(payload) {
  const found = []
  // Une même image peut figurer deux fois dans le MIME : copie inline référencée
  // par un Content-ID (rendu dans le corps) + copie en pièce jointe. Même nom et
  // même taille = même fichier — on ne le garde qu'une fois pour ne pas créer un
  // reçu en double. Deux vraies pièces distinctes ont des noms différents.
  const seen = new Set()
  const walk = (part) => {
    if (!part) return
    const filename = part.filename || ''
    const mime = part.mimeType || ''
    const attachmentId = part.body?.attachmentId
    const isReceipt = attachmentId && (
      RECEIPT_MIME_PREFIXES.some(p => mime.startsWith(p)) ||
      RECEIPT_ATTACHMENT_EXTS.includes(extname(filename).toLowerCase())
    )
    if (isReceipt && !looksLikeSignatureAsset(part, mime)) {
      const key = `${filename}|${part.body?.size || 0}`
      if (!seen.has(key)) {
        seen.add(key)
        found.push({ filename, mimeType: mime, attachmentId })
      }
    }
    if (part.parts) part.parts.forEach(walk)
  }
  walk(payload)
  return found
}

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
  const id = newRecordId()
  db.prepare('INSERT INTO contacts (id, first_name, last_name, email) VALUES (?,?,?,?)')
    .run(id, parts[0] || '', parts.slice(1).join(' ') || '', emailAddress)
  return { contactId: id, companyId: null }
}

async function syncAccount(oauthRow, trigger = 'scheduled') {
  const { id: oauthId, account_email } = oauthRow
  const module = `gmail:emails:${account_email}`
  const t0 = Date.now()
  let gmail
  try { gmail = await getGmailClient(oauthId) }
  catch (e) {
    console.error(`❌ Gmail client ${account_email}:`, e.message)
    logSync(module, trigger, { status: 'error', error: `client: ${e.message}`, durationMs: Date.now() - t0 })
    return { status: 'error', imported: 0, error: e.message }
  }

  const ownerUser = db.prepare('SELECT id FROM users WHERE email=?').get(account_email)
  const userId = ownerUser?.id || null

  // Le label "ERP/Factures" est traité séparément par syncInvoiceLabel — exclure ici
  // pour éviter de polluer emails/interactions avec les factures fournisseurs.
  let invoiceLabelId = null
  try { invoiceLabelId = await resolveLabelId(gmail, INVOICE_LABEL_NAME) } catch {}

  const state = db.prepare('SELECT * FROM gmail_sync_state WHERE connector_oauth_id=?').get(oauthId)

  let imported = 0
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

    for (const msgRef of messages) {
      if (db.prepare('SELECT id FROM emails WHERE gmail_message_id=?').get(msgRef.id)) continue

      let msg
      try {
        msg = await gmail.users.messages.get({ userId: 'me', id: msgRef.id, format: 'full' })
      } catch {
        // Message supprimé/inaccessible entre le list et le get — on skip
        continue
      }

      if (invoiceLabelId && (msg.data.labelIds || []).includes(invoiceLabelId)) {
        // Facture fournisseur — traité par syncInvoiceLabel, pas par le sync emails/interactions
        continue
      }

      const headers = msg.data.payload.headers

      // Adressé/livré à factures@ — facture fournisseur (traitée par syncInvoiceLabel),
      // même sans label : ne pas polluer emails/interactions ni créer de faux contacts.
      const recipientBlob = [
        getHeader(headers, 'to'), getHeader(headers, 'cc'), getHeader(headers, 'delivered-to'),
      ].join(' ').toLowerCase()
      if (recipientBlob.includes(INVOICE_RECIPIENT)) continue
      const fromEmail = parseEmailAddress(getHeader(headers, 'from'))
      const toEmail = parseEmailAddress(getHeader(headers, 'to'))
      const dateHeader = getHeader(headers, 'date')
      const timestamp = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString()
      const { html, text } = extractBodies(msg.data.payload)

      const direction = fromEmail.endsWith(`@${DOMAIN}`) ? 'out' : 'in'
      const externalEmail = direction === 'out' ? toEmail : fromEmail
      const externalName = direction === 'out' ? getHeader(headers, 'to') : getHeader(headers, 'from')

      const { contactId, companyId } = findOrCreateContact(externalEmail, externalName) || {}
      const interactionId = newRecordId()
      const emailId = newRecordId()

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
    logSync(module, trigger, { status: 'success', modified: imported, durationMs: Date.now() - t0 })
    return { status: 'success', imported }
  } catch (e) {
    console.error(`❌ Gmail sync ${account_email}:`, e.message)
    // imported peut être > 0 si l'erreur survient après quelques courriels — on
    // garde le compte partiel pour ne pas perdre l'information.
    logSync(module, trigger, { status: 'error', modified: imported, error: e.message, durationMs: Date.now() - t0 })
    return { status: 'error', imported, error: e.message }
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
function resolveSenderAccount({ accountEmail, userId }) {
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
  return account
}

function buildRawMessage({ to, cc, subject, htmlBody, attachments }) {
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
  return raw
}

export async function sendEmail(to, subject, htmlBody, options = {}) {
  const { cc, attachments, userId, accountEmail } = options
  const account = resolveSenderAccount({ accountEmail, userId })
  const gmail = await getGmailClient(account.id)
  const raw = buildRawMessage({ to, cc, subject, htmlBody, attachments })

  const resp = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
  return {
    account_email: account.account_email,
    message_id: resp.data.id,
    thread_id: resp.data.threadId,
  }
}

/**
 * Crée un brouillon Gmail (rien n'est envoyé — l'utilisateur relit et envoie
 * depuis Gmail). Même sélection de compte que sendEmail.
 * Requiert le scope gmail.compose : `gmail.send` seul renvoie
 * ACCESS_TOKEN_SCOPE_INSUFFICIENT. Seuls les comptes de DRAFT_SCOPE_ACCOUNTS
 * (voir connectors/google.js) l'obtiennent, après reconnexion depuis la page
 * Connecteurs.
 *
 * @returns {Promise<{account_email: string, draft_id: string, message_id: string}>}
 */
export async function createDraft(to, subject, htmlBody, options = {}) {
  const { cc, attachments, userId, accountEmail } = options
  const account = resolveSenderAccount({ accountEmail, userId })
  if (!canCreateDrafts(account.account_email)) {
    throw new Error(
      `Le compte ${account.account_email} n'est pas autorisé à créer des brouillons ` +
      '(scope gmail.compose non demandé — voir DRAFT_SCOPE_ACCOUNTS).'
    )
  }
  const gmail = await getGmailClient(account.id)
  const raw = buildRawMessage({ to, cc, subject, htmlBody, attachments })

  try {
    const resp = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } })
    return {
      account_email: account.account_email,
      draft_id: resp.data.id,
      message_id: resp.data.message?.id,
    }
  } catch (e) {
    if (/insufficient|ACCESS_TOKEN_SCOPE/i.test(e.message || '')) {
      throw new Error(
        `Scope gmail.compose manquant pour ${account.account_email} — reconnectez ce compte ` +
        'depuis la page Connecteurs (bouton « Reconnecter » de la ligne du compte).'
      )
    }
    throw e
  }
}

// Messages du label déjà examinés et jugés non-facture (pas de PJ, pas de
// mots-clés facture). Évite de re-télécharger leur corps à chaque sync horaire.
// En mémoire seulement : un restart les ré-examine une fois, c'est acceptable.
const skippedInvoiceMessageIds = new Set()

// Facture sans pièce jointe : le corps du courriel est la facture (ex. Webflow,
// Manychat). On la matérialise en PDF — rendu HTML fidèle via Chromium headless
// (mise en page, tableaux et logos préservés, comme dans Gmail), avec repli sur
// le PDF texte pdfkit si le rendu échoue ou que le courriel n'a pas de corps
// HTML — puis on suit le même chemin que les PJ.
// Retourne un statut : 'imported' (reçu créé), 'duplicate' (contenu déjà en
// base — le courriel est donc bien une facture ingérée), 'not-invoice' ou
// 'error'. La distinction duplicate/not-invoice compte pour la corbeille
// après import : un doublon se met à la corbeille, pas un non-facture.
async function importInlineInvoice({ message, msgId, userId, rfc822Id = null }) {
  const headers = message.payload?.headers || []
  const subject = getHeader(headers, 'Subject')
  const { html, text } = extractBodies(message.payload)
  const bodyText = stripTrackingUrls(text || htmlToText(html))

  if (!bodyText || !looksLikeInvoiceEmail(subject, bodyText)) {
    skippedInvoiceMessageIds.add(msgId)
    return 'not-invoice'
  }

  // Dédup par contenu AVANT rendu, sur le texte normalisé du courriel plutôt
  // que sur les octets du PDF : le rendu Chromium n'est pas déterministe (dates
  // internes au fichier), deux rendus du même courriel n'auraient jamais le
  // même hash. Le texte, lui, est stable d'une boîte et d'une passe à l'autre.
  const hash = sha256(Buffer.from(`${subject || ''}\n${bodyText}`, 'utf8'))
  if (contentAlreadyImported(hash)) {
    skippedInvoiceMessageIds.add(msgId)
    return 'duplicate'
  }

  const from = getHeader(headers, 'From')
  const date = getHeader(headers, 'Date')
  let buffer = null
  if (html) {
    try {
      buffer = await renderEmailHtmlPdf({ subject, from, date, html })
    } catch (e) {
      console.warn(`⚠️ Gmail inline invoice rendu HTML ${msgId} — repli texte :`, e.message)
    }
  }
  if (!buffer) {
    try {
      buffer = await buildEmailBodyPdf({ subject, from, date, text: bodyText })
    } catch (e) {
      console.error(`❌ Gmail inline invoice PDF ${msgId}:`, e.message)
      return 'error'
    }
  }

  const id = newRecordId()
  const storedName = `${id}.pdf`
  const filePath = join(receiptsDir, storedName)
  try { writeFileSync(filePath, buffer) }
  catch (e) { console.error(`❌ Gmail inline invoice write ${msgId}:`, e.message); return 'error' }

  const originalName = `${(subject || 'courriel').replace(/[/\\]/g, '_').slice(0, 120)}.pdf`
  db.prepare(`
    INSERT INTO sale_receipts (id, filename, original_name, file_type, status, created_by, source, gmail_message_id, rfc822_message_id, content_sha256)
    VALUES (?, ?, ?, '.pdf', 'processing', ?, 'email', ?, ?, ?)
  `).run(id, storedName, originalName, userId, msgId, rfc822Id, hash)

  const created = db.prepare('SELECT * FROM sale_receipts WHERE id=?').get(id)
  if (created) emitEntity('sale_receipt', 'created', id, { ...created, items: [] }, userId)

  runExtractionAndUpdate({ saleReceiptId: id, filePath, fileExt: '.pdf', userId, trigger: 'scheduled' })
  return 'imported'
}

async function syncInvoiceLabel(oauthRow, trigger = 'scheduled') {
  const { id: oauthId, account_email } = oauthRow
  const module = `gmail:factures:${account_email}`
  const t0 = Date.now()
  let gmail
  try { gmail = await getGmailClient(oauthId) }
  catch (e) {
    console.error(`❌ Gmail invoice client ${account_email}:`, e.message)
    logSync(module, trigger, { status: 'error', error: `client: ${e.message}`, durationMs: Date.now() - t0 })
    return { status: 'error', imported: 0, error: e.message }
  }

  const ownerUser = db.prepare('SELECT id FROM users WHERE email=?').get(account_email)
  const userId = ownerUser?.id || null

  let labelId
  try { labelId = await resolveLabelId(gmail, INVOICE_LABEL_NAME) }
  catch (e) {
    console.error(`❌ Gmail labels.list ${account_email}:`, e.message)
    logSync(module, trigger, { status: 'error', error: `labels.list: ${e.message}`, durationMs: Date.now() - t0 })
    return { status: 'error', imported: 0, error: e.message }
  }
  // Deux sources, dédupliquées par id : le label ERP/Factures (tri manuel) ET tout
  // message adressé/livré à factures@orisha.io — l'adresse dédiée fonctionne donc
  // sans qu'aucun label ne soit posé (fournisseurs configurés pour y envoyer leurs
  // factures, forwards internes, etc.).
  const byId = new Map()
  // Messages venus de l'autodétection seulement : eux doivent passer le filtre
  // heuristique avant import (le label et l'alias, eux, sont des intentions
  // explicites et n'ont pas à être devinés).
  const autoDetectedIds = new Set()
  const autoDetectOn = autoDetectMailboxes().includes((account_email || '').toLowerCase())
  // Liste blanche d'expéditeurs pour l'autodétection de cette boîte (vide = tous).
  const allowedSenders = autoDetectSenders(account_email)

  // Corbeille après import (toggle par boîte, page Connecteurs) : tout message
  // dont la facture a été ingérée — reçu créé maintenant, ou doublon d'un reçu
  // déjà en base — est mis à la corbeille Gmail pour que l'utilisateur n'ait
  // pas à faire le ménage à la main. Réversible 30 jours (corbeille Gmail).
  // Les messages jugés non-facture ne sont jamais touchés.
  const trashOn = invoiceTrashMailboxes().includes((account_email || '').toLowerCase())
  // messages.trash exige gmail.modify, absent tant que le compte n'a pas été
  // reconnecté après activation du toggle. Au premier refus de scope, on cesse
  // d'essayer pour la passe entière (sinon 50 erreurs identiques par sync).
  let trashScopeMissing = false
  let trashed = 0
  async function trashMessage(msgId) {
    if (!trashOn || trashScopeMissing) return
    try {
      await gmail.users.messages.trash({ userId: 'me', id: msgId })
      trashed++
    } catch (e) {
      if (/insufficient|ACCESS_TOKEN_SCOPE|Insufficient Permission|PERMISSION_DENIED|Request had insufficient authentication scopes/i.test(e.message || '')) {
        trashScopeMissing = true
        console.warn(
          `⚠️ Gmail ${account_email}: corbeille après import impossible — scope gmail.modify manquant. ` +
          'Reconnectez ce compte depuis la page Connecteurs (bouton « Reconnecter »).'
        )
      } else {
        console.warn(`⚠️ Gmail trash ${msgId} (${account_email}):`, e.message)
      }
    }
  }
  try {
    if (labelId) {
      // Pas de filtre has:attachment : certaines factures (ex. Manychat) arrivent
      // sans pièce jointe, le corps HTML du courriel est la facture elle-même.
      const list = await gmail.users.messages.list({
        userId: 'me',
        labelIds: [labelId],
        q: '-in:drafts',
        maxResults: 50,
      })
      for (const m of list.data.messages || []) byId.set(m.id, m)
    }
    // -in:drafts : un brouillon adressé à factures@ matche `to:` sans avoir été
    // envoyé (cas vécu : un outil Google Workspace créait des brouillons de
    // transfert au corps aplati — l'ERP ingérait cette copie dégradée au lieu
    // du courriel original, pourtant présent dans la boîte connectée).
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: `-in:drafts {to:${INVOICE_RECIPIENT} cc:${INVOICE_RECIPIENT} deliveredto:${INVOICE_RECIPIENT}}`,
      maxResults: 50,
    })
    for (const m of list.data.messages || []) byId.set(m.id, m)

    if (autoDetectOn) {
      // La liste blanche est appliquée deux fois : ici pour que Gmail ne renvoie
      // que ces expéditeurs (aucun autre message n'est même lu), puis localement
      // sur l'en-tête From — un `from:` Gmail matche aussi le nom affiché.
      const senderFilter = allowedSenders.length ? ` from:(${allowedSenders.join(' OR ')})` : ''
      const auto = await gmail.users.messages.list({
        userId: 'me',
        q: `${INVOICE_AUTODETECT_QUERY}${senderFilter} newer_than:${INVOICE_AUTODETECT_DAYS}d`,
        maxResults: 50,
      })
      for (const m of auto.data.messages || []) {
        if (!byId.has(m.id)) autoDetectedIds.add(m.id)
        byId.set(m.id, m)
      }
    }
  } catch (e) {
    console.error(`❌ Gmail invoice list ${account_email}:`, e.message)
    logSync(module, trigger, { status: 'error', error: `list: ${e.message}`, durationMs: Date.now() - t0 })
    return { status: 'error', imported: 0, error: e.message }
  }
  const messages = [...byId.values()]

  let imported = 0
  for (const msgRef of messages) {
    // Déjà ingéré lors d'une passe précédente (le reçu porte ce message id) :
    // rien à réimporter, mais la corbeille après import s'applique — c'est le
    // chemin qui nettoie le backlog des factures extraites avant l'activation.
    const already = db.prepare('SELECT 1 FROM sale_receipts WHERE gmail_message_id=?').get(msgRef.id)
    if (already) { await trashMessage(msgRef.id); continue }
    if (skippedInvoiceMessageIds.has(msgRef.id)) continue

    let msg
    try { msg = await gmail.users.messages.get({ userId: 'me', id: msgRef.id, format: 'full' }) }
    catch { continue }

    // Dédup inter-boîtes : factures@ est un alias livré dans plusieurs boîtes connectées.
    // Le même courriel y porte des gmail_message_id différents mais un seul Message-ID
    // RFC822 — s'il a déjà été importé via une autre boîte, on ne le réimporte pas.
    const rfc822Id = getHeader(msg.data.payload?.headers || [], 'message-id').trim() || null
    if (rfc822Id && db.prepare('SELECT 1 FROM sale_receipts WHERE rfc822_message_id=?').get(rfc822Id)) {
      skippedInvoiceMessageIds.add(msgRef.id)
      // Copie d'une facture déjà importée via une autre boîte : ingérée quand même.
      await trashMessage(msgRef.id)
      continue
    }

    let attachments = collectAttachments(msg.data.payload)
    const autoDetected = autoDetectedIds.has(msgRef.id)

    // Autodétection : le message n'a été ni labellisé ni adressé à factures@,
    // c'est nous qui le proposons — il doit ressembler à une facture.
    if (autoDetected) {
      const headers = msg.data.payload?.headers || []
      if (!senderAllowed(getHeader(headers, 'From'), allowedSenders)) {
        skippedInvoiceMessageIds.add(msgRef.id)
        continue
      }
      const { html, text } = extractBodies(msg.data.payload)
      // Une liste blanche non vide est une intention explicite : l'expéditeur a
      // déjà passé senderAllowed, on lui fait confiance même pour un transfert
      // (cas type : facture d'entretien ménager transférée vers la boîte perso).
      const trustedSender = allowedSenders.length > 0
      const isInvoice = looksLikeInvoiceMessage({
        subject: getHeader(headers, 'Subject'),
        from: getHeader(headers, 'From'),
        bodyText: stripTrackingUrls(text || htmlToText(html)),
        attachmentNames: attachments.map(a => a.filename || ''),
        // Un fil de discussion embarque les pièces jointes ET les images de
        // signature de tous les messages cités : en autodétection on l'ignore.
        isReply: !!(getHeader(headers, 'in-reply-to') || getHeader(headers, 'references')),
        trustedSender,
      })
      if (!isInvoice) {
        skippedInvoiceMessageIds.add(msgRef.id)
        continue
      }
      // Une facture devinée doit être un PDF. Les images (photo de reçu, capture)
      // restent acceptées sur les deux voies explicites — label ERP/Factures et
      // alias factures@ — où un humain a désigné le message. En autodétection
      // elles ne rapportent que du bruit : logos et captures collés dans les
      // signatures pèsent souvent plus que le seuil de 20 Ko.
      attachments = attachments.filter(a =>
        a.mimeType === 'application/pdf' || extname(a.filename || '').toLowerCase() === '.pdf'
      )
      // Plus de pièce jointe exploitable : matérialiser n'importe quel corps en
      // PDF transformerait toute notification en « facture ». On ne le fait que
      // pour un expéditeur de facturation (billing@, receipts@…) dont le corps
      // passe le filtre strict mot-clé + montant — les reçus Webflow/Stripe
      // arrivent ainsi : sans pièce jointe, la facture EST le courriel.
      if (attachments.length === 0) {
        const bodyText = stripTrackingUrls(text || htmlToText(html))
        // Un expéditeur whitelisté n'a pas à ressembler à billing@ — mais le
        // corps doit toujours passer le filtre strict mot-clé + montant.
        if ((!trustedSender && !isBillingSender(getHeader(headers, 'From'))) ||
            !looksLikeInvoiceEmail(getHeader(headers, 'Subject'), bodyText)) {
          skippedInvoiceMessageIds.add(msgRef.id)
          continue
        }
      }
    }

    if (attachments.length === 0) {
      const inlineStatus = await importInlineInvoice({ message: msg.data, msgId: msgRef.id, userId, rfc822Id })
      if (inlineStatus === 'imported') imported++
      if (inlineStatus === 'imported' || inlineStatus === 'duplicate') await trashMessage(msgRef.id)
      continue
    }

    let importedFromMessage = 0
    let duplicatesFromMessage = 0
    for (const att of attachments) {
      let ext = extname(att.filename).toLowerCase()
      if (!RECEIPT_ATTACHMENT_EXTS.includes(ext)) {
        // Mime-based fallback (ex: "application/pdf" sans extension)
        if (att.mimeType === 'application/pdf') ext = '.pdf'
        else if (att.mimeType?.startsWith('image/')) ext = '.' + att.mimeType.slice(6)
        else continue
      }

      let data
      try {
        const r = await gmail.users.messages.attachments.get({
          userId: 'me', messageId: msgRef.id, id: att.attachmentId,
        })
        data = r.data.data
      } catch (e) {
        console.error(`❌ Gmail attachment download ${msgRef.id}:`, e.message)
        continue
      }
      if (!data) continue

      const buffer = Buffer.from(data, 'base64url')
      // Même pièce déjà en base sous un autre message (transfert, relance,
      // comptable en copie) — ou déjà supprimée par un humain : on passe.
      const hash = sha256(buffer)
      if (contentAlreadyImported(hash)) { duplicatesFromMessage++; continue }

      const id = newRecordId()
      const storedName = `${id}${ext}`
      const filePath = join(receiptsDir, storedName)
      try { writeFileSync(filePath, buffer) }
      catch (e) { console.error(`❌ Gmail attachment write ${msgRef.id}:`, e.message); continue }

      db.prepare(`
        INSERT INTO sale_receipts (id, filename, original_name, file_type, status, created_by, source, gmail_message_id, rfc822_message_id, content_sha256)
        VALUES (?, ?, ?, ?, 'processing', ?, 'email', ?, ?, ?)
      `).run(id, storedName, att.filename || storedName, ext, userId, msgRef.id, rfc822Id, hash)

      const created = db.prepare('SELECT * FROM sale_receipts WHERE id=?').get(id)
      if (created) emitEntity('sale_receipt', 'created', id, { ...created, items: [] }, userId)

      runExtractionAndUpdate({ saleReceiptId: id, filePath, fileExt: ext, userId, trigger: 'scheduled' })
      imported++
      importedFromMessage++
    }

    // Au moins une pièce ingérée (maintenant ou déjà en base) → le message a
    // rempli son rôle. Une pièce en échec de téléchargement ne bloque pas : le
    // message serait de toute façon skippé aux passes suivantes (dédup par
    // gmail_message_id), la corbeille ne fait perdre aucun retry.
    if (importedFromMessage > 0 || duplicatesFromMessage > 0) await trashMessage(msgRef.id)
  }

  if (imported > 0) console.log(`🧾 Gmail ${account_email}: ${imported} pièce(s) jointe(s) facture importée(s)`)
  if (trashed > 0) console.log(`🗑️ Gmail ${account_email}: ${trashed} courriel(s) facture mis à la corbeille après import`)
  logSync(module, trigger, { status: 'success', modified: imported, durationMs: Date.now() - t0 })
  return { status: 'success', imported }
}

/**
 * Synchronise toutes les boîtes Gmail connectées. Chaque compte est tracé
 * indépendamment dans sync_log via deux modules (`gmail:emails:<email>` et
 * `gmail:factures:<email>`) — une boîte en échec (refresh_token expiré, rate
 * limit, label manquant) reste donc visible même si les autres réussissent.
 * Retourne un résumé agrégé pour le logSystemRun macro de l'appelant.
 * @param {'scheduled'|'manual'} [trigger]
 */
// Verrou : la dédup est un « lis puis insère » entrecoupé d'appels réseau
// (messages.get, téléchargement de pièce jointe). Deux passes simultanées —
// double clic sur « Synchroniser », ou manuel qui croise l'horaire — lisent donc
// toutes les deux « pas encore importé » et insèrent chacune leur copie. Un
// appel concurrent se rattache à la passe en cours au lieu d'en lancer une autre.
let mailboxSyncInFlight = null

export async function syncAllMailboxes(trigger = 'scheduled') {
  if (mailboxSyncInFlight) {
    console.log('⏭️ Gmail sync déjà en cours — appel rattaché à la passe courante')
    return mailboxSyncInFlight
  }
  mailboxSyncInFlight = runAllMailboxes(trigger).finally(() => { mailboxSyncInFlight = null })
  return mailboxSyncInFlight
}

async function runAllMailboxes(trigger) {
  const accounts = db.prepare(`
    SELECT * FROM connector_oauth WHERE connector='google' AND refresh_token IS NOT NULL
  `).all()

  const summary = { accounts: accounts.length, emailsImported: 0, invoicesImported: 0, errors: [] }
  for (const account of accounts) {
    // Boîte « factures seulement » : on saute le sync des courriels — il aspire
    // toute la boîte dans emails/interactions et crée un contact par
    // correspondant. Sur une boîte personnelle connectée juste pour router une
    // facture fournisseur, ce serait déverser la vie privée dans le CRM.
    if (!isInvoiceOnlyMailbox(account.account_email)) {
      const a = await syncAccount(account, trigger)
      summary.emailsImported += a?.imported || 0
      if (a?.status === 'error') summary.errors.push(`emails ${account.account_email}: ${a.error}`)
    }

    const b = await syncInvoiceLabel(account, trigger)
    summary.invoicesImported += b?.imported || 0
    if (b?.status === 'error') summary.errors.push(`factures ${account.account_email}: ${b.error}`)
  }
  return summary
}
