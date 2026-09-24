import { decryptCredentials } from '../utils/encryption.js'
// Les avis instantanés de QuickBooks.
//
// Jusqu'ici, « comptabilisé dans QuickBooks » se découvrait par sondage : un
// passage périodique reconstruisait le grand livre et cherchait l'écriture. Une
// dépense saisie dans QuickBooks pouvait rester « à traiter » vingt minutes sur
// la page Rapprochement bancaire — le temps que le passage suivant tombe.
//
// Intuit sait nous prévenir. La route ci-dessous reçoit l'avis, lit UNE entité
// (un appel léger, pas un rapport), en déduit le ou les comptes bancaires
// touchés, et relance la vérification sur ces comptes-là seulement. Avec les
// émissions temps réel (services/realtimeEmitters.js), la ligne passe au jaune
// dans l'onglet ouvert en quelques secondes, sans un clic.
//
// Ce que ça ne fait PAS : publier quoi que ce soit dans QuickBooks. La règle de
// la maison tient — la sync prépare, l'humain confirme.
import { Router } from 'express'
import { createHash, createHmac, timingSafeEqual } from 'crypto'
import db from '../db/database.js'
import { qbGet, getQbRealmIdSync } from '../connectors/quickbooks.js'
import { isSystemAutomationActive } from '../services/systemAutomations.js'

export const QB_WEBHOOK_AUTOMATION_ID = 'sys_qb_webhook'

const router = Router()

// ── Le jeton ─────────────────────────────────────────────────────────────────
//
// Il vit dans connector_config, saisi depuis la page Connecteurs — PAS dans
// server/.env : régénérer un jeton chez Intuit ne doit pas demander un accès
// SSH ni un redémarrage.
export function webhookVerifierToken() {
  const row = db.prepare(
    "SELECT value FROM connector_config WHERE connector='quickbooks' AND key='webhook_verifier_token'"
  ).get()
  return String(decryptCredentials(row?.value) || '').trim() || null
}

/**
 * Signature attendue : HMAC-SHA256 du corps BRUT, encodé en base64, clé = le
 * verifier token. Exporté pour le test unitaire.
 */
export function expectedSignature(rawBody, token) {
  return createHmac('sha256', token).update(rawBody).digest('base64')
}

export function signatureMatches(rawBody, token, header) {
  if (!token || !header) return false
  const expected = Buffer.from(expectedSignature(rawBody, token), 'utf8')
  const got = Buffer.from(String(header), 'utf8')
  if (expected.length !== got.length) return false
  return timingSafeEqual(expected, got)
}

// ── Où lire le compte bancaire, entité par entité ────────────────────────────
//
// Une écriture ne dit pas « je touche le compte BNC CAD » : le champ change
// selon son type. Un virement en touche deux.
const ACCOUNT_REFS = {
  Purchase: (o) => [o?.AccountRef?.value],
  Deposit: (o) => [o?.DepositToAccountRef?.value],
  Transfer: (o) => [o?.FromAccountRef?.value, o?.ToAccountRef?.value],
  JournalEntry: (o) => (o?.Line || []).map((l) => l?.JournalEntryLineDetail?.AccountRef?.value),
  BillPayment: (o) => [o?.CheckPayment?.BankAccountRef?.value, o?.CreditCardPayment?.CCAccountRef?.value],
  Payment: (o) => [o?.DepositToAccountRef?.value],
  SalesReceipt: (o) => [o?.DepositToAccountRef?.value],
  RefundReceipt: (o) => [o?.DepositToAccountRef?.value],
}

// `Bill` n'a aucun effet bancaire : rien à vérifier au relevé, mais la facture
// fournisseur, elle, doit rentrer dans l'ERP.
const RELOAD_ONLY = new Set(['Bill'])

export const SUBSCRIBED_ENTITIES = [...Object.keys(ACCOUNT_REFS), ...RELOAD_ONLY]

// Chemin de lecture de l'entité (QuickBooks les adresse en minuscules).
const READ_PATH = {
  Purchase: 'purchase', Deposit: 'deposit', Transfer: 'transfer',
  JournalEntry: 'journalentry', BillPayment: 'billpayment', Payment: 'payment',
  SalesReceipt: 'salesreceipt', RefundReceipt: 'refundreceipt', Bill: 'bill',
}

// Un compte ERP peut couvrir PLUSIEURS comptes QuickBooks, séparés par des
// virgules (BNC USD = « 234,168 ») — d'où la table d'index plutôt qu'un JOIN.
function erpAccountsByQbId() {
  const map = new Map()
  const rows = db.prepare(`
    SELECT id, name, qb_account_id FROM bank_accounts
    WHERE deleted_at IS NULL AND qb_account_id IS NOT NULL AND qb_account_id != ''
  `).all()
  for (const a of rows) {
    for (const qbId of String(a.qb_account_id).split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!map.has(qbId)) map.set(qbId, [])
      map.get(qbId).push(a)
    }
  }
  return map
}

// ── Idempotence + journal ────────────────────────────────────────────────────

export function eventKey({ realmId, name, id, operation, lastUpdated }) {
  return createHash('sha1')
    .update([realmId || '', name || '', id || '', operation || '', lastUpdated || ''].join('|'))
    .digest('hex')
}

// `INSERT OR IGNORE` : le rejeu d'Intuit retombe sur la même clé et ne
// redéclenche rien. Retourne false quand l'avis était déjà connu.
function recordEvent(key, entity) {
  const res = db.prepare(`
    INSERT OR IGNORE INTO qb_webhook_events (id, realm_id, entity, entity_id, operation, last_updated)
    VALUES (?,?,?,?,?,?)
  `).run(key, entity.realmId || null, entity.name, String(entity.id), entity.operation, entity.lastUpdated || null)
  return res.changes > 0
}

function markEvent(key, status, { accountIds = null, note = null } = {}) {
  db.prepare(`
    UPDATE qb_webhook_events
    SET status=?, account_ids=?, note=?, handled_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id=?
  `).run(status, accountIds?.join(',') || null, note ? String(note).slice(0, 300) : null, key)
}

// Purge : le journal sert à l'idempotence et à « dernier avis reçu il y a X »,
// pas à l'archéologie.
export function purgeOldWebhookEvents(days = 30) {
  return db.prepare(
    `DELETE FROM qb_webhook_events WHERE received_at < datetime('now', ?)`
  ).run(`-${Number(days) || 30} days`).changes
}

/** État affiché sur /automations : le jeton est-il posé, qu'a-t-on reçu ? */
export function qbWebhookStatus() {
  const last = db.prepare(
    'SELECT * FROM qb_webhook_events ORDER BY received_at DESC LIMIT 1'
  ).get() || null
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS n FROM qb_webhook_events
    WHERE received_at > datetime('now','-7 days') GROUP BY status
  `).all()
  return {
    token_set: !!webhookVerifierToken(),
    active: isSystemAutomationActive(QB_WEBHOOK_AUTOMATION_ID),
    entities: SUBSCRIBED_ENTITIES,
    last_event: last,
    last_7_days: Object.fromEntries(counts.map((c) => [c.status, c.n])),
  }
}

// ── Coalescence ──────────────────────────────────────────────────────────────
//
// Une saisie en lot dans QuickBooks envoie des dizaines d'avis d'affilée. On
// accumule par compte, on attend une accalmie de 15 s, et on ne repart jamais
// plus d'une fois par minute et par compte : le but est d'être rapide, pas de
// lancer douze rapports de grand livre pour une facture.
const COALESCE_MS = 15_000
const MIN_INTERVAL_MS = 60_000

const pending = new Map() // accountId → { from, to, timer }
const lastRunAt = new Map() // accountId → ts

function scheduleVerify(account, { from, to }) {
  const cur = pending.get(account.id) || { account, from, to, timer: null }
  cur.account = account
  cur.from = cur.from && cur.from < from ? cur.from : from
  cur.to = cur.to && cur.to > to ? cur.to : to
  if (cur.timer) clearTimeout(cur.timer)
  const since = Date.now() - (lastRunAt.get(account.id) || 0)
  const wait = Math.max(COALESCE_MS, MIN_INTERVAL_MS - since)
  cur.timer = setTimeout(() => runVerify(account.id), wait)
  if (typeof cur.timer.unref === 'function') cur.timer.unref()
  pending.set(account.id, cur)
}

async function runVerify(accountId) {
  const job = pending.get(accountId)
  if (!job) return
  pending.delete(accountId)
  lastRunAt.set(accountId, Date.now())
  try {
    const { verifyAccounts } = await import('../services/bankQbVerify.js')
    // Index limité à la fenêtre de l'écriture touchée. `clearStale: false` :
    // sur une fenêtre courte, une écriture hors fenêtre ferait effacer un lien
    // parfaitement valide — c'est le passage profond quotidien qui nettoie.
    await verifyAccounts([job.account], { from: job.from, to: job.to, clearStale: false, trigger: 'avis quickbooks' })
  } catch (e) {
    console.error('qb webhook verify:', e.message)
  }
}

const shift = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// ── Traitement d'un avis ─────────────────────────────────────────────────────

// L'entité a disparu de QuickBooks (supprimée, annulée) : sa lecture échoue. On
// retrouve la ligne par le lien qu'on avait posé et on l'efface — la ligne se
// dé-comptabilise toute seule. Avant, seul le nettoyage du passage complet le
// faisait, avec jusqu'à un jour de retard.
async function unlinkDeleted(entityId) {
  const rows = db.prepare(`
    SELECT id, account_id FROM bank_transactions
    WHERE qb_txn_id = ? AND deleted_at IS NULL
  `).all(String(entityId))
  if (!rows.length) return []
  db.prepare(`
    UPDATE bank_transactions
    SET qb_txn_type=NULL, qb_txn_id=NULL, qb_match_method=NULL, qb_match_delta=NULL,
        qb_match_account=NULL, qb_match_rate=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE qb_txn_id = ? AND deleted_at IS NULL
  `).run(String(entityId))
  const { refreshStatuses } = await import('../services/bankReconciliation.js')
  const { touchBankTxns } = await import('../services/realtimeEmitters.js')
  touchBankTxns(rows.map((r) => r.id))
  for (const accountId of new Set(rows.map((r) => r.account_id))) refreshStatuses(accountId)
  return [...new Set(rows.map((r) => r.account_id))]
}

export async function handleEntity(entity, key) {
  const name = entity.name
  if (RELOAD_ONLY.has(name)) {
    const { importFromQB } = await import('../services/quickbooks.js')
    await importFromQB({ incremental: true, trigger: 'avis quickbooks' })
    markEvent(key, 'traite', { note: 'Facture fournisseur relue depuis QuickBooks' })
    return
  }
  const readRef = ACCOUNT_REFS[name]
  if (!readRef) { markEvent(key, 'ignore', { note: 'Entité non suivie' }); return }

  const deletedLike = ['Delete', 'Void', 'Merge'].includes(entity.operation)
  let object = null
  if (!deletedLike) {
    try {
      const d = await qbGet(`/${READ_PATH[name]}/${entity.id}`)
      object = d?.[name] || null
    } catch (e) {
      // Une lecture qui échoue sur une entité vivante n'est pas une suppression :
      // on le dit plutôt que d'effacer un lien valide.
      if (e.qbCode !== '610' && e.status !== 404) {
        markEvent(key, 'erreur', { note: e.message })
        return
      }
    }
  }

  if (!object) {
    const accountIds = await unlinkDeleted(entity.id)
    markEvent(key, accountIds.length ? 'traite' : 'ignore', {
      accountIds,
      note: accountIds.length ? 'Écriture disparue de QuickBooks — lien effacé' : 'Écriture disparue, aucune ligne liée',
    })
    return
  }

  const byQbId = erpAccountsByQbId()
  const touched = new Map()
  for (const qbAccountId of readRef(object).filter(Boolean)) {
    for (const a of byQbId.get(String(qbAccountId)) || []) touched.set(a.id, a)
  }
  if (!touched.size) {
    markEvent(key, 'ignore', { note: 'Aucun compte bancaire de l\'ERP sur cette écriture' })
    return
  }

  const txnDate = /^\d{4}-\d{2}-\d{2}$/.test(String(object.TxnDate || ''))
    ? String(object.TxnDate) : new Date().toISOString().slice(0, 10)
  for (const account of touched.values()) {
    scheduleVerify(account, { from: shift(txnDate, -30), to: shift(txnDate, 5) })
  }
  markEvent(key, 'traite', { accountIds: [...touched.keys()], note: `Vérification programmée (${txnDate})` })
}

/**
 * Ingestion d'une liste de changements — partagée par les avis d'Intuit et par
 * l'interrogation périodique « qu'est-ce qui a changé ? » (services/qbChangePoll.js,
 * le chemin réellement utilisé tant qu'Intuit n'envoie rien). Idempotente : le même
 * changement vu deux fois ne déclenche qu'une vérification.
 * Chaque entrée : { realmId, name, id, operation, lastUpdated }.
 */
export async function ingestEntities(entities) {
  let handled = 0
  for (const entity of entities || []) {
    if (!entity?.name || !entity?.id) continue
    const key = eventKey(entity)
    if (!recordEvent(key, entity)) continue // déjà vu
    handled++
    try {
      await handleEntity(entity, key)
    } catch (err) {
      console.error('qb changement:', entity.name, entity.id, err.message)
      markEvent(key, 'erreur', { note: err.message })
    }
  }
  return handled
}

async function processNotification(body) {
  const ourRealm = String(getQbRealmIdSync() || '')
  for (const n of body?.eventNotifications || []) {
    const realmId = String(n?.realmId || '')
    // Un autre dossier QuickBooks que le nôtre : accusé de réception, rien de plus.
    if (ourRealm && realmId && realmId !== ourRealm) continue
    await ingestEntities((n?.dataChangeEvent?.entities || []).map((e) => ({
      realmId, name: e?.name, id: e?.id,
      operation: e?.operation, lastUpdated: e?.lastUpdated,
    })))
  }
}

router.post('/', (req, res) => {
  const token = webhookVerifierToken()
  if (!token) {
    // Comme Stripe : pas de secret configuré = on refuse de faire semblant.
    console.error('qb webhook: aucun jeton de vérification dans connector_config')
    return res.status(503).json({ error: 'Jeton des avis QuickBooks non configuré' })
  }
  const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(String(req.rawBody || ''), 'utf8')
  // Les deux échecs se ressemblent à l'œil nu et n'ont rien à voir : un corps
  // vide, c'est le montage express.raw qui n'a pas pris le Content-Type reçu.
  if (!raw.length) {
    console.error('qb webhook: corps brut vide (Content-Type inattendu ?)')
    return res.status(400).json({ error: 'Corps vide' })
  }
  if (!signatureMatches(raw, token, req.headers['intuit-signature'])) {
    console.error('qb webhook: signature invalide')
    return res.status(401).json({ error: 'Signature invalide' })
  }

  // 200 tout de suite : Intuit rejoue pendant plusieurs jours si l'endpoint
  // traîne, et notre traitement lit QuickBooks (plusieurs secondes).
  res.status(200).json({ ok: true })

  if (!isSystemAutomationActive(QB_WEBHOOK_AUTOMATION_ID)) return
  processNotification(req.body).catch((e) => console.error('qb webhook:', e.message))
})

// Intuit valide parfois l'endpoint par un GET.
router.get('/', (req, res) => res.status(200).json({ ok: true }))

export default router
