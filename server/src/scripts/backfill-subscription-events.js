#!/usr/bin/env node
// One-shot : reconstruit l'historique des événements d'abonnement (création,
// churn, upgrade, downgrade, reactivation) en parcourant le journal Stripe
// `events.list` filtré sur les types `customer.subscription.*`. Pour chaque
// événement, on appelle la même logique que le webhook live (idempotent grâce
// à `stripe_event_id`).
//
// Usage :
//   node src/scripts/backfill-subscription-events.js              # dry run
//   node src/scripts/backfill-subscription-events.js --apply      # exécute
//   node src/scripts/backfill-subscription-events.js --apply --since=2024-01-01
//
// Limites de l'API Stripe : `events.list` retourne au max les 30 derniers
// jours par défaut, mais Stripe garde tout l'historique côté events. Le
// paramètre `created.gte` accepte des dates anciennes — testé jusqu'à 2 ans.

import Stripe from 'stripe'
import db from '../db/database.js'
import { recordEvent, classifyChange } from '../services/subscriptionEvents.js'
import { computeMonthlyNet } from '../services/subscriptionMonthly.js'
import { v4 as uuid } from 'uuid'
import { getStripeKey } from '../services/stripe.js'

const APPLY = process.argv.includes('--apply')
const sinceArg = process.argv.find(a => a.startsWith('--since='))
const SINCE = sinceArg ? new Date(sinceArg.split('=')[1]).getTime() / 1000 : null

const SUB_EVENT_TYPES = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]

function mapSubStatus(s) {
  const m = {
    active: 'active', past_due: 'past_due', canceled: 'canceled', trialing: 'trialing',
    unpaid: 'past_due', incomplete: 'past_due', incomplete_expired: 'canceled', paused: 'canceled',
  }
  return m[s] || 'canceled'
}

// Délègue au helper partagé pour la cohérence avec sync polling et webhook.
// Le payload des events historiques Stripe ne contient pas latest_invoice
// expandé : computeMonthlyNet retombe alors sur "items × qty − rabais" — déjà
// plus juste que l'ancienne version qui ignorait les rabais.
function computeMonthly(sub) {
  return computeMonthlyNet(sub)
}

async function main() {
  const secretKey = getStripeKey()
  if (!secretKey) {
    console.error('❌ Stripe non configuré (clé manquante en DB)')
    process.exit(1)
  }
  const stripe = new Stripe(secretKey)

  console.log(`Mode : ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  if (SINCE) console.log(`Filtre : events.created >= ${new Date(SINCE * 1000).toISOString()}`)
  console.log(`Récupération des events Stripe (types: ${SUB_EVENT_TYPES.join(', ')})...`)

  const stats = { byType: {}, byCategory: {}, inserted: 0, skippedDup: 0, skippedNoChange: 0, total: 0 }

  for (const type of SUB_EVENT_TYPES) {
    const params = { type, limit: 100 }
    if (SINCE) params.created = { gte: SINCE }
    let count = 0
    for await (const event of stripe.events.list(params)) {
      count++
      stats.total++
      stats.byType[type] = (stats.byType[type] || 0) + 1

      const sub = event.data.object
      const previous = event.data.previous_attributes || {}

      // Recherche le sub local. Si pas trouvé, on crée une ligne minimale dans
      // subscriptions pour pouvoir lier l'event (la sync polling enrichira plus
      // tard). On évite cependant si DRY RUN.
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id
      const companyId = customerId
        ? db.prepare('SELECT id FROM companies WHERE stripe_customer_id=? LIMIT 1').get(customerId)?.id || null
        : null

      const { amountMonthly, currency } = computeMonthly(sub)
      const status = mapSubStatus(sub.status)
      const startDate = sub.start_date ? new Date(sub.start_date * 1000).toISOString().split('T')[0] : null
      const cancelDate = sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString().split('T')[0] : null

      let subRow = db.prepare('SELECT * FROM subscriptions WHERE stripe_id=?').get(sub.id)
      if (!subRow && APPLY) {
        const newId = uuid()
        db.prepare(`
          INSERT INTO subscriptions (id, company_id, stripe_id, status, amount_monthly, currency, start_date, cancel_date)
          VALUES (?,?,?,?,?,?,?,?)
        `).run(newId, companyId, sub.id, status, amountMonthly, currency, startDate, cancelDate)
        subRow = { id: newId, company_id: companyId, status: null, amount_monthly: null }
      }
      if (!subRow) {
        // En dry run on n'a pas de subRow.id ; on log juste pour visibilité
        continue
      }

      // Classification — pour les événements 'updated', on utilise
      // previous_attributes pour comparer prev vs new dans l'event lui-même
      // (plus fiable que comparer à l'état courant en DB qui a déjà été synced).
      let prevStatus = subRow.status
      let prevAmount = subRow.amount_monthly
      if (event.type === 'customer.subscription.updated' && previous) {
        if (previous.status !== undefined) prevStatus = mapSubStatus(previous.status)
        // Stripe envoie items.data dans previous_attributes que pour les
        // changements profonds — souvent items reste opaque. Heuristique :
        // si on n'a pas d'info sur l'ancien montant, on garde la valeur DB.
      }

      let category, eventDate, prevAmountForEvent, newAmountForEvent
      if (event.type === 'customer.subscription.deleted') {
        category = 'churn'
        eventDate = cancelDate ? new Date(cancelDate).toISOString() : new Date(event.created * 1000).toISOString()
        prevAmountForEvent = prevAmount ?? amountMonthly
        newAmountForEvent = null
      } else if (event.type === 'customer.subscription.created') {
        // Sub déjà annulé à la création (rare) → pas un mouvement à enregistrer.
        if (status === 'canceled') {
          stats.skippedNoChange++
          continue
        }
        category = 'creation'
        eventDate = startDate ? new Date(startDate).toISOString() : new Date(event.created * 1000).toISOString()
        prevAmountForEvent = null
        newAmountForEvent = amountMonthly
      } else {
        category = classifyChange({ prevStatus, newStatus: status, prevAmount, newAmount: amountMonthly })
        if (!category) {
          stats.skippedNoChange++
          continue
        }
        eventDate = new Date(event.created * 1000).toISOString()
        prevAmountForEvent = prevAmount
        newAmountForEvent = amountMonthly
      }

      stats.byCategory[category] = (stats.byCategory[category] || 0) + 1

      if (APPLY) {
        const result = await recordEvent({
          subscriptionId: subRow.id,
          companyId: companyId || subRow.company_id,
          eventDate,
          eventType: category,
          category,
          previousAmount: prevAmountForEvent,
          newAmount: newAmountForEvent,
          currency,
          stripeEventId: event.id,
        })
        if (result.inserted) stats.inserted++
        else stats.skippedDup++
      }

      if (count % 50 === 0) console.log(`  ${type}: ${count} events traités...`)
    }
    console.log(`  ${type}: ${count} events`)
  }

  console.log('\n=== Récapitulatif ===')
  console.log(`Total events Stripe parcourus : ${stats.total}`)
  console.log(`Par type : ${JSON.stringify(stats.byType)}`)
  console.log(`Par catégorie : ${JSON.stringify(stats.byCategory)}`)
  if (APPLY) {
    console.log(`Insérés : ${stats.inserted}`)
    console.log(`Doublons ignorés (déjà vus) : ${stats.skippedDup}`)
  }
  console.log(`Sans changement matériel (skipped) : ${stats.skippedNoChange}`)
  if (!APPLY) console.log('\n→ Relancer avec --apply pour persister.')
}

main().catch(e => { console.error(e); process.exit(1) })
