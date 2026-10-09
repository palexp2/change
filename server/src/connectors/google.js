import { encryptCredentials, decryptCredentials } from '../utils/encryption.js'
import { google } from 'googleapis'
import db from '../db/database.js'
import { APP_URL } from '../config/appUrl.js'

const CALLBACK_URL = `${APP_URL}/erp/api/connectors/google/callback`

export function makeOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('Google OAuth credentials not configured')
  return new google.auth.OAuth2(clientId, clientSecret, CALLBACK_URL)
}

const BASE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive.readonly',
  // Écriture Drive restreinte aux fichiers créés par l'ERP (drive.file) : permet de
  // DÉPOSER un fichier dans le Drive sans élargir l'accès en lecture. Les comptes
  // connectés avant l'ajout de ce scope doivent être reconnectés depuis la page
  // Connecteurs pour que le dépôt fonctionne.
  'https://www.googleapis.com/auth/drive.file',
  // Écriture Google Sheets (CTB - Suivi, programmation des factures à payer).
  // Les comptes connectés avant l'ajout de ce scope doivent être reconnectés
  // depuis la page Connecteurs pour que l'écriture Sheets fonctionne.
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/userinfo.email',
]

// Comptes autorisés à obtenir gmail.compose (création de brouillons Gmail).
// `gmail.send` ne permet PAS drafts.create — Gmail répond
// ACCESS_TOKEN_SCOPE_INSUFFICIENT. Le scope est volontairement restreint à
// cette liste : les autres comptes gardent le consentement minimal, donc
// n'ont rien à reconnecter.
export const DRAFT_SCOPE_ACCOUNTS = ['michel@orisha.io']

export function canCreateDrafts(email) {
  return DRAFT_SCOPE_ACCOUNTS.includes(String(email || '').toLowerCase())
}

// Boîtes où les factures ingérées sont mises à la corbeille après import
// (voir gmail.js / syncInvoiceLabel). La corbeille requiert gmail.modify :
// le scope n'est demandé que pour les boîtes de cette liste (toggle
// « Corbeille après import » de la page Connecteurs), et le compte doit être
// reconnecté après activation pour que le consentement soit accordé.
export const INVOICE_TRASH_KEY = 'invoice_trash_after_import_mailboxes'

// Boîtes « factures seulement » : le sync des courriels (tables emails /
// interactions, création automatique d'un contact par correspondant) est SAUTÉ
// pour ces boîtes, seule l'ingestion des factures tourne. Prévu pour une boîte
// personnelle connectée uniquement pour router une facture fournisseur — la
// correspondance privée n'a rien à faire dans le CRM d'Orisha.
export const INVOICE_ONLY_KEY = 'invoice_only_mailboxes'

// Les listes de boîtes de connector_config partagent toutes la même forme :
// un tableau JSON d'adresses, tolérant au JSON cassé / à la clé absente.
export function mailboxList(key) {
  const row = db.prepare(
    `SELECT value FROM connector_config WHERE connector='google' AND key=?`
  ).get(key)
  if (!row?.value) return []
  try {
    const list = JSON.parse(row.value)
    return Array.isArray(list) ? list.map(e => String(e).toLowerCase()) : []
  } catch { return [] }
}

export function invoiceTrashMailboxes() {
  return mailboxList(INVOICE_TRASH_KEY)
}

export function canTrashInvoiceEmails(email) {
  return invoiceTrashMailboxes().includes(String(email || '').toLowerCase())
}

export function isInvoiceOnlyMailbox(email) {
  return mailboxList(INVOICE_ONLY_KEY).includes(String(email || '').toLowerCase())
}

// Google Agenda (prise de rendez-vous, services/meetings.js) : disponibilités
// (freebusy) + création des événements. Demandé seulement quand l'utilisateur
// branche son agenda (Paramètres → Gmail) ou l'avait déjà accordé — les autres
// comptes gardent le consentement minimal.
export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
]

export function scopesGrantCalendar(granted) {
  const list = String(granted || '').split(/\s+/)
  return CALENDAR_SCOPES.every(s => list.includes(s))
}

function accountHasCalendar(email) {
  if (!email) return false
  const row = db.prepare(
    `SELECT granted_scopes FROM connector_oauth WHERE connector='google' AND lower(account_email)=?`
  ).get(email)
  return scopesGrantCalendar(row?.granted_scopes)
}

/**
 * @param {string} state
 * @param {Object} [options]
 * @param {string} [options.loginHint] Compte visé (bouton « Reconnecter » d'un
 *   compte existant). Pré-sélectionne le compte chez Google et, s'il figure
 *   dans DRAFT_SCOPE_ACCOUNTS, ajoute le scope de création de brouillons.
 * @param {boolean} [options.calendar] Ajoute les scopes Google Agenda.
 */
export function getAuthUrl(state, options = {}) {
  const oauth2 = makeOAuth2Client()
  const loginHint = String(options.loginHint || '').trim().toLowerCase()
  const scope = [...BASE_SCOPES]
  if (canCreateDrafts(loginHint)) scope.push('https://www.googleapis.com/auth/gmail.compose')
  // Corbeille après import : messages.trash exige gmail.modify.
  if (canTrashInvoiceEmails(loginHint)) scope.push('https://www.googleapis.com/auth/gmail.modify')
  // Une reconnexion Gmail ne doit pas faire perdre l'agenda déjà accordé.
  if (options.calendar || accountHasCalendar(loginHint)) scope.push(...CALENDAR_SCOPES)
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account consent',
    scope,
    ...(loginHint ? { login_hint: loginHint } : {}),
    state,
  })
}

export async function exchangeCode(code) {
  const oauth2 = makeOAuth2Client()
  const { tokens } = await oauth2.getToken(code)
  oauth2.setCredentials(tokens)
  const info = await google.oauth2({ version: 'v2', auth: oauth2 }).userinfo.get()
  return { tokens, email: info.data.email }
}

export async function getCalendarClient(connectorOAuthId) {
  const auth = await getOAuthClientForAccount(connectorOAuthId)
  return google.calendar({ version: 'v3', auth })
}

export async function getOAuthClientForAccount(connectorOAuthId) {
  const row = db.prepare('SELECT * FROM connector_oauth WHERE id=?').get(connectorOAuthId)
  if (!row?.refresh_token) throw new Error('No Google token found')

  const oauth2 = makeOAuth2Client()
  oauth2.setCredentials({
    access_token: decryptCredentials(row.access_token),
    refresh_token: decryptCredentials(row.refresh_token),
    expiry_date: row.expiry_date,
  })
  oauth2.on('tokens', (tokens) => {
    db.prepare(`
      UPDATE connector_oauth SET access_token=?, refresh_token=COALESCE(?,refresh_token),
      expiry_date=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?
    `).run(encryptCredentials(tokens.access_token), encryptCredentials(tokens.refresh_token) || null, tokens.expiry_date || null, row.id)
  })
  return oauth2
}

export async function getGmailClient(connectorOAuthId) {
  const auth = await getOAuthClientForAccount(connectorOAuthId)
  return google.gmail({ version: 'v1', auth })
}

export async function getDriveClient(connectorOAuthId) {
  const auth = await getOAuthClientForAccount(connectorOAuthId)
  return google.drive({ version: 'v3', auth })
}

export async function getSheetsClient(connectorOAuthId) {
  const auth = await getOAuthClientForAccount(connectorOAuthId)
  return google.sheets({ version: 'v4', auth })
}
