import db from '../db/database.js'
import { APP_URL } from '../config/appUrl.js'

const CALLBACK_URL = `${APP_URL}/erp/api/connectors/airtable/callback`

// Mutex : évite les refreshs concurrents qui invalident le refresh token (rotation Airtable)
let refreshLock = null

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
    scope: 'data.records:read data.records:write schema.bases:read schema.bases:write webhook:manage',
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

export async function getAccessToken() {
  const row = db.prepare(`
    SELECT * FROM connector_oauth WHERE connector='airtable'
    ORDER BY updated_at DESC LIMIT 1
  `).get()
  if (!row) throw new Error('Airtable non connecté')

  // Token valide → retour immédiat
  if (!row.expiry_date || Date.now() <= row.expiry_date - 60_000) {
    return row.access_token
  }

  // Un refresh est déjà en cours → attendre sa résolution
  if (refreshLock) {
    return refreshLock
  }

  // Acquérir le verrou : tous les appelants concurrents attendront cette Promise
  const refreshPromise = (async () => {
    try {
      // Double-checked : un waiter précédent a peut-être déjà rafraîchi
      const fresh = db.prepare(`
        SELECT * FROM connector_oauth WHERE connector='airtable'
        ORDER BY updated_at DESC LIMIT 1
      `).get()
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
        SET access_token=?, refresh_token=COALESCE(?,refresh_token), expiry_date=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id=?
      `).run(tokens.access_token, tokens.refresh_token || null, tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null, fresh.id)
      return tokens.access_token
    } finally {
      refreshLock = null
    }
  })()

  refreshLock = refreshPromise
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

// (airtablePost ci-dessus est aussi utilisé par le create ERP→Airtable.)
// PATCH d'un ou plusieurs records. Utilisé par le write-back ERP→Airtable.
// `body` suit la forme attendue par l'API Airtable, ex:
//   { fields: {...} }                              (PATCH /{baseId}/{tableId}/{recordId})
//   { records: [{ id, fields }], typecast: true }  (PATCH /{baseId}/{tableId})
export async function airtablePatch(path, accessToken, body) {
  const resp = await fetch(`https://api.airtable.com/v0${path}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) throw new Error(`Airtable PATCH ${path} ${resp.status}: ${await resp.text()}`)
  return resp.json()
}

// Timeout par défaut sur chaque requête HTTP Airtable. Sans ça, si Airtable ou
// le DNS pend, fetch() ne résout jamais et la boucle de pagination du webhook
// router (airtableWebhooks.js) bloque tous les autres pings indéfiniment. Un
// AbortController transforme le hang en échec traçable et retryable.
const AIRTABLE_FETCH_TIMEOUT_MS = 20000

// ── Cache mémoire des métadonnées de tables (/meta/bases/:id/tables) ────────
// L'endpoint meta d'Airtable est lent (plusieurs secondes sur une grosse base,
// pire quand un 429 partagé avec les syncs déclenche les backoffs de
// airtableFetch) : les modales de mapping de champs l'attendaient à chaque
// ouverture. Stratégie stale-while-revalidate : frais (< 60s) → retour direct ;
// périmé → retour immédiat de la version périmée + rafraîchissement en
// arrière-plan ; vide → fetch réel. Les appels concurrents (ex. onglets Paies
// + Items de paie de la même modale) partagent le même fetch en vol.
const baseTablesCache = new Map() // baseId → { data, fetchedAt, inflight }
const BASE_TABLES_FRESH_MS = 60_000

export async function getBaseTablesCached(baseId) {
  const entry = baseTablesCache.get(baseId) || {}
  if (entry.data && Date.now() - entry.fetchedAt < BASE_TABLES_FRESH_MS) return entry.data
  if (!entry.inflight) {
    entry.inflight = (async () => {
      const token = await getAccessToken()
      const data = await airtableFetch(`/meta/bases/${baseId}/tables`, token)
      baseTablesCache.set(baseId, { data, fetchedAt: Date.now(), inflight: null })
      return data
    })()
    // Échec du refresh : libérer le verrou pour retenter au prochain appel.
    // (Le rejet reste propagé aux appelants sans version périmée ci-dessous.)
    entry.inflight.catch(() => {
      const e = baseTablesCache.get(baseId)
      if (e) e.inflight = null
    })
    baseTablesCache.set(baseId, entry)
  }
  if (entry.data) return entry.data // stale-while-revalidate
  return entry.inflight
}

export async function airtableFetch(path, accessToken, retries = 3, timeoutMs = AIRTABLE_FETCH_TIMEOUT_MS) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let resp
    try {
      resp = await fetch(`https://api.airtable.com/v0${path}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      })
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(`Airtable fetch timeout après ${timeoutMs}ms: ${path}`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
    if (resp.status === 429) {
      await new Promise(r => setTimeout(r, (attempt + 1) * 2000))
      continue
    }
    if (!resp.ok) throw new Error(`Airtable API ${resp.status}: ${await resp.text()}`)
    return resp.json()
  }
  throw new Error('Airtable rate limit persistant')
}
