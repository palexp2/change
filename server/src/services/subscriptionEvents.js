// Helper pour enregistrer les événements d'abonnement (création, churn,
// upgrade, downgrade, etc.) dans la table `subscription_events`.
//
// Ce module est appelé depuis :
//   - la sync Stripe polling (`services/stripe.js syncSubscriptions`)
//   - les webhooks Stripe (`routes/stripe-webhooks.js customer.subscription.*`)
//   - le script de backfill (`scripts/backfill-subscription-events.js`)
//
// La colonne `stripe_event_id` garantit l'idempotence quand Stripe rejoue un
// webhook : INSERT OR IGNORE sur l'index unique évite les doublons.

import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { getUsdCadRate } from './fx.js'
import { emit } from './realtime.js'

// Builds the exact row shape that GET /api/projets/abonnement-events returns
// (consumed by AbonnementMouvements + SubscriptionHistory). Single row variant.
export function buildSubscriptionEventRow(eventId) {
  return db.prepare(`
    SELECT
      e.id, e.event_date, e.event_type, e.category,
      e.previous_amount_cad, e.new_amount_cad, e.amount_cad_delta,
      e.currency, e.created_at, e.subscription_id,
      COALESCE(e.company_id, s.company_id) AS company_id,
      s.stripe_id AS stripe_subscription_id,
      co.name AS company_name,
      e.rachat_status, e.rachat_order_id, e.rachat_checked_at,
      o.order_number AS rachat_order_number
    FROM subscription_events e
    LEFT JOIN subscriptions s ON e.subscription_id = s.id
    LEFT JOIN companies co ON co.id = COALESCE(e.company_id, s.company_id)
    LEFT JOIN orders o ON o.id = e.rachat_order_id
    WHERE e.id = ?
  `).get(eventId) || null
}

export function emitSubscriptionEvent(verb, eventId, subscriptionId, actorUserId) {
  const payload = verb === 'deleted'
    ? { id: eventId, subscription_id: subscriptionId }
    : buildSubscriptionEventRow(eventId)
  if (!payload) return
  emit(['subscription_events:list', `subscription:${subscriptionId}`], {
    type: `subscription_event:${verb}`,
    payload,
    actorUserId: actorUserId || null,
    ts: Date.now(),
  })
}

// Catégories utilisées par le panel "Mouvements d'abonnements" du dashboard
// et la page Mouvements. Source unique de vérité côté serveur.
// Doit rester aligné avec client/src/lib/subscriptionEvents.js.
export const CATEGORIES = ['creation', 'upgrade', 'downgrade', 'churn', 'reactivation']

async function toCad(amount, currency, dateStr) {
  if (amount == null) return null
  if (!currency || currency.toUpperCase() === 'CAD') return amount
  if (currency.toUpperCase() === 'USD') {
    const rate = await getUsdCadRate(dateStr || new Date().toISOString().slice(0, 10)) || 1.38
    return Math.round(amount * rate * 100) / 100
  }
  return amount  // autre devise → on stocke tel quel (cas marginaux)
}

// Classifie un changement de subscription en catégorie. Retourne null si le
// changement n'est pas un mouvement à enregistrer (ex. statut active ↔ past_due
// sans changement de montant, modifications neutres). Les appelants doivent
// alors skip recordEvent.
export function classifyChange({ prevStatus, newStatus, prevAmount, newAmount }) {
  const wasActive = prevStatus && prevStatus !== 'canceled'
  const isCanceled = newStatus === 'canceled'
  if (wasActive && isCanceled) return 'churn'
  if (!prevStatus && newStatus && newStatus !== 'canceled') return 'creation'
  if (prevStatus === 'canceled' && newStatus && newStatus !== 'canceled') return 'reactivation'
  if (prevAmount != null && newAmount != null) {
    if (newAmount > prevAmount + 0.01) return 'upgrade'
    if (newAmount < prevAmount - 0.01) return 'downgrade'
  }
  return null
}

/**
 * Enregistre un événement d'abonnement.
 * @param {object} args
 * @param {string} args.subscriptionId — id ERP du subscription
 * @param {string} args.companyId — id ERP de l'entreprise (peut être null)
 * @param {string} args.eventDate — ISO UTC
 * @param {string} args.eventType — libellé legacy (creation/update/cancel...)
 * @param {string} args.category — voir CATEGORIES
 * @param {number} [args.previousAmount] — MRR avant en devise native
 * @param {number} [args.newAmount] — MRR après en devise native
 * @param {string} [args.currency] — devise native ('CAD' / 'USD')
 * @param {string} [args.stripeEventId] — pour idempotence webhooks
 * @returns {Promise<{inserted: boolean, id: string|null}>}
 */
export async function recordEvent(args) {
  const {
    subscriptionId, companyId = null, eventDate, eventType, category,
    previousAmount = null, newAmount = null, currency = 'CAD',
    stripeEventId = null,
    itemsBefore = null, itemsAfter = null,
  } = args

  if (!subscriptionId || !eventDate || !eventType) {
    throw new Error('subscriptionId, eventDate, eventType requis')
  }

  // Idempotence webhook : si stripeEventId fourni et déjà vu, no-op.
  if (stripeEventId) {
    const existing = db.prepare('SELECT id FROM subscription_events WHERE stripe_event_id=?').get(stripeEventId)
    if (existing) return { inserted: false, id: existing.id }
  }

  const datePart = String(eventDate).slice(0, 10)
  const previousCad = await toCad(previousAmount, currency, datePart)
  const newCad = await toCad(newAmount, currency, datePart)
  let delta = null
  if (category === 'creation') delta = newCad
  else if (category === 'churn') delta = previousCad != null ? -previousCad : null
  else if (category === 'reactivation') delta = newCad
  else if (previousCad != null && newCad != null) delta = newCad - previousCad

  const id = newRecordId()
  const itemsBeforeJson = Array.isArray(itemsBefore) ? JSON.stringify(itemsBefore) : null
  const itemsAfterJson = Array.isArray(itemsAfter) ? JSON.stringify(itemsAfter) : null
  db.prepare(`
    INSERT INTO subscription_events (
      id, subscription_id, company_id, event_date, event_type, category,
      amount_cad_delta, previous_amount_cad, new_amount_cad, currency,
      stripe_event_id, items_before_json, items_after_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, subscriptionId, companyId, eventDate, eventType, category,
    delta, previousCad, newCad, currency,
    stripeEventId, itemsBeforeJson, itemsAfterJson,
  )
  emitSubscriptionEvent('created', id, subscriptionId, null)

  // Détection auto "rachat" sur les churns : on n'attend pas le retour pour
  // garder la latence de Stripe webhook minimale, mais on essaie best-effort.
  // safeDetectRachatForChurn() log + met en file de retry tout échec au lieu de
  // l'avaler (sinon un réabonnement réel resterait marqué churné sans retry).
  if (category === 'churn') {
    safeDetectRachatForChurn(id, 'churn-webhook')
  }
  return { inserted: true, id }
}

// ── Détection "rachat" après churn ──────────────────────────────────────────
//
// Critères retenus :
//   - Fenêtre : commande du même company_id avec date_commande dans
//     [event_date, event_date + 12 mois].
//   - Exclusion : commandes-abonnement (is_subscription = 1) — ce sont des
//     renouvellements, pas des rachats.
//   - Exclusion : commandes soft-deleted (deleted_at IS NOT NULL).
//   - Seuil "gros achat" : valeur de la commande (SUM qty*unit_cost sur
//     order_items) >= 12 × previous_amount_cad. Fallback >= 1500 CAD si
//     previous_amount_cad NULL.
//   - On retient la commande la plus proche du churn (premier match temporel).
//
// Choix du champ "valeur" : orders n'a pas de colonne value/total dédiée, donc
// on agrège order_items.qty * order_items.unit_cost — c'est ce que l'API
// orders.list renvoie déjà comme `total_value`. C'est la valeur des items
// commandés au coût enregistré sur la ligne (≈ valeur de la commande).
//
// Idempotent : ne touche que les events dont rachat_status est NULL ou
// 'probable' (on ne réécrase pas un statut confirmé manuellement).
const FALLBACK_RACHAT_MIN_CAD = 1500
const RACHAT_WINDOW_MONTHS = 12

// Note : date_commande est rarement renseignée en prod (legacy import). On
// utilise COALESCE(date_commande, created_at) comme date effective de la
// commande pour ne pas exclure 99% des candidats. Comparaison date-only via
// substr pour rester stable peu importe le format ISO/UTC.
//
// Préparé paresseusement (et non au chargement du module) : ce module est dans
// la chaîne d'import des routers testés par test-helpers/testApp.js, où la DB
// jetable n'a pas encore ses tables au moment de l'évaluation ESM — un prepare
// top-level y lève « no such table: orders » et casse tout le harnais.
let detectRachatStmtCached = null
const detectRachatStmt = () => (detectRachatStmtCached ??= db.prepare(`
  SELECT
    o.id,
    o.order_number,
    COALESCE(o.date_commande, substr(o.created_at, 1, 10)) AS effective_date,
    (SELECT COALESCE(SUM(oi.qty * oi.unit_cost), 0)
     FROM order_items oi WHERE oi.order_id = o.id) AS total_value
  FROM orders o
  WHERE o.company_id = ?
    AND o.deleted_at IS NULL
    AND COALESCE(o.is_subscription, 0) = 0
    AND COALESCE(o.date_commande, substr(o.created_at, 1, 10)) IS NOT NULL
    AND COALESCE(o.date_commande, substr(o.created_at, 1, 10)) >= ?
    AND COALESCE(o.date_commande, substr(o.created_at, 1, 10)) <= date(?, '+${RACHAT_WINDOW_MONTHS} months')
  ORDER BY effective_date ASC
`))

export function detectRachatForChurn(eventId) {
  const ev = db.prepare(`
    SELECT e.id, e.event_date, e.category, e.rachat_status, e.previous_amount_cad,
           COALESCE(e.company_id, s.company_id) AS company_id
    FROM subscription_events e
    LEFT JOIN subscriptions s ON e.subscription_id = s.id
    WHERE e.id = ?
  `).get(eventId)

  if (!ev || ev.category !== 'churn' || !ev.company_id) return null
  // On ne touche pas un statut posé manuellement par un user (confirmed, none,
  // merged). Seuls NULL et 'probable' restent éligibles à la (ré)détection auto.
  if (ev.rachat_status === 'confirmed' || ev.rachat_status === 'none' || ev.rachat_status === 'merged') return null

  const eventDateOnly = String(ev.event_date).slice(0, 10)
  const candidates = detectRachatStmt().all(ev.company_id, eventDateOnly, eventDateOnly)

  const threshold = ev.previous_amount_cad
    ? 12 * Number(ev.previous_amount_cad)
    : FALLBACK_RACHAT_MIN_CAD

  let bestOrderId = null
  for (const c of candidates) {
    if ((c.total_value || 0) >= threshold) {
      bestOrderId = c.id
      break  // ordre ASC → premier match = plus proche temporellement
    }
  }

  const now = new Date().toISOString()
  if (bestOrderId) {
    db.prepare(`
      UPDATE subscription_events
      SET rachat_status = 'probable', rachat_order_id = ?, rachat_checked_at = ?
      WHERE id = ?
    `).run(bestOrderId, now, eventId)
  } else {
    // Aucun candidat trouvé — on enregistre juste le timestamp pour ne pas
    // re-scanner indéfiniment. rachat_status reste NULL (non confirmé).
    db.prepare(`
      UPDATE subscription_events
      SET rachat_checked_at = ?
      WHERE id = ?
    `).run(now, eventId)
  }
  return { eventId, rachat_order_id: bestOrderId }
}

// ── File de retry de la détection "rachat" ───────────────────────────────────
//
// detectRachatForChurn() est invoquée en fire-and-forget (webhook, rescan à la
// création d'une commande, backfill). Un échec (DB verrouillée, FX indispo,
// exception inattendue) doit être loggé ET persisté pour reprise, plutôt
// qu'avalé dans un catch {} muet — sans ça un client réabonné resterait marqué
// churné indéfiniment. Pattern calqué sur hubspot_push_failures.

// Sentinel retourné par safeDetectRachatForChurn() quand la détection a levé
// (distinct d'un null "rien à faire" / "aucun candidat"), pour que le backfill
// puisse compter séparément les échecs.
export const RACHAT_DETECT_FAILED = Symbol('rachat-detect-failed')

// Backoff exponentiel borné. `attempts` est le compteur APRÈS l'échec courant
// (1 = premier échec). 1er retry ≈ 1 min, plafonné à 1 h.
const RACHAT_RETRY_BASE_MS = 60 * 1000
const RACHAT_RETRY_MAX_MS = 60 * 60 * 1000
export function computeRachatRetryDelayMs(attempts) {
  const n = Math.max(1, attempts)
  return Math.min(RACHAT_RETRY_BASE_MS * 2 ** (n - 1), RACHAT_RETRY_MAX_MS)
}

// Enregistre/incrémente un échec. `first_failed_at` n'est jamais écrasé (omis
// du DO UPDATE) pour conserver l'ancienneté réelle de la divergence.
export function recordRachatFailure(eventId, errorMessage) {
  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  const prev = db.prepare('SELECT attempts FROM rachat_detect_failures WHERE event_id=?').get(eventId)
  const attempts = (prev?.attempts || 0) + 1
  const nextRetry = new Date(now + computeRachatRetryDelayMs(attempts)).toISOString()
  db.prepare(`
    INSERT INTO rachat_detect_failures
      (event_id, attempts, last_error, first_failed_at, last_attempt_at, next_retry_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      attempts        = excluded.attempts,
      last_error      = excluded.last_error,
      last_attempt_at = excluded.last_attempt_at,
      next_retry_at   = excluded.next_retry_at
  `).run(eventId, attempts, String(errorMessage || '').slice(0, 2000), nowIso, nowIso, nextRetry)
  return { attempts, nextRetry }
}

export function clearRachatFailure(eventId) {
  db.prepare('DELETE FROM rachat_detect_failures WHERE event_id=?').run(eventId)
}

export function getRachatFailureStatus() {
  const row = db.prepare(`
    SELECT COUNT(*) AS count, MIN(first_failed_at) AS oldest, MAX(attempts) AS max_attempts
    FROM rachat_detect_failures
  `).get()
  return {
    count: row?.count || 0,
    oldest: row?.oldest || null,
    max_attempts: row?.max_attempts || 0,
  }
}

// Wrapper sûr autour de detectRachatForChurn : succès → purge la ligne d'échec
// éventuelle ; échec → log + (re)mise en file avec backoff. Tous les appelants
// fire-and-forget passent par ici (plus aucun catch {} muet). `trigger` n'est
// qu'un libellé pour le log.
export function safeDetectRachatForChurn(eventId, trigger = 'inline') {
  try {
    const result = detectRachatForChurn(eventId)
    clearRachatFailure(eventId)
    return result
  } catch (e) {
    try {
      const { attempts, nextRetry } = recordRachatFailure(eventId, e.message)
      console.error(`Détection rachat event ${eventId} (${trigger}, tentative ${attempts}, retry ${nextRetry}):`, e.message)
    } catch (persistErr) {
      console.error(`Détection rachat event ${eventId} (échec persistance file):`, persistErr.message, "— erreur d'origine:", e.message)
    }
    return RACHAT_DETECT_FAILED
  }
}

// Rejoue les détections échues dont next_retry_at est échu. Borné par `limit`.
// safeDetectRachatForChurn() reclasse chaque event : succès → ligne supprimée,
// nouvel échec → next_retry_at repoussé (backoff). Le JOIN sur
// subscription_events ignore les events disparus (ligne file nettoyée par
// ON DELETE CASCADE). Émet l'update realtime si le statut rachat a changé.
export function drainRachatRetryQueue({ limit = 50 } = {}) {
  const nowIso = new Date().toISOString()
  const due = db.prepare(`
    SELECT f.event_id FROM rachat_detect_failures f
    JOIN subscription_events e ON e.id = f.event_id
    WHERE f.next_retry_at IS NULL OR f.next_retry_at <= ?
    ORDER BY f.next_retry_at ASC
    LIMIT ?
  `).all(nowIso, limit)
  let recovered = 0, stillFailing = 0
  for (const { event_id } of due) {
    const before = db.prepare('SELECT rachat_status, rachat_order_id FROM subscription_events WHERE id=?').get(event_id)
    safeDetectRachatForChurn(event_id, 'retry')
    const still = db.prepare('SELECT 1 FROM rachat_detect_failures WHERE event_id=?').get(event_id)
    if (still) { stillFailing++; continue }
    recovered++
    const after = db.prepare('SELECT rachat_status, rachat_order_id, subscription_id FROM subscription_events WHERE id=?').get(event_id)
    if (after && (after.rachat_status !== before?.rachat_status || after.rachat_order_id !== before?.rachat_order_id)) {
      emitSubscriptionEvent('updated', event_id, after.subscription_id, null)
    }
  }
  return { attempted: due.length, recovered, stillFailing }
}

// Re-scanne tous les churns récents d'une entreprise dont rachat_status est
// NULL (ou 'probable' avec ancienne détection). Utilisé quand une nouvelle
// commande est créée — il est probable qu'elle soit le rachat d'un churn
// récent.
export function rescanRachatForCompany(companyId) {
  if (!companyId) return 0
  const rows = db.prepare(`
    SELECT id FROM subscription_events
    WHERE category = 'churn'
      AND COALESCE(company_id, '') != ''
      AND company_id = ?
      AND (rachat_status IS NULL OR rachat_status = 'probable')
      AND event_date >= date('now', '-${RACHAT_WINDOW_MONTHS} months')
  `).all(companyId)
  for (const r of rows) {
    const before = db.prepare('SELECT rachat_status, rachat_order_id FROM subscription_events WHERE id=?').get(r.id)
    // safeDetectRachatForChurn gère lui-même l'échec (log + file de retry) ;
    // plus de catch {} muet ici.
    safeDetectRachatForChurn(r.id, 'order-rescan')
    const after = db.prepare('SELECT rachat_status, rachat_order_id, subscription_id FROM subscription_events WHERE id=?').get(r.id)
    if (after && (after.rachat_status !== before.rachat_status || after.rachat_order_id !== before.rachat_order_id)) {
      emitSubscriptionEvent('updated', r.id, after.subscription_id, null)
    }
  }
  return rows.length
}

// Backfill : repasse la détection sur tous les churns en DB (sans écraser les
// statuts 'confirmed' / 'none'). Utilisé par l'endpoint admin
// POST /api/projets/abonnement-events/backfill-rachat.
export function backfillRachatDetection() {
  const rows = db.prepare(`
    SELECT id FROM subscription_events
    WHERE category = 'churn'
      AND (rachat_status IS NULL OR rachat_status = 'probable')
  `).all()
  let withCandidate = 0
  let processed = 0
  let failed = 0
  for (const r of rows) {
    const result = safeDetectRachatForChurn(r.id, 'backfill')
    if (result === RACHAT_DETECT_FAILED) { failed++; continue }
    processed++
    if (result?.rachat_order_id) withCandidate++
  }
  return { processed, withCandidate, failed }
}
