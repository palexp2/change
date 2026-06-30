import db from '../db/database.js'

// ── Connecteur Amazon Business ────────────────────────────────────────────────
// OAuth « Login With Amazon » (LWA) + accès à l'API Amazon Business pour récupérer
// automatiquement les factures d'achat (Reconciliation API → Document API).
//
// Flux d'authentification (cf. https://docs.business.amazon.com/docs/generate-refresh-token) :
//   1. Rediriger l'utilisateur vers AUTH_URL (param `applicationId`, pas `client_id`).
//   2. Amazon redirige vers notre callback avec un `code` (valide 5 min).
//   3. Échanger le code contre access_token (1 h) + refresh_token (permanent) sur TOKEN_URL.
//   4. Rafraîchir l'access_token via le refresh_token quand il expire.
//
// ⚠️ À CONFIRMER À L'ONBOARDING (valeurs révélées dans le Solution Provider Portal
// une fois la demande approuvée — laissées en env vars pour ne rien coder en dur) :
//   - AMAZON_API_BASE : host de base de l'API Amazon Business pour la région NA
//     (qqch comme https://na.business-api.amazon.com — confirmer dans le portail).
//   - AMAZON_APPLICATION_ID : l'applicationId de l'app cliente (≠ client_id LWA).
//   - Le scope/marketplace exact (Canada .ca) à passer le cas échéant.

const APP_URL = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
const CALLBACK_URL = `${APP_URL}/erp/api/connectors/amazon/callback`

// Endpoints LWA (stables, communs à toutes les apps Amazon Business)
const AUTH_URL = process.env.AMAZON_AUTH_URL || 'https://www.amazon.com/b2b/abws/oauth'
const TOKEN_URL = process.env.AMAZON_TOKEN_URL || 'https://api.amazon.com/auth/O2/token'

// Host de l'API Amazon Business (NA). À confirmer à l'onboarding.
export const AMAZON_API_BASE = (process.env.AMAZON_API_BASE || 'https://na.business-api.amazon.com').replace(/\/$/, '')

// Mutex : évite les refreshs concurrents (même pattern qu'airtable.js / quickbooks.js)
let refreshLock = null

function getCredentials() {
  const clientId = process.env.AMAZON_CLIENT_ID
  const clientSecret = process.env.AMAZON_CLIENT_SECRET
  // applicationId est spécifique à Amazon Business (utilisé dans l'URL d'autorisation).
  const applicationId = process.env.AMAZON_APPLICATION_ID
  if (!clientId || !clientSecret) {
    throw new Error('Amazon Business credentials not configured (AMAZON_CLIENT_ID, AMAZON_CLIENT_SECRET)')
  }
  return { clientId, clientSecret, applicationId }
}

// True si les env vars sont présentes (sert à griser la carte UI tant que non onboardé).
export function isAmazonConfigured() {
  return !!(process.env.AMAZON_CLIENT_ID && process.env.AMAZON_CLIENT_SECRET)
}

export function getAuthUrl(state) {
  const { applicationId } = getCredentials()
  const params = new URLSearchParams({
    applicationId: applicationId || '',
    redirect_uri: CALLBACK_URL,
    state,
  })
  return `${AUTH_URL}?${params}`
}

export async function exchangeCode(code) {
  const { clientId, clientSecret } = getCredentials()
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: CALLBACK_URL,
    }),
  })
  if (!resp.ok) throw new Error(`Amazon token exchange failed: ${await resp.text()}`)
  return resp.json()
}

export async function getAccessToken() {
  const row = db.prepare(`
    SELECT * FROM connector_oauth WHERE connector='amazon'
    ORDER BY updated_at DESC LIMIT 1
  `).get()
  if (!row) throw new Error('Amazon Business non connecté')

  // Token valide → retour immédiat (buffer 60 s)
  if (!row.expiry_date || Date.now() <= row.expiry_date - 60_000) {
    return row.access_token
  }

  // Un refresh est déjà en cours → attendre sa résolution
  if (refreshLock) return refreshLock

  const refreshPromise = (async () => {
    try {
      // Double-checked : un waiter précédent a peut-être déjà rafraîchi
      const fresh = db.prepare(`
        SELECT * FROM connector_oauth WHERE connector='amazon'
        ORDER BY updated_at DESC LIMIT 1
      `).get()
      if (fresh && (!fresh.expiry_date || Date.now() <= fresh.expiry_date - 60_000)) {
        return fresh.access_token
      }

      const { clientId, clientSecret } = getCredentials()
      const resp = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: fresh.refresh_token,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      })
      if (!resp.ok) {
        console.error(`❌ Amazon refresh failed (${resp.status}):`, await resp.text())
        throw new Error('Token Amazon Business expiré — veuillez reconnecter dans Connecteurs')
      }
      const t = await resp.json()
      db.prepare(`
        UPDATE connector_oauth
        SET access_token=?, refresh_token=COALESCE(?,refresh_token), expiry_date=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id=?
      `).run(t.access_token, t.refresh_token || null, t.expires_in ? Date.now() + t.expires_in * 1000 : null, fresh.id)
      return t.access_token
    } finally {
      refreshLock = null
    }
  })()

  refreshLock = refreshPromise
  return refreshPromise
}

// Requête générique à l'API Amazon Business avec Bearer token + retry sur 429.
export async function amazonRequest(method, path, { body, accept = 'application/json' } = {}, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const accessToken = await getAccessToken()
    const resp = await fetch(`${AMAZON_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: accept,
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (resp.status === 429) {
      await new Promise(r => setTimeout(r, (attempt + 1) * 2000))
      continue
    }
    if (!resp.ok) throw new Error(`Amazon API ${method} ${path} ${resp.status}: ${await resp.text()}`)
    return resp
  }
  throw new Error('Amazon rate limit persistant')
}

export const amazonGet = (path, opts) => amazonRequest('GET', path, opts).then(r => r.json())
export const amazonPost = (path, body, opts) => amazonRequest('POST', path, { body, ...opts }).then(r => r.json())
