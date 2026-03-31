import { google } from 'googleapis'
import db from '../db/database.js'

const APP_URL = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
const CALLBACK_URL = `${APP_URL}/erp/api/connectors/google/callback`

export function makeOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('Google OAuth credentials not configured')
  return new google.auth.OAuth2(clientId, clientSecret, CALLBACK_URL)
}

export function getAuthUrl(state) {
  const oauth2 = makeOAuth2Client()
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
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

export async function getOAuthClientForAccount(connectorOAuthId) {
  const row = db.prepare('SELECT * FROM connector_oauth WHERE id=?').get(connectorOAuthId)
  if (!row?.refresh_token) throw new Error('No Google token found')

  const oauth2 = makeOAuth2Client()
  oauth2.setCredentials({
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expiry_date: row.expiry_date,
  })
  oauth2.on('tokens', (tokens) => {
    db.prepare(`
      UPDATE connector_oauth SET access_token=?, refresh_token=COALESCE(?,refresh_token),
      expiry_date=?, updated_at=datetime('now') WHERE id=?
    `).run(tokens.access_token, tokens.refresh_token || null, tokens.expiry_date || null, row.id)
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
