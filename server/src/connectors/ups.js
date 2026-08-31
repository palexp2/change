import { makeConfigStore } from './configStore.js'

// ── Connecteur UPS ────────────────────────────────────────────────────────────
// OAuth 2.0 **client_credentials** (POST /security/v1/oauth/token, Basic auth
// client_id:client_secret) — même famille que DigiKey : pas de redirection
// utilisateur, un jeton s'obtient directement. Le jeton UPS vit ~4 h
// (expires_in = 14399 s) : on le garde en mémoire et on le remint à l'expiration.
//
// Les identifiants (client_id, client_secret, numéro de compte UPS) vivent dans
// `connector_config`, CHIFFRÉS avec CONNECTOR_ENCRYPTION_KEY — l'utilisateur
// doit pouvoir les changer depuis /connectors sans redéploiement.
//
// Environnement : UPS expose deux domaines strictement séparés — CIE (« Customer
// Integration Environment », bac à sable, aucune facturation) et production.
// Le défaut vient de la variable d'environnement UPS_ENV (`cie` | `production`),
// surchargeable depuis l'UI (clé `environment`). Un mauvais environnement se
// voit tout de suite : les identifiants CIE sont refusés en prod et l'inverse.

const CONNECTOR = 'ups'

export const CIE_BASE = 'https://wwwcie.ups.com'
export const PROD_BASE = 'https://onlinetools.ups.com'

export const DEFAULTS = {
  environment: '', // '' → repli sur UPS_ENV, puis 'cie'
  // Versions d'API configurables : UPS versionne par date (v1, v2409, v2504…)
  // et fait tourner ses versions supportées. Pouvoir corriger depuis l'UI évite
  // un déploiement quand une version est retirée.
  shipping_version: 'v1',
  rating_version: 'v1',
  tracking_version: 'v1',
}

const store = makeConfigStore({
  connector: CONNECTOR,
  defaults: DEFAULTS,
  credentialKeys: ['client_id', 'client_secret', 'account_number'],
  // Tout ce qui identifie le compte de facturation UPS est chiffré au repos.
  secretKeys: ['client_id', 'client_secret', 'account_number'],
  envFallbacks: {
    client_id: 'UPS_CLIENT_ID',
    client_secret: 'UPS_CLIENT_SECRET',
    account_number: 'UPS_ACCOUNT_NUMBER',
  },
  normalize: (cfg) => {
    if (!cfg.environment) cfg.environment = (process.env.UPS_ENV || 'cie').toLowerCase()
    if (cfg.environment !== 'production') cfg.environment = 'cie'
  },
})

export const { getConfig, saveConfig, deleteConfig, publicConfig, clearTokenCache } = store

export function isUpsConfigured() {
  const cfg = getConfig()
  return !!(cfg.client_id && cfg.client_secret && cfg.account_number)
}

export function apiBase(cfg = getConfig()) {
  return cfg.environment === 'production' ? PROD_BASE : CIE_BASE
}

// Extrait le message d'erreur BRUT de l'API UPS. UPS répond
// `{ response: { errors: [{ code, message }] } }` sur la plupart de ses
// endpoints, mais parfois du texte/HTML (passerelle). On ne masque jamais :
// le message remonte tel quel au toast et au journal (CLAUDE.md — jamais
// d'échec silencieux).
export function describeUpsError(context, status, bodyText) {
  let detail = String(bodyText || '').trim()
  try {
    const json = JSON.parse(detail)
    const errs = json?.response?.errors || json?.errors || json?.response?.error
    if (Array.isArray(errs) && errs.length) {
      detail = errs.map(e => `${e.code ? `[${e.code}] ` : ''}${e.message || e.description || JSON.stringify(e)}`).join(' · ')
    }
  } catch { /* pas du JSON — on garde le texte brut */ }
  if (detail.length > 800) detail = `${detail.slice(0, 800)}…`
  return `UPS ${context} (HTTP ${status}) : ${detail || 'réponse vide'}`
}

function upsError(context, status, bodyText, sentPayload) {
  const err = new Error(describeUpsError(context, status, bodyText))
  err.status = status
  err.responseBody = typeof bodyText === 'string' ? bodyText.slice(0, 4000) : null
  if (sentPayload) err.sentPayload = sentPayload
  return err
}

// ── Token client_credentials (~4 h) ──────────────────────────────────────────
export async function getAccessToken() {
  return store.getCachedToken(async () => {
    const cfg = getConfig()
    if (!cfg.client_id || !cfg.client_secret) {
      throw new Error('UPS non configuré (client_id / client_secret manquants — page Connecteurs)')
    }
    const basic = Buffer.from(`${cfg.client_id}:${cfg.client_secret}`).toString('base64')
    const resp = await fetch(`${apiBase(cfg)}/security/v1/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cfg.account_number ? { 'x-merchant-id': cfg.account_number } : {}),
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    })
    if (!resp.ok) throw upsError('OAuth /security/v1/oauth/token', resp.status, await resp.text())
    const t = await resp.json()
    if (!t.access_token) throw new Error("UPS OAuth : pas d'access_token dans la réponse")
    // expires_in vient en secondes sous forme de chaîne ("14399" ≈ 4 h).
    return {
      token: t.access_token,
      expiresAt: Date.now() + (Number(t.expires_in) || 14399) * 1000,
    }
  })
}

// Requête générique JSON. Une seule reprise sur 401 (jeton périmé côté UPS).
export async function upsRequest(method, path, { body, headers = {}, context } = {}) {
  const cfg = getConfig()
  const url = path.startsWith('http') ? path : `${apiBase(cfg)}${path}`
  const label = context || `${method} ${path}`

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAccessToken()
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        transId: `erp-${Date.now()}`,
        transactionSrc: 'erp-orisha',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (resp.status === 401 && attempt === 0) {
      clearTokenCache()
      continue
    }
    if (!resp.ok) throw upsError(label, resp.status, await resp.text(), body)
    return resp.json()
  }
  throw new Error(`UPS ${label} : authentification refusée après renouvellement du jeton`)
}
