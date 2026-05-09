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

import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
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

  const id = uuid()
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
  if (category === 'churn') {
    try { detectRachatForChurn(id) } catch {}
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
const detectRachatStmt = db.prepare(`
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
`)

export function detectRachatForChurn(eventId) {
  const ev = db.prepare(`
    SELECT e.id, e.event_date, e.category, e.rachat_status, e.previous_amount_cad,
           COALESCE(e.company_id, s.company_id) AS company_id
    FROM subscription_events e
    LEFT JOIN subscriptions s ON e.subscription_id = s.id
    WHERE e.id = ?
  `).get(eventId)

  if (!ev || ev.category !== 'churn' || !ev.company_id) return null
  // On ne touche pas un statut confirmé / explicitement "none" par un user.
  if (ev.rachat_status === 'confirmed' || ev.rachat_status === 'none') return null

  const eventDateOnly = String(ev.event_date).slice(0, 10)
  const candidates = detectRachatStmt.all(ev.company_id, eventDateOnly, eventDateOnly)

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
    try {
      const before = db.prepare('SELECT rachat_status, rachat_order_id FROM subscription_events WHERE id=?').get(r.id)
      detectRachatForChurn(r.id)
      const after = db.prepare('SELECT rachat_status, rachat_order_id, subscription_id FROM subscription_events WHERE id=?').get(r.id)
      if (after && (after.rachat_status !== before.rachat_status || after.rachat_order_id !== before.rachat_order_id)) {
        emitSubscriptionEvent('updated', r.id, after.subscription_id, null)
      }
    } catch {}
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
  for (const r of rows) {
    try {
      const result = detectRachatForChurn(r.id)
      processed++
      if (result?.rachat_order_id) withCandidate++
    } catch {}
  }
  return { processed, withCandidate }
}
