import db from '../db/database.js'

const APP_URL = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
const CALLBACK_URL = `${APP_URL}/erp/api/connectors/quickbooks/callback`
const QB_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2'
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
export const QB_API_BASE = process.env.QB_SANDBOX === 'true'
  ? 'https://sandbox-quickbooks.api.intuit.com/v3/company'
  : 'https://quickbooks.api.intuit.com/v3/company'

function getCredentials() {
  const clientId = process.env.QB_CLIENT_ID
  const clientSecret = process.env.QB_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('QuickBooks credentials not configured (QB_CLIENT_ID, QB_CLIENT_SECRET)')
  return { clientId, clientSecret }
}

export function getAuthUrl(state) {
  const { clientId } = getCredentials()
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: CALLBACK_URL,
    state,
  })
  return `${QB_AUTH_URL}?${params}`
}

export async function exchangeCode(code) {
  const { clientId, clientSecret } = getCredentials()
  const resp = await fetch(QB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK_URL }),
  })
  if (!resp.ok) throw new Error(`QB token exchange failed: ${await resp.text()}`)
  return resp.json()
}

// Mutex pour éviter les refreshs concurrents
let refreshLock = null

export async function getAccessToken() {
  const row = db.prepare(`
    SELECT * FROM connector_oauth WHERE connector='quickbooks'
    ORDER BY updated_at DESC LIMIT 1
  `).get()
  if (!row) throw new Error('QuickBooks non connecté')

  const meta = JSON.parse(row.metadata || '{}')

  if (!row.expiry_date || Date.now() <= row.expiry_date - 60_000) {
    return { accessToken: row.access_token, realmId: meta.realm_id }
  }

  if (refreshLock) return refreshLock

  const refreshPromise = (async () => {
    try {
      const fresh = db.prepare(`
        SELECT * FROM connector_oauth WHERE connector='quickbooks'
        ORDER BY updated_at DESC LIMIT 1
      `).get()
      if (fresh && (!fresh.expiry_date || Date.now() <= fresh.expiry_date - 60_000)) {
        return { accessToken: fresh.access_token, realmId: JSON.parse(fresh.metadata || '{}').realm_id }
      }

      const { clientId, clientSecret } = getCredentials()
      const resp = await fetch(QB_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
          Accept: 'application/json',
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: fresh.refresh_token }),
      })
      if (!resp.ok) {
        console.error(`❌ QB refresh failed (${resp.status}):`, await resp.text())
        throw new Error('Token QuickBooks expiré — veuillez reconnecter dans Connecteurs')
      }
      const t = await resp.json()
      db.prepare(`
        UPDATE connector_oauth
        SET access_token=?, refresh_token=COALESCE(?,refresh_token), expiry_date=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id=?
      `).run(t.access_token, t.refresh_token || null, t.expires_in ? Date.now() + t.expires_in * 1000 : null, fresh.id)
      return { accessToken: t.access_token, realmId: JSON.parse(fresh.metadata || '{}').realm_id }
    } finally {
      refreshLock = null
    }
  })()

  refreshLock = refreshPromise
  return refreshPromise
}

export async function qbRequest(method, path, body) {
  const { accessToken, realmId } = await getAccessToken()
  const sep = path.includes('?') ? '&' : '?'
  const url = `${QB_API_BASE}/${realmId}${path}${sep}minorversion=65`
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`QB API ${method} ${path} ${resp.status}: ${text}`)
  }
  return resp.json()
}

export const qbGet  = (path)       => qbRequest('GET',  path)
export const qbPost = (path, body) => qbRequest('POST', path, body)

// Read realm_id without triggering a token refresh — only used to build deep
// links to QB app pages (which don't need the access token, just the realm).
export function getQbRealmIdSync() {
  const row = db.prepare(`
    SELECT metadata FROM connector_oauth WHERE connector='quickbooks'
    ORDER BY updated_at DESC LIMIT 1
  `).get()
  if (!row) return null
  try { return JSON.parse(row.metadata || '{}').realm_id || null } catch { return null }
}

const QB_APP_HOST = process.env.QB_SANDBOX === 'true'
  ? 'https://app.sandbox.qbo.intuit.com'
  : 'https://app.qbo.intuit.com'

// Build a clickable URL to a QB entity's edit page. Returns null if realm_id missing.
export function qbEntityUrl(entity, txnId) {
  const realmId = getQbRealmIdSync()
  if (!realmId || !txnId) return null
  return `${QB_APP_HOST}/app/${entity}?txnId=${txnId}`
}

// Récupère l'URL signée (S3) pour télécharger une pièce jointe QB.
// L'endpoint /download/{id} retourne du texte brut (pas du JSON) contenant l'URL.
export async function qbAttachmentDownloadUrl(attachmentId) {
  const { accessToken, realmId } = await getAccessToken()
  const url = `${QB_API_BASE}/${realmId}/download/${attachmentId}?minorversion=65`
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'text/plain',
    },
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`QB download ${attachmentId} ${resp.status}: ${text}`)
  }
  return (await resp.text()).trim()
}
