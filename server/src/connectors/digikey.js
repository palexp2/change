import db from '../db/database.js'
import { encryptCredentials, decryptCredentials } from '../utils/encryption.js'

// ── Connecteur DigiKey ────────────────────────────────────────────────────────
// OAuth2 **client credentials** (plan développeur DigiKey : une application
// « Production » du portail developer.digikey.com donne un client_id/secret qui
// s'échange directement contre un access_token, sans redirection utilisateur —
// contrairement à Amazon/QuickBooks). Le token vit ~10 minutes : on le garde en
// mémoire et on le remint à la demande, rien à persister.
//
// Les identifiants vivent dans `connector_config` (saisis depuis /connectors),
// pas dans .env : l'utilisateur doit pouvoir les changer sans redéploiement.
// Le secret est chiffré avec CONNECTOR_ENCRYPTION_KEY.
//
// Sens unique DigiKey → ERP : aucune écriture n'est jamais poussée vers DigiKey.

const CONNECTOR = 'digikey'

// Les chemins d'API sont configurables parce que DigiKey a déjà fait bouger sa
// gamme (OrderDetails v3 → OrderStatus v4) et qu'un plan développeur peut être
// approuvé sur une version plutôt qu'une autre : pouvoir corriger un chemin
// depuis l'UI évite un déploiement pour un renommage d'endpoint.
export const DEFAULTS = {
  api_base: 'https://api.digikey.com',
  sandbox_api_base: 'https://sandbox-api.digikey.com',
  sandbox: '0',
  customer_id: '',
  locale_site: 'CA',
  locale_language: 'en',
  locale_currency: 'CAD',
  history_path: '/orderstatus/v4/history',
  salesorder_path: '/orderstatus/v4/salesorder/{salesOrderId}',
  invoice_path: '/orderstatus/v4/salesorder/{salesOrderId}/invoice/{invoiceId}',
}
// `lookback_days` et `vendor_name` ne sont PAS ici : ce sont des réglages
// métier, éditables dans l'automation système `sys_digikey_orders`. Le
// connecteur ne porte que ce qui touche à l'accès à l'API.

const SECRET_KEYS = new Set(['client_secret'])

let tokenCache = null // { token, expiresAt }
let tokenLock = null

export function getConfig() {
  const rows = db.prepare('SELECT key, value FROM connector_config WHERE connector = ?').all(CONNECTOR)
  const cfg = { ...DEFAULTS, client_id: '', client_secret: '' }
  for (const r of rows) {
    cfg[r.key] = SECRET_KEYS.has(r.key) ? decryptCredentials(r.value) : r.value
  }
  // Repli sur l'environnement si les clés n'ont jamais été saisies dans l'UI.
  if (!cfg.client_id && process.env.DIGIKEY_CLIENT_ID) cfg.client_id = process.env.DIGIKEY_CLIENT_ID
  if (!cfg.client_secret && process.env.DIGIKEY_CLIENT_SECRET) cfg.client_secret = process.env.DIGIKEY_CLIENT_SECRET
  return cfg
}

export function saveConfig(patch) {
  const upsert = db.prepare(`
    INSERT INTO connector_config (connector, key, value)
    VALUES (?, ?, ?)
    ON CONFLICT (connector, key) DO UPDATE SET value = excluded.value
  `)
  const allowed = new Set([...Object.keys(DEFAULTS), 'client_id', 'client_secret'])
  const tx = db.transaction(() => {
    for (const [key, raw] of Object.entries(patch || {})) {
      if (!allowed.has(key)) continue
      if (raw === undefined || raw === null) continue
      const value = String(raw)
      // Un secret vide veut dire « ne change pas » (le champ UI est toujours vide
      // à l'affichage) ; pour effacer, DELETE /config.
      if (SECRET_KEYS.has(key)) {
        if (!value) continue
        upsert.run(CONNECTOR, key, encryptCredentials(value))
      } else {
        upsert.run(CONNECTOR, key, value)
      }
    }
  })
  tx()
  clearTokenCache()
}

export function deleteConfig() {
  db.prepare('DELETE FROM connector_config WHERE connector = ?').run(CONNECTOR)
  clearTokenCache()
}

export function clearTokenCache() {
  tokenCache = null
}

export function isDigikeyConfigured() {
  const cfg = getConfig()
  return !!(cfg.client_id && cfg.client_secret)
}

export function apiBase(cfg = getConfig()) {
  return (cfg.sandbox === '1' ? cfg.sandbox_api_base : cfg.api_base).replace(/\/$/, '')
}

// ── Token client_credentials ────────────────────────────────────────────────
export async function getAccessToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.token
  if (tokenLock) return tokenLock

  tokenLock = (async () => {
    try {
      const cfg = getConfig()
      if (!cfg.client_id || !cfg.client_secret) {
        throw new Error('DigiKey non configuré (client_id / client_secret manquants)')
      }
      const resp = await fetch(`${apiBase(cfg)}/v1/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: cfg.client_id,
          client_secret: cfg.client_secret,
        }),
      })
      if (!resp.ok) {
        throw new Error(`DigiKey OAuth ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
      }
      const t = await resp.json()
      if (!t.access_token) throw new Error('DigiKey OAuth : pas d\'access_token dans la réponse')
      tokenCache = {
        token: t.access_token,
        expiresAt: Date.now() + (Number(t.expires_in) || 600) * 1000,
      }
      return tokenCache.token
    } finally {
      tokenLock = null
    }
  })()

  return tokenLock
}

// Requête générique : Bearer + en-têtes DigiKey obligatoires, retry sur 429,
// une seule reprise sur 401 (token périmé côté DigiKey).
export async function digikeyRequest(method, path, { accept = 'application/json', body } = {}, retries = 3) {
  const cfg = getConfig()
  const url = path.startsWith('http') ? path : `${apiBase(cfg)}${path}`

  for (let attempt = 0; attempt <= retries; attempt++) {
    const token = await getAccessToken()
    const headers = {
      Authorization: `Bearer ${token}`,
      'X-DIGIKEY-Client-Id': cfg.client_id,
      'X-DIGIKEY-Locale-Site': cfg.locale_site || 'CA',
      'X-DIGIKEY-Locale-Language': cfg.locale_language || 'en',
      'X-DIGIKEY-Locale-Currency': cfg.locale_currency || 'CAD',
      Accept: accept,
    }
    if (cfg.customer_id) headers['X-DIGIKEY-Customer-Id'] = cfg.customer_id
    if (body) headers['Content-Type'] = 'application/json'

    const resp = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })

    if (resp.status === 429) {
      await new Promise(r => setTimeout(r, (attempt + 1) * 2000))
      continue
    }
    if (resp.status === 401 && attempt === 0) {
      clearTokenCache()
      continue
    }
    if (!resp.ok) {
      throw new Error(`DigiKey ${method} ${path} ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
    }
    return resp
  }
  throw new Error('DigiKey : limite de débit persistante (429)')
}

export const digikeyGet = (path, opts) => digikeyRequest('GET', path, opts).then(r => r.json())

// Récupère un binaire (PDF de facture). Renvoie { buffer, contentType }.
export async function digikeyGetBinary(path) {
  const resp = await digikeyRequest('GET', path, { accept: 'application/pdf' })
  const contentType = resp.headers.get('content-type') || ''
  const buffer = Buffer.from(await resp.arrayBuffer())
  return { buffer, contentType }
}
