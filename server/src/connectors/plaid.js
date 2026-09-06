// Connecteur Plaid — lecture des transactions bancaires en temps quasi réel,
// troisième source d'alimentation de bank_transactions à côté du collage
// manuel et de la sync TRX_Orisha (services/bankTrxSheet.js). Voir
// services/plaidSync.js pour le mapping vers bank_transactions.
//
// Un « item » Plaid = une connexion à une institution (peut couvrir plusieurs
// comptes/cartes). L'access_token qui en résulte est permanent (pas de
// refresh_token côté Plaid) mais donne un accès direct aux données bancaires
// réelles de l'entreprise : c'est la credential la plus sensible du système,
// donc — contrairement au reste de connector_oauth, stocké en clair — elle est
// chiffrée ici via encryptCredentials/decryptCredentials (voir §9 du plan).
import { PlaidApi, PlaidEnvironments, Configuration, Products, CountryCode } from 'plaid'
import { newRecordId } from '../utils/recordId.js'
import { createHash, createPublicKey } from 'crypto'
import jwt from 'jsonwebtoken'
import db from '../db/database.js'
import { APP_URL } from '../config/appUrl.js'
import { encryptCredentials, decryptCredentials } from '../utils/encryption.js'

function getCredentials() {
  const clientId = process.env.PLAID_CLIENT_ID
  const secret = process.env.PLAID_SECRET
  if (!clientId || !secret) throw new Error('Plaid non configuré (PLAID_CLIENT_ID, PLAID_SECRET manquants dans .env)')
  return { clientId, secret }
}

let _client = null
export function getClient() {
  if (_client) return _client
  const { clientId, secret } = getCredentials()
  const env = process.env.PLAID_ENV || 'sandbox'
  const basePath = PlaidEnvironments[env] || PlaidEnvironments.sandbox
  const configuration = new Configuration({
    basePath,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET': secret,
      },
    },
  })
  _client = new PlaidApi(configuration)
  return _client
}

// ── Link : connexion d'une nouvelle institution ─────────────────────────────

export async function createLinkToken({ userId } = {}) {
  const client = getClient()
  const webhookUrl = process.env.PLAID_WEBHOOK_URL || `${APP_URL}/erp/api/plaid/webhook`
  // Certaines institutions (les banques canadiennes, dont la BNC, typiquement)
  // redirigent l'utilisateur vers leur propre site plutôt que de tout faire
  // dans la popup Link — Plaid exige alors une redirect_uri pré-enregistrée
  // dans le dashboard (Team Settings → API → Allowed redirect URIs), sans
  // quoi il refuse de rediriger. Voir client/src/pages/Connectors.jsx pour la
  // reprise du flux après le retour sur cette page.
  const redirectUri = process.env.PLAID_REDIRECT_URI || `${APP_URL}/erp`
  const resp = await client.linkTokenCreate({
    user: { client_user_id: userId || 'erp-orisha' },
    client_name: 'ERP Orisha',
    products: [Products.Transactions],
    country_codes: [CountryCode.Ca],
    language: 'fr',
    webhook: webhookUrl,
    redirect_uri: redirectUri,
  })
  return resp.data // { link_token, expiration }
}

export async function exchangePublicToken({ publicToken, userId: _userId }) {
  const client = getClient()
  const exchange = await client.itemPublicTokenExchange({ public_token: publicToken })
  const { access_token: accessToken, item_id: itemId } = exchange.data

  const itemInfo = await client.itemGet({ access_token: accessToken })
  const institutionId = itemInfo.data.item.institution_id || null
  let institutionName = null
  if (institutionId) {
    try {
      const inst = await client.institutionsGetById({ institution_id: institutionId, country_codes: [CountryCode.Ca] })
      institutionName = inst.data.institution?.name || null
    } catch { /* non bloquant — nom affiché en repli côté UI */ }
  }

  const accountsResp = await client.accountsGet({ access_token: accessToken })
  const accounts = accountsResp.data.accounts.map(a => ({
    plaid_account_id: a.account_id,
    name: a.official_name || a.name,
    mask: a.mask,
    subtype: a.subtype,
  }))

  const metadata = { item_id: itemId, institution_id: institutionId, institution_name: institutionName, cursor: null, accounts, last_synced_at: null, last_error: null }

  db.prepare(`
    INSERT INTO connector_oauth (id, connector, account_key, access_token, metadata)
    VALUES (?, 'plaid', ?, ?, ?)
    ON CONFLICT(connector, account_key) DO UPDATE SET
      access_token = excluded.access_token, metadata = excluded.metadata,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(newRecordId(), itemId, encryptCredentials(accessToken), JSON.stringify(metadata))

  return { itemId, institutionName, accounts }
}

function getItemRow(itemId) {
  const row = db.prepare("SELECT * FROM connector_oauth WHERE connector='plaid' AND account_key=?").get(itemId)
  if (!row) return null
  return { ...row, accessToken: decryptCredentials(row.access_token), metadata: JSON.parse(row.metadata || '{}') }
}

export function listItems() {
  return db.prepare("SELECT * FROM connector_oauth WHERE connector='plaid' ORDER BY created_at").all()
    .map(row => ({ itemId: row.account_key, ...JSON.parse(row.metadata || '{}') }))
}

function saveItemMeta(itemId, metadata) {
  db.prepare(`
    UPDATE connector_oauth SET metadata=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE connector='plaid' AND account_key=?
  `).run(JSON.stringify(metadata), itemId)
}

// ── Sync incrémentale ────────────────────────────────────────────────────────
// Mutex par item : un webhook et une sync manuelle peuvent se chevaucher.
const syncLocks = new Map()

// Soldes : PAS d'appel à /accounts/balance/get (produit Balance, facturé à
// l'appel). /transactions/sync renvoie déjà les comptes avec leurs soldes,
// mais SEULEMENT ceux qui ont des transactions dans la réponse — donc rien
// sur une sync à vide. Repli sur /accounts/get, inclus dans le produit
// Transactions : soldes tels que Plaid les a vus au dernier rafraîchissement.
// Dans les deux cas on reste en LECTURE SEULE (aucun produit d'écriture).
function balanceRows(accounts) {
  return (accounts || []).map(a => ({
    plaid_account_id: a.account_id,
    current: a.balances?.current ?? null,
    available: a.balances?.available ?? null,
    limit: a.balances?.limit ?? null,
    iso_currency_code: a.balances?.iso_currency_code || a.balances?.unofficial_currency_code || null,
  })).filter(b => b.current != null || b.available != null)
}

export async function syncItemTransactions(itemId) {
  if (syncLocks.has(itemId)) return syncLocks.get(itemId)
  const promise = (async () => {
    const item = getItemRow(itemId)
    if (!item) throw new Error(`Item Plaid inconnu : ${itemId}`)
    const client = getClient()
    let cursor = item.metadata.cursor || undefined
    let added = [], modified = [], removed = [], hasMore = true
    let balances = []
    try {
      while (hasMore) {
        const resp = await client.transactionsSync({ access_token: item.accessToken, cursor, count: 500 })
        added = added.concat(resp.data.added)
        modified = modified.concat(resp.data.modified)
        removed = removed.concat(resp.data.removed)
        const rows = balanceRows(resp.data.accounts)
        if (rows.length) balances = rows
        hasMore = resp.data.has_more
        cursor = resp.data.next_cursor
      }
      if (!balances.length) {
        try {
          const resp = await client.accountsGet({ access_token: item.accessToken })
          balances = balanceRows(resp.data.accounts)
        } catch (e) {
          // Non bloquant : la sync des transactions a réussi, seul le solde manque.
          console.error('plaid.accountsGet:', e?.response?.data?.error_message || e.message)
        }
      }
      const balanceAt = new Date().toISOString()
      const byId = new Map(balances.map(b => [b.plaid_account_id, b]))
      const accounts = (item.metadata.accounts || []).map(a => {
        const b = byId.get(a.plaid_account_id)
        return b ? { ...a, balance: b.current, balance_available: b.available, balance_at: balanceAt } : a
      })
      saveItemMeta(itemId, { ...item.metadata, accounts, cursor, last_synced_at: balanceAt, last_error: null })
      return { added, modified, removed, cursor, accounts, balances, balanceAt }
    } catch (e) {
      const message = e?.response?.data?.error_message || e.message
      saveItemMeta(itemId, { ...item.metadata, last_error: message })
      throw e
    }
  })()
  syncLocks.set(itemId, promise)
  try {
    return await promise
  } finally {
    syncLocks.delete(itemId)
  }
}

// Remet le curseur à zéro : le prochain sync relit TOUT l'historique que Plaid
// détient pour l'item. Sans risque de doublons (dedup_key = plaid:<txn_id>),
// c'est le rattrapage des comptes mappés APRÈS un premier sync — le curseur
// avait alors avancé sur des transactions qu'on jetait faute de mapping.
export function resetItemCursor(itemId) {
  const item = getItemRow(itemId)
  if (!item) throw new Error(`Item Plaid inconnu : ${itemId}`)
  saveItemMeta(itemId, { ...item.metadata, cursor: null })
}

// Santé de la connexion, vue de chez PLAID — à ne pas confondre avec notre
// propre `last_synced_at` (qui dit seulement « on a demandé »). Une banque
// peut cesser de répondre à Plaid pendant des jours sans la moindre erreur de
// notre côté : `last_successful_update` est le seul chiffre qui le montre.
// (Cas réel : la BNC n'a plus rien livré du 2 au 6 septembre 2026, tandis que
// Desjardins se mettait à jour toutes les heures.)
export async function itemHealth(itemId) {
  const item = getItemRow(itemId)
  if (!item) throw new Error(`Item Plaid inconnu : ${itemId}`)
  const client = getClient()
  const resp = await client.itemGet({ access_token: item.accessToken })
  const tx = resp.data.status?.transactions || {}
  const err = resp.data.item?.error || null
  return {
    item_id: itemId,
    institution_name: item.metadata.institution_name || null,
    last_successful_update: tx.last_successful_update || null,
    last_failed_update: tx.last_failed_update || null,
    error_code: err?.error_code || null,
    error_message: err?.error_message || null,
    // Une ré-authentification par l'utilisateur est requise (mot de passe
    // changé, consentement expiré) : aucun sync ne rattrapera ça tout seul.
    needs_reauth: err?.error_code === 'ITEM_LOGIN_REQUIRED',
  }
}

// Demande à Plaid d'aller interroger la banque MAINTENANT plutôt que
// d'attendre son prochain passage. Lecture seule, comme le reste. Utile quand
// la banque a manqué des mises à jour : sans ça, on attend son bon vouloir.
export async function requestTransactionsRefresh(itemId) {
  const item = getItemRow(itemId)
  if (!item) throw new Error(`Item Plaid inconnu : ${itemId}`)
  const client = getClient()
  await client.transactionsRefresh({ access_token: item.accessToken })
  return true
}

export async function removeItem(itemId) {
  const item = getItemRow(itemId)
  if (!item) return
  const client = getClient()
  try {
    await client.itemRemove({ access_token: item.accessToken })
  } catch (e) {
    console.error('plaid.removeItem:', e?.response?.data?.error_message || e.message)
  }
  db.prepare("DELETE FROM connector_oauth WHERE connector='plaid' AND account_key=?").run(itemId)
  db.prepare("UPDATE bank_accounts SET plaid_account_id=NULL, plaid_item_id=NULL WHERE plaid_item_id=?").run(itemId)
}

// ── Webhook ──────────────────────────────────────────────────────────────────
// Plaid signe chaque webhook avec un JWT ES256 (header Plaid-Verification).
// On vérifie : la signature (clé publique récupérée via
// /webhook_verification_key/get et mise en cache par kid), la fraîcheur du
// jeton (rejette tout ce qui a plus de 5 minutes — anti-rejeu), et que le
// hash du corps signé correspond bien au corps brut reçu (anti-falsification
// du payload). Sans ça, quiconque connaît un item_id (visible dans l'UI par
// un utilisateur déjà connecté) pourrait forcer des syncs à volonté.
const webhookKeyCache = new Map() // kid -> jwk

async function getWebhookVerificationKey(keyId) {
  if (webhookKeyCache.has(keyId)) return webhookKeyCache.get(keyId)
  const client = getClient()
  const resp = await client.webhookVerificationKeyGet({ key_id: keyId })
  const jwk = resp.data.key
  webhookKeyCache.set(keyId, jwk)
  return jwk
}

const WEBHOOK_MAX_AGE_SECONDS = 5 * 60

export async function verifyWebhook({ rawBody, verificationHeader }) {
  if (!verificationHeader) throw new Error('En-tête Plaid-Verification manquant')
  const decoded = jwt.decode(verificationHeader, { complete: true })
  if (!decoded || decoded.header.alg !== 'ES256') throw new Error('JWT de webhook invalide')
  const jwk = await getWebhookVerificationKey(decoded.header.kid)
  const publicKey = createPublicKey({ key: jwk, format: 'jwk' })
  const payload = jwt.verify(verificationHeader, publicKey.export({ type: 'spki', format: 'pem' }), { algorithms: ['ES256'] })
  if (Math.abs(Date.now() / 1000 - payload.iat) > WEBHOOK_MAX_AGE_SECONDS) {
    throw new Error('Webhook trop ancien (possible rejeu)')
  }
  const bodyHash = createHash('sha256').update(rawBody).digest('hex')
  if (bodyHash !== payload.request_body_sha256) throw new Error('Corps du webhook falsifié (hash ne correspond pas)')
  return true
}

export function resolveWebhookItem(body) {
  const itemId = body?.item_id
  if (!itemId) return null
  return getItemRow(itemId) ? itemId : null
}
