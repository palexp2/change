// revenueRecognitionWatcher — déclenche le constat de vente (revenue
// recognition) sur modification DB plutôt que depuis les routes front-end.
//
// Pourquoi : auparavant chaque route qui marquait un envoi « Envoyé »
// (PATCH /api/shipments, POST /api/novoxpress/label/:id) appelait
// recognizeRevenueForOrder en fire-and-forget. Un échec (QB indisponible,
// montant manquant) ne produisait qu'un console.error : la JE Dr 23900|AR /
// Cr 40000 n'était jamais posée et le revenu restait non reconnu, silencieusement.
//
// Ce watcher remplace ces déclencheurs dispersés par UN seul point :
//   1. Il tail change_log (journal exhaustif des mutations, alimenté par triggers
//      SQLite — voir db/changeLog.js). Pour chaque upsert sur shipments dont le
//      status courant est « Envoyé », il réconcilie les factures de la commande.
//      Couvre TOUTES les origines d'écriture : UI, Novoxpress, sync Airtable.
//   2. Les factures dont la reconnaissance échoue sont persistées dans
//      revenue_recognition_queue et retentées avec backoff exponentiel jusqu'au
//      succès. Le revenu n'est donc jamais perdu si QB est momentanément down.
//
// reconcileFactureRevenueRecognition / reconcileFacturesForOrder sont idempotents
// (claim atomique sur revenue_recognized_at) — re-déclencher est toujours sûr.

import db from '../db/database.js'
import {
  reconcileFacturesForOrder,
  reconcileFactureRevenueRecognition,
} from './quickbooks.js'
import { logSystemRun, isSystemAutomationActive } from './systemAutomations.js'
import { buildTriggerPredicate, triggerColumns } from './fieldRuleEngine.js'
import { createChangeLogWatcher } from './changeLogWatcher.js'

const POLL_MS = 10000
const BATCH = 500
// Plafond du backoff : 6 h. Une facture en échec permanent (QB jamais reconnecté)
// est retentée au pire toutes les 6 h — jamais abandonnée, jamais en boucle serrée.
const MAX_BACKOFF_MIN = 360

// Backoff exponentiel borné, en millisecondes, à partir du nombre de tentatives.
function backoffMs(attempts) {
  const mins = Math.min(2 ** Math.min(attempts, 9), MAX_BACKOFF_MIN)
  return mins * 60 * 1000
}

// Persiste/incrémente l'échec d'une facture. attempts++ et next_attempt_at
// repoussé selon le backoff. Single-thread → lecture puis upsert est sûr.
function enqueueFailure(factureId, orderId, errorMsg) {
  const existing = db.prepare(
    'SELECT attempts FROM revenue_recognition_queue WHERE facture_id = ?'
  ).get(factureId)
  const attempts = (existing?.attempts || 0) + 1
  const now = new Date()
  const nextAt = new Date(now.getTime() + backoffMs(attempts)).toISOString()
  db.prepare(`
    INSERT INTO revenue_recognition_queue
      (facture_id, order_id, attempts, last_error, last_attempt_at, next_attempt_at)
    VALUES (@facture_id, @order_id, @attempts, @last_error, @last_attempt_at, @next_attempt_at)
    ON CONFLICT(facture_id) DO UPDATE SET
      attempts        = @attempts,
      order_id        = COALESCE(@order_id, revenue_recognition_queue.order_id),
      last_error      = @last_error,
      last_attempt_at = @last_attempt_at,
      next_attempt_at = @next_attempt_at
  `).run({
    facture_id: factureId,
    order_id: orderId || null,
    attempts,
    last_error: String(errorMsg || '').slice(0, 1000),
    last_attempt_at: now.toISOString(),
    next_attempt_at: nextAt,
  })
  return attempts
}

function dequeue(factureId) {
  db.prepare('DELETE FROM revenue_recognition_queue WHERE facture_id = ?').run(factureId)
}

// Réconcilie une commande et synchronise la file : retire les factures
// résolues (recognized / skip terminal), (ré)inscrit celles en erreur.
async function processOrder(orderId, source) {
  let r
  try {
    r = await reconcileFacturesForOrder(orderId)
  } catch (err) {
    console.error('[revRecWatcher] reconcileFacturesForOrder error:', err.message)
    logSystemRun('sys_revenue_recognition', {
      status: 'error', error: err.message,
      triggerData: { order_id: orderId, source },
    })
    return
  }

  for (const x of r.recognized) dequeue(x.facture_id)
  // skip = plus rien à faire via ce chemin (déjà constaté, annulé, en attente
  // d'un autre flux…). Si la facture traînait dans la file, on l'en retire :
  // un nouveau change_log la re-déclenchera si la condition redevient vraie.
  for (const x of r.skipped) if (x.facture_id) dequeue(x.facture_id)
  for (const x of r.errors) enqueueFailure(x.facture_id, orderId, x.error)

  if (r.recognized.length || r.errors.length) {
    logSystemRun('sys_revenue_recognition', {
      status: r.errors.length ? 'error' : 'success',
      result: [
        `Commande ${orderId} (déclencheur : ${source})`,
        `Constatées : ${r.recognized.length} (${r.recognized.map(x => `#${x.document_number || x.facture_id} ${x.amount} ${x.currency} via ${x.debit_account}`).join(', ') || '—'})`,
        `Skip : ${r.skipped.length}`,
        r.errors.length ? `Erreurs (mises en file pour retry) : ${r.errors.map(e => `${e.facture_id}: ${e.error}`).join(' | ')}` : null,
      ].filter(Boolean).join('\n'),
      error: r.errors.length ? r.errors.map(e => e.error).join(' | ') : undefined,
      triggerData: { order_id: orderId, source },
    })
  }
}

// Réconcilie UNE facture (mode factures du déclencheur) et synchronise la file
// de retry — même contrat que processOrder mais à la maille facture. Les skips
// sont silencieux (comme processOrder) ; recognized/error sont logués.
async function processFacture(factureId, source) {
  let r
  try {
    r = await reconcileFactureRevenueRecognition(factureId)
  } catch (err) {
    // reconcile ne throw normalement pas (il catch en interne), garde défensive.
    console.error('[revRecWatcher] reconcileFactureRevenueRecognition error:', err.message)
    enqueueFailure(factureId, null, err.message)
    logSystemRun('sys_revenue_recognition', {
      status: 'error', error: err.message,
      triggerData: { facture_id: factureId, source },
    })
    return
  }
  if (r.status === 'recognized') {
    dequeue(factureId)
    logSystemRun('sys_revenue_recognition', {
      status: 'success',
      result: `Facture #${r.document_number || factureId} constatée (déclencheur : ${source}) — ${r.amount} ${r.currency} via ${r.debit_account}`,
      triggerData: { facture_id: factureId, source },
    })
  } else if (r.status === 'error') {
    const orderId = db.prepare('SELECT order_id FROM factures WHERE id = ?').get(factureId)?.order_id || null
    enqueueFailure(factureId, orderId, r.error)
    logSystemRun('sys_revenue_recognition', {
      status: 'error',
      result: `Facture #${r.document_number || factureId} en échec (mise en file pour retry) : ${r.error}`,
      error: r.error,
      triggerData: { facture_id: factureId, source },
    })
  } else {
    // skip = terminal via ce chemin ; un prochain change_log re-déclenchera si
    // la condition redevient vraie.
    dequeue(factureId)
  }
}

// Condition de déclenchement par défaut — utilisée quand la config utilisateur
// est absente ou illisible (fallback dur, jamais de constat silencieusement omis).
const DEFAULT_TRIGGER = { erp_table: 'shipments', column: 'status', op: 'eq', value: 'Envoyé' }

const IDENT_RE = /^[a-z_][a-z0-9_]*$/i

// Charge la condition configurée par l'utilisateur sur l'automation système
// (trigger_config de sys_revenue_recognition, éditable via l'UI). Deux modes
// selon erp_table :
//   - 'shipments' (défaut) : condition sur l'envoi → réconcilie les factures de
//     sa commande (comportement historique).
//   - 'factures' : condition sur la facture elle-même — y compris un champ
//     personnalisé (ex. lookup « Date d'envoi de la commande liée ») — →
//     réconcilie directement la facture qui matche.
export function loadTriggerConfig() {
  try {
    const row = db.prepare(
      "SELECT trigger_config FROM automations WHERE id = 'sys_revenue_recognition' AND system = 1"
    ).get()
    const tc = JSON.parse(row?.trigger_config || '{}')
    if (tc.column || tc.conditions) return tc
  } catch (e) {
    console.error('[revRecWatcher] trigger_config illisible, fallback status=Envoyé :', e.message)
  }
  return DEFAULT_TRIGGER
}

// Construit le matcher pour une condition donnée. Quand la condition référence
// une colonne absente de la table physique (champ personnalisé cf_*), la requête
// passe par la VUE <table>_v (customFieldsView.js) qui matérialise lookups,
// rollups et formules. Lève si la config est inutilisable (colonne invalide,
// vue manquante) — le caller retombe alors sur DEFAULT_TRIGGER.
export function buildTriggerMatcher(tc) {
  const table = tc.erp_table === 'factures' ? 'factures' : 'shipments'
  const { predicate, params } = buildTriggerPredicate(tc)
  const physical = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name))
  const cols = triggerColumns(tc)
  for (const c of cols) {
    if (!IDENT_RE.test(c)) throw new Error(`colonne invalide: ${c}`)
  }
  let rel = table
  if (cols.some(c => !physical.has(c))) {
    const view = `${table}_v`
    const hasView = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ?"
    ).get(view)
    if (!hasView) throw new Error(`champ personnalisé référencé mais la vue ${view} n'existe pas`)
    rel = view
  }
  const stmt = db.prepare(
    `SELECT t.id${table === 'shipments' ? ', t.order_id' : ''} FROM ${rel} t WHERE (${predicate}) AND t.id = ?`
  )
  return {
    mode: table,
    // En mode factures, la valeur d'un lookup dépend de la commande (et des
    // envois qui alimentent ses champs) : on réévalue aussi sur ces écritures.
    watchedTables: table === 'factures' ? ['factures', 'orders', 'shipments'] : ['shipments'],
    match: (recordId) => stmt.get(...params, recordId) || null,
  }
}

function loadMatcher() {
  try {
    return buildTriggerMatcher(loadTriggerConfig())
  } catch (e) {
    console.error('[revRecWatcher] condition configurée invalide, fallback status=Envoyé :', e.message)
    return buildTriggerMatcher(DEFAULT_TRIGGER)
  }
}

// Factures candidates d'une commande — même périmètre que reconcileFacturesForOrder
// (lien direct order_id OU via le projet de la commande).
let _facturesForOrderStmt = null
function facturesForOrder(orderId) {
  _facturesForOrderStmt ??= db.prepare(`
    SELECT f.id FROM factures f
    JOIN orders o ON o.id = ?
    WHERE f.kind = 'order'
      AND (f.order_id = o.id OR (f.project_id IS NOT NULL AND f.project_id = o.project_id))
  `)
  return _facturesForOrderStmt.all(orderId).map(r => r.id)
}

// Mappe un événement change_log (mode factures) vers les factures à réévaluer.
function candidateFacturesForChange(tableName, recordId) {
  if (tableName === 'factures') return [recordId]
  if (tableName === 'orders') return facturesForOrder(recordId)
  if (tableName === 'shipments') {
    const s = db.prepare('SELECT order_id FROM shipments WHERE id = ?').get(recordId)
    return s?.order_id ? facturesForOrder(s.order_id) : []
  }
  return []
}

// Étape 1 — tail change_log selon le mode configuré.
//   - mode shipments : envoi qui matche → réconcilie sa commande (dédup par commande).
//   - mode factures  : écriture facture/commande/envoi → réévalue les factures
//     candidates ; celles qui matchent sont réconciliées une à une (dédup par facture).
export async function tailShipmentsOnce() {
  const matcher = loadMatcher()
  const tablesIn = matcher.watchedTables.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT id, table_name, record_id FROM change_log
    WHERE id > ? AND change_type = 'upsert' AND table_name IN (${tablesIn})
    ORDER BY id ASC LIMIT ?
  `).all(watcher.getLastSeenId(), ...matcher.watchedTables, BATCH)
  if (!rows.length) return 0

  if (matcher.mode === 'factures') {
    const facturesSeen = new Set()
    for (const row of rows) {
      watcher.setLastSeenId(row.id)
      for (const factureId of candidateFacturesForChange(row.table_name, row.record_id)) {
        if (facturesSeen.has(factureId)) continue
        facturesSeen.add(factureId)
        if (!matcher.match(factureId)) continue
        await processFacture(factureId, `facture_condition(${row.table_name})`)
      }
    }
    return facturesSeen.size
  }

  const ordersSeen = new Set()
  for (const row of rows) {
    watcher.setLastSeenId(row.id)
    const ship = matcher.match(row.record_id)
    if (!ship || !ship.order_id) continue
    if (ordersSeen.has(ship.order_id)) continue
    ordersSeen.add(ship.order_id)
    await processOrder(ship.order_id, 'shipment_envoye')
  }
  return ordersSeen.size
}

// Étape 2 — draine la file des échecs dont next_attempt_at est échu.
export async function retryQueueOnce() {
  const now = new Date().toISOString()
  const due = db.prepare(`
    SELECT facture_id, order_id, attempts FROM revenue_recognition_queue
    WHERE next_attempt_at <= ?
    ORDER BY next_attempt_at ASC LIMIT ?
  `).all(now, BATCH)

  let recovered = 0
  const stillFailing = []
  for (const q of due) {
    let r
    try {
      r = await reconcileFactureRevenueRecognition(q.facture_id)
    } catch (err) {
      // reconcile ne throw normalement pas (il catch en interne), garde défensive.
      enqueueFailure(q.facture_id, q.order_id, err.message)
      stillFailing.push(`#${q.facture_id}: ${err.message}`)
      continue
    }
    if (r.status === 'recognized') {
      dequeue(q.facture_id)
      recovered++
    } else if (r.status === 'error') {
      const attempts = enqueueFailure(q.facture_id, q.order_id, r.error)
      stillFailing.push(`#${r.document_number || q.facture_id} (tentative ${attempts}): ${r.error}`)
    } else {
      // skip = terminal (déjà constaté ailleurs, annulé, plus éligible) → on sort de la file.
      dequeue(q.facture_id)
    }
  }

  if (recovered || stillFailing.length) {
    logSystemRun('sys_revenue_recognition', {
      status: stillFailing.length ? 'error' : 'success',
      result: [
        `Retry file de constat de vente`,
        `Récupérées : ${recovered}`,
        stillFailing.length ? `Toujours en échec : ${stillFailing.join(' | ')}` : null,
      ].filter(Boolean).join('\n'),
      error: stillFailing.length ? stillFailing.join(' | ') : undefined,
      triggerData: { source: 'retry_queue', recovered, still_failing: stillFailing.length },
    })
  }
  return { recovered, stillFailing: stillFailing.length }
}

// Squelette (timer, garde anti-réentrance, curseur, fast-forward quand
// désactivé) : fabrique changeLogWatcher. Le tail lui-même reste ici (onPoll)
// parce que ses tables surveillées sont dynamiques (config utilisateur, relue
// à chaque passe) et qu'il enchaîne la file de retry.
//
// Toggle utilisateur (page Automations) : désactivé = aucun constat, ni tail
// ni retry. Le curseur avance quand même — les envois écrits pendant la pause
// ne sont PAS rejoués à la réactivation (comportement documenté dans la
// description de l'automation).
const watcher = createChangeLogWatcher({
  name: 'revRecWatcher',
  intervalMs: POLL_MS,
  isEnabled: () => isSystemAutomationActive('sys_revenue_recognition'),
  onPoll: async () => {
    await tailShipmentsOnce()
    await retryQueueOnce()
  },
  errorLabel: 'tick',
  startLog: () => {
    const pending = db.prepare('SELECT COUNT(*) AS n FROM revenue_recognition_queue').get()?.n || 0
    return `started (poll ${POLL_MS}ms, tail shipments→Envoyé · ${pending} facture(s) en file de retry)`
  },
})

export function startRevenueRecognitionWatcher() {
  // Démarre au point courant : on ne réagit qu'aux changements postérieurs au boot.
  // La file (persistée en DB) couvre les échecs antérieurs au redémarrage.
  watcher.start()
}

export function stopRevenueRecognitionWatcher() { watcher.stop() }

// ── Test seams ──────────────────────────────────────────────────────────────
export function _setLastSeenId(n) { watcher.setLastSeenId(n) }
export function _getLastSeenId() { return watcher.getLastSeenId() }
export function _enqueueFailure(factureId, orderId, errorMsg) { return enqueueFailure(factureId, orderId, errorMsg) }
export function _dequeue(factureId) { return dequeue(factureId) }
export function _backoffMs(attempts) { return backoffMs(attempts) }
