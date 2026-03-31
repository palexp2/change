import db from '../db/database.js'

const APP_URL = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
const CALLBACK_URL = `${APP_URL}/erp/api/connectors/airtable/callback`

// Mutex par tenant : évite les refreshs concurrents qui invalident le refresh token (rotation Airtable)
// Clé = tenantId, valeur = Promise du refresh en cours
const refreshLocks = new Map()

function getCredentials() {
  const clientId = process.env.AIRTABLE_CLIENT_ID
  const clientSecret = process.env.AIRTABLE_CLIENT_SECRET
  if (!clientId) throw new Error('Airtable credentials not configured')
  return { clientId, clientSecret }
}

export function getAuthUrl(state, codeChallenge) {
  const { clientId } = getCredentials()
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: CALLBACK_URL,
    response_type: 'code',
    scope: 'data.records:read data.records:write schema.bases:read webhook:manage',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  return `https://airtable.com/oauth2/v1/authorize?${params}`
}

export async function exchangeCode(code, codeVerifier) {
  const { clientId, clientSecret } = getCredentials()
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (clientSecret) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  }
  const resp = await fetch('https://airtable.com/oauth2/v1/token', {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK_URL,
      client_id: clientId,
      code_verifier: codeVerifier,
    }),
  })
  if (!resp.ok) throw new Error(`Airtable token exchange failed: ${await resp.text()}`)
  return resp.json()
}

export async function getAccessToken(tenantId) {
  const row = db.prepare(`
    SELECT * FROM connector_oauth WHERE tenant_id=? AND connector='airtable'
    ORDER BY updated_at DESC LIMIT 1
  `).get(tenantId)
  if (!row) throw new Error('Airtable non connecté')

  // Token valide → retour immédiat
  if (!row.expiry_date || Date.now() <= row.expiry_date - 60_000) {
    return row.access_token
  }

  // Un refresh est déjà en cours pour ce tenant → attendre sa résolution
  if (refreshLocks.has(tenantId)) {
    return refreshLocks.get(tenantId)
  }

  // Acquérir le verrou : tous les appelants concurrents attendront cette Promise
  const refreshPromise = (async () => {
    try {
      // Double-checked : un waiter précédent a peut-être déjà rafraîchi
      const fresh = db.prepare(`
        SELECT * FROM connector_oauth WHERE tenant_id=? AND connector='airtable'
        ORDER BY updated_at DESC LIMIT 1
      `).get(tenantId)
      if (fresh && (!fresh.expiry_date || Date.now() <= fresh.expiry_date - 60_000)) {
        return fresh.access_token
      }

      const { clientId, clientSecret } = getCredentials()
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
      if (clientSecret) {
        headers['Authorization'] = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
      }
      const resp = await fetch('https://airtable.com/oauth2/v1/token', {
        method: 'POST',
        headers,
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: fresh.refresh_token }),
      })
      if (!resp.ok) {
        const body = await resp.text()
        console.error(`❌ Airtable refresh failed (${resp.status}):`, body)
        throw new Error('Token Airtable expiré — veuillez reconnecter dans Connecteurs')
      }
      const tokens = await resp.json()
      db.prepare(`
        UPDATE connector_oauth
        SET access_token=?, refresh_token=COALESCE(?,refresh_token), expiry_date=?, updated_at=datetime('now')
        WHERE id=?
      `).run(tokens.access_token, tokens.refresh_token || null, tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null, fresh.id)
      return tokens.access_token
    } finally {
      refreshLocks.delete(tenantId)
    }
  })()

  refreshLocks.set(tenantId, refreshPromise)
  return refreshPromise
}

export async function airtablePost(path, accessToken, body) {
  const resp = await fetch(`https://api.airtable.com/v0${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) throw new Error(`Airtable POST ${path} ${resp.status}: ${await resp.text()}`)
  return resp.json()
}

export async function airtableFetch(path, accessToken, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(`https://api.airtable.com/v0${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (resp.status === 429) {
      await new Promise(r => setTimeout(r, (attempt + 1) * 2000))
      continue
    }
    if (!resp.ok) throw new Error(`Airtable API ${resp.status}: ${await resp.text()}`)
    return resp.json()
  }
  throw new Error('Airtable rate limit persistant')
}
