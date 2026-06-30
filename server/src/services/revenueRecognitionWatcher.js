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
import { logSystemRun } from './systemAutomations.js'

const POLL_MS = 10000
const BATCH = 500
// Plafond du backoff : 6 h. Une facture en échec permanent (QB jamais reconnecté)
// est retentée au pire toutes les 6 h — jamais abandonnée, jamais en boucle serrée.
const MAX_BACKOFF_MIN = 360

let lastSeenId = 0
let timer = null
let running = false

function maxChangeLogId() {
  return db.prepare('SELECT MAX(id) AS m FROM change_log').get()?.m || 0
}

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

// Étape 1 — tail change_log sur shipments. Pour chaque envoi devenu « Envoyé »,
// réconcilie sa commande. Dédup intra-batch par commande (un envoi reçoit
// plusieurs upserts : tracking, notes…).
export async function tailShipmentsOnce() {
  const rows = db.prepare(`
    SELECT id, record_id FROM change_log
    WHERE id > ? AND change_type = 'upsert' AND table_name = 'shipments'
    ORDER BY id ASC LIMIT ?
  `).all(lastSeenId, BATCH)

  const ordersSeen = new Set()
  for (const row of rows) {
    lastSeenId = row.id
    const ship = db.prepare('SELECT order_id, status FROM shipments WHERE id = ?').get(row.record_id)
    if (!ship || ship.status !== 'Envoyé' || !ship.order_id) continue
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

async function tick() {
  if (running) return
  running = true
  try {
    await tailShipmentsOnce()
    await retryQueueOnce()
  } catch (e) {
    console.error('[revRecWatcher] tick error:', e.message)
  } finally {
    running = false
  }
}

export function startRevenueRecognitionWatcher() {
  if (timer) return
  // Démarre au point courant : on ne réagit qu'aux changements postérieurs au boot.
  // La file (persistée en DB) couvre les échecs antérieurs au redémarrage.
  lastSeenId = maxChangeLogId()
  timer = setInterval(() => { tick() }, POLL_MS)
  if (timer.unref) timer.unref()
  const pending = db.prepare('SELECT COUNT(*) AS n FROM revenue_recognition_queue').get()?.n || 0
  console.log(`[revRecWatcher] started (poll ${POLL_MS}ms, tail shipments→Envoyé · ${pending} facture(s) en file de retry)`)
}

export function stopRevenueRecognitionWatcher() {
  if (timer) { clearInterval(timer); timer = null }
}

// ── Test seams ──────────────────────────────────────────────────────────────
export function _setLastSeenId(n) { lastSeenId = n }
export function _getLastSeenId() { return lastSeenId }
export function _enqueueFailure(factureId, orderId, errorMsg) { return enqueueFailure(factureId, orderId, errorMsg) }
export function _dequeue(factureId) { return dequeue(factureId) }
export function _backoffMs(attempts) { return backoffMs(attempts) }
