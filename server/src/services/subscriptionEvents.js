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

// Catégories utilisées par le panel "Mouvements d'abonnements" du dashboard.
// On garde 'other' pour les events historiques qu'on ne classe pas (ex.: ancien
// 'update' générique avant l'enrichissement).
export const CATEGORIES = ['new', 'churn', 'upgrade', 'downgrade', 'reactivation', 'other']

async function toCad(amount, currency, dateStr) {
  if (amount == null) return null
  if (!currency || currency.toUpperCase() === 'CAD') return amount
  if (currency.toUpperCase() === 'USD') {
    const rate = await getUsdCadRate(dateStr || new Date().toISOString().slice(0, 10)) || 1.38
    return Math.round(amount * rate * 100) / 100
  }
  return amount  // autre devise → on stocke tel quel (cas marginaux)
}

// Classifie un changement de subscription en catégorie. Pour 'reactivation'
// (un client qui réactive un sub annulé), c'est rare via Stripe — un win-back
// est plutôt un nouvel abonnement après churn, calculé côté lecture par jointure
// sur `company_id` et la chronologie des events.
export function classifyChange({ prevStatus, newStatus, prevAmount, newAmount }) {
  const wasActive = prevStatus && prevStatus !== 'canceled'
  const isCanceled = newStatus === 'canceled'
  if (wasActive && isCanceled) return 'churn'
  if (!prevStatus && newStatus && newStatus !== 'canceled') return 'new'
  if (prevStatus === 'canceled' && newStatus && newStatus !== 'canceled') return 'reactivation'
  if (prevAmount != null && newAmount != null) {
    if (newAmount > prevAmount + 0.01) return 'upgrade'
    if (newAmount < prevAmount - 0.01) return 'downgrade'
  }
  return 'other'
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
 * @param {string|object} [args.details] — JSON ou string libre
 * @param {string} [args.stripeEventId] — pour idempotence webhooks
 * @returns {Promise<{inserted: boolean, id: string|null}>}
 */
export async function recordEvent(args) {
  const {
    subscriptionId, companyId = null, eventDate, eventType, category,
    previousAmount = null, newAmount = null, currency = 'CAD',
    details = null, stripeEventId = null,
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
  if (category === 'new') delta = newCad
  else if (category === 'churn') delta = previousCad != null ? -previousCad : null
  else if (category === 'reactivation') delta = newCad
  else if (previousCad != null && newCad != null) delta = newCad - previousCad

  const detailsStr = details == null
    ? null
    : (typeof details === 'string' ? details : JSON.stringify(details))

  const id = uuid()
  db.prepare(`
    INSERT INTO subscription_events (
      id, subscription_id, company_id, event_date, event_type, category,
      amount_cad_delta, previous_amount_cad, new_amount_cad, currency,
      details, stripe_event_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, subscriptionId, companyId, eventDate, eventType, category,
    delta, previousCad, newCad, currency,
    detailsStr, stripeEventId,
  )
  return { inserted: true, id }
}
