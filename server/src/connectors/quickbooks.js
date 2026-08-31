import db from '../db/database.js'
import { logSync } from '../services/syncLog.js'
import { getCurrentUser } from '../utils/requestContext.js'
import { APP_URL } from '../config/appUrl.js'

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

// Clé de connexion par défaut (compte « entreprise »). Sert de repli pour toutes
// les écritures automatiques (webhooks Stripe, syncs planifiées) qui ne sont
// déclenchées par aucun utilisateur. Les connexions par utilisateur sont stockées
// sous account_key = <userId> et permettent à QuickBooks d'attribuer l'écriture à
// la bonne personne dans son « Historique de vérification ».
export const QB_DEFAULT_ACCOUNT_KEY = 'default'

// Détermine quelle connexion QB utiliser. Si accountKey est passé explicitement,
// on l'honore. Sinon on lit l'utilisateur courant du contexte de requête : s'il a
// sa propre connexion QB, on l'utilise ; à défaut on retombe sur 'default'.
function resolveQbRow(accountKey) {
  if (accountKey) {
    const row = db.prepare(
      "SELECT * FROM connector_oauth WHERE connector='quickbooks' AND account_key=?"
    ).get(accountKey)
    if (row) return row
  } else {
    const user = getCurrentUser()
    if (user?.id) {
      const own = db.prepare(
        "SELECT * FROM connector_oauth WHERE connector='quickbooks' AND account_key=?"
      ).get(user.id)
      if (own) return own
    }
  }
  return db.prepare(
    "SELECT * FROM connector_oauth WHERE connector='quickbooks' AND account_key=?"
  ).get(QB_DEFAULT_ACCOUNT_KEY)
}

// Mutex de refresh par connexion (account_key) pour éviter les refreshs concurrents
// d'un même jeton, tout en laissant deux connexions distinctes se rafraîchir en
// parallèle.
const refreshLocks = new Map()

export async function getAccessToken(accountKey) {
  const row = resolveQbRow(accountKey)
  if (!row) throw new Error('QuickBooks non connecté')

  const meta = JSON.parse(row.metadata || '{}')

  if (!row.expiry_date || Date.now() <= row.expiry_date - 60_000) {
    return { accessToken: row.access_token, realmId: meta.realm_id }
  }

  const lockKey = row.account_key
  if (refreshLocks.has(lockKey)) return refreshLocks.get(lockKey)

  const refreshPromise = (async () => {
    try {
      const fresh = db.prepare(
        "SELECT * FROM connector_oauth WHERE connector='quickbooks' AND account_key=?"
      ).get(lockKey)
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
      refreshLocks.delete(lockKey)
    }
  })()

  refreshLocks.set(lockKey, refreshPromise)
  return refreshPromise
}

// Subscribers notified whenever a QB write happens. Used by report caches
// (balance sheet, etc.) to invalidate themselves.
const qbMutationListeners = new Set()
export function onQbMutation(fn) { qbMutationListeners.add(fn); return () => qbMutationListeners.delete(fn) }

// Traductions FR des codes d'erreur QB les plus fréquents chez nous — le Detail
// de QB est verbeux et anglophone, on résume en une phrase actionnable.
const QB_ERROR_HINTS = {
  '610': 'l\'objet visé n\'existe plus dans QuickBooks (supprimé ou fusionné)',
  '2020': 'un champ obligatoire est manquant ou invalide',
  '6000': 'QuickBooks a refusé la transaction (règle métier — souvent une incohérence de devise, de taxe ou de compte)',
  '6240': 'ce nom existe déjà dans QuickBooks (les noms sont uniques entre Clients, Fournisseurs et Employés)',
  '6480': 'la transaction est réconciliée dans QuickBooks et ne peut pas être supprimée',
  '3200': 'la connexion QuickBooks a expiré — reconnecter QuickBooks dans Connecteurs',
}

function buildQbApiError(method, path, status, text) {
  let concise = null, code = null
  try {
    const fault = JSON.parse(text)?.Fault?.Error?.[0]
    if (fault) {
      code = fault.code || null
      const detail = (fault.Detail || fault.Message || '').replace(/\s+/g, ' ').trim()
      const hint = QB_ERROR_HINTS[code]
      concise = hint
        ? `QuickBooks : ${hint}.${detail ? ` Détail : ${detail}` : ''}`
        : `QuickBooks a refusé la demande${code ? ` (code ${code})` : ''}${detail ? ` : ${detail}` : ''}`
    }
  } catch {}
  const err = new Error(concise || `QuickBooks a répondu ${status} sur ${method} ${path}`)
  err.qbCode = code
  err.status = status
  return err
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
    // Le dump JSON complet de QB est illisible pour l'utilisateur — on en extrait
    // un message concis (le brut reste dans les logs serveur pour le debug).
    console.error(`QB API ${method} ${path} ${resp.status}:`, text)
    throw buildQbApiError(method, path, resp.status, text)
  }
  if (method !== 'GET') {
    for (const fn of qbMutationListeners) {
      try {
        fn({ method, path })
      } catch (e) {
        // Un listener qui échoue (ex. invalidation de cache de rapport, mise à
        // jour d'état local après une JE/Deposit poussé) ne doit pas être avalé :
        // sans trace, l'état ERP↔QB diverge silencieusement et devient impossible
        // à diagnostiquer après coup.
        const listenerName = fn.name || 'anonymous'
        console.error(`qbMutationListener "${listenerName}" failed for ${method} ${path}:`, e)
        logSync('quickbooks', 'webhook', {
          status: 'error',
          error: `mutation listener "${listenerName}" failed for ${method} ${path}: ${e.message}`,
        })
      }
    }
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

// Téléverse un fichier comme pièce jointe attachée à une entité QB (Bill, Purchase,
// Invoice, etc.) via l'endpoint /upload. Retourne l'Attachable créé.
export async function qbUploadAttachment({ entityType, entityId, fileBuffer, fileName, contentType }) {
  const { default: FormData } = await import('form-data')
  const { default: nodeFetch } = await import('node-fetch')
  const { accessToken, realmId } = await getAccessToken()
  const url = `${QB_API_BASE}/${realmId}/upload?minorversion=65`

  const metadata = {
    AttachableRef: [{ EntityRef: { type: entityType, value: String(entityId) } }],
    FileName: fileName,
    ContentType: contentType,
  }

  const form = new FormData()
  form.append('file_metadata_01', JSON.stringify(metadata), {
    contentType: 'application/json',
    filename: 'metadata.json',
  })
  form.append('file_content_01', fileBuffer, { filename: fileName, contentType })

  const resp = await nodeFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...form.getHeaders(),
    },
    body: form,
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`QB upload attachment ${resp.status}: ${text}`)
  }
  const data = await resp.json()
  return data?.AttachableResponse?.[0]?.Attachable || null
}
