#!/usr/bin/env node
// One-shot : backfill des snapshots items_before_json / items_after_json sur
// les subscription_events legacy (créés avant le branchement webhook qui
// capture maintenant ces snapshots à la source).
//
// Stratégie par event :
//   - itemsBefore : items de la facture la plus récente AVANT event_date
//     (extraits depuis stripe_invoice_items, proration=0 uniquement). Si
//     aucune facture antérieure connue → [] (event de création).
//   - itemsAfter  : items de la facture la plus récente APRÈS event_date
//     (mêmes critères). Si aucune facture postérieure → on récupère l'état
//     courant du sub via l'API Stripe (sub.items.data). Si l'API est
//     indispo / le sub n'existe plus → on retombe sur itemsBefore (= rien
//     à diff).
//
// L'idée : pour les upgrades/downgrades récents (comme Blackbird Flower Farm,
// upgrade du 16 avril), la facture suivante n'a souvent pas encore été émise.
// Dans ce cas on snapshote depuis Stripe et le diff devient calculable.
//
// Usage :
//   node src/scripts/backfill-subscription-event-items.js              # dry run
//   node src/scripts/backfill-subscription-event-items.js --apply
//   node src/scripts/backfill-subscription-event-items.js --apply --event=ed1d8654-...
//   node src/scripts/backfill-subscription-event-items.js --apply --force
//
// Idempotent : par défaut ne touche que les events où items_before_json ET
// items_after_json sont NULL. --force réécrit tous les events.

import Stripe from 'stripe'
import db from '../db/database.js'
import {
  extractItemsFromStripeSub,
  setCurrentItemsSnapshot,
  diffSnapshots,
} from '../services/subscriptionItemsSnapshot.js'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const FORCE = args.includes('--force')
const ONE = args.find(a => a.startsWith('--event='))?.slice('--event='.length) || null

function getStripeKey() {
  const row = db.prepare(
    "SELECT value FROM connector_config WHERE connector='stripe' AND key='secret_key'"
  ).get()
  return row?.value || null
}

const stripeKey = getStripeKey()
const stripe = stripeKey ? new Stripe(stripeKey) : null
if (!stripe) console.warn('⚠ Stripe non configuré — fallback API désactivé.')

// Snapshot dérivé d'une facture locale : on lit les lignes stripe_invoice_items
// (proration=0). Pas de stripe_item_id côté facture (c'est un line de la
// facture, pas du subscription) — match key tombe donc sur stripe_price_id.
function snapshotFromInvoice(factureId) {
  const items = db.prepare(`
    SELECT stripe_price_id, stripe_product_id, description, quantity,
           unit_amount, currency
    FROM stripe_invoice_items
    WHERE facture_id = ? AND proration = 0
  `).all(factureId)
  return items.map(it => ({
    stripe_item_id: null,
    stripe_price_id: it.stripe_price_id,
    stripe_product_id: it.stripe_product_id,
    name: it.description || null,
    quantity: it.quantity ?? 1,
    unit_amount: it.unit_amount,
    currency: (it.currency || '').toUpperCase() || null,
    recurring_interval: null,
    recurring_interval_count: null,
  }))
}

// Cherche la facture la plus proche AVANT (direction='before') ou APRÈS
// (direction='after') eventDate pour un sub. Joint subscriptions car
// factures.subscription_id contient soit l'UUID ERP soit le stripe_id.
function findInvoice(subscriptionId, eventDate, direction) {
  const evDay = String(eventDate).slice(0, 10)
  const op = direction === 'before' ? '<' : '>='
  const ord = direction === 'before' ? 'DESC' : 'ASC'
  const row = db.prepare(`
    SELECT f.id
    FROM subscriptions s
    JOIN factures f ON f.subscription_id = s.id
                   OR (s.stripe_id IS NOT NULL AND f.subscription_id = s.stripe_id)
    WHERE s.id = ?
      AND f.document_date IS NOT NULL
      AND f.document_date ${op} ?
    ORDER BY f.document_date ${ord}, f.created_at ${ord}
    LIMIT 1
  `).get(subscriptionId, evDay)
  return row?.id || null
}

async function fetchCurrentStripeItems(stripeSubId) {
  if (!stripe || !stripeSubId) return null
  try {
    const sub = await stripe.subscriptions.retrieve(stripeSubId, {
      expand: ['items.data.price.product'],
    })
    return extractItemsFromStripeSub(sub)
  } catch (e) {
    console.warn(`⚠ Stripe.subscriptions.retrieve(${stripeSubId}) a échoué : ${e.message}`)
    return null
  }
}

async function main() {
  const wherePieces = ['e.category IN (\'creation\', \'churn\', \'reactivation\', \'upgrade\', \'downgrade\')']
  if (!FORCE) wherePieces.push('e.items_before_json IS NULL AND e.items_after_json IS NULL')
  if (ONE) wherePieces.push('e.id = ?')

  const events = db.prepare(`
    SELECT e.id, e.subscription_id, e.event_date, e.category,
           s.stripe_id
    FROM subscription_events e
    LEFT JOIN subscriptions s ON e.subscription_id = s.id
    WHERE ${wherePieces.join(' AND ')}
    ORDER BY e.event_date ASC
  `).all(...(ONE ? [ONE] : []))

  console.log(`${events.length} événement(s) à traiter${APPLY ? '' : ' (dry run)'}`)

  let withDiff = 0
  let touched = 0
  for (const e of events) {
    let itemsBefore = []
    let itemsAfter = []

    if (e.category === 'creation' || e.category === 'reactivation') {
      // before = []. after = première facture locale, ou état Stripe courant.
      const fid = findInvoice(e.subscription_id, e.event_date, 'after')
      if (fid) itemsAfter = snapshotFromInvoice(fid)
      else if (stripe && e.stripe_id) itemsAfter = (await fetchCurrentStripeItems(e.stripe_id)) || []
    } else if (e.category === 'churn') {
      // before = dernière facture connue avant cancel. after = [].
      const fid = findInvoice(e.subscription_id, e.event_date, 'before')
      if (fid) itemsBefore = snapshotFromInvoice(fid)
    } else if (e.category === 'upgrade' || e.category === 'downgrade') {
      const beforeFid = findInvoice(e.subscription_id, e.event_date, 'before')
      const afterFid = findInvoice(e.subscription_id, e.event_date, 'after')
      if (beforeFid) itemsBefore = snapshotFromInvoice(beforeFid)
      if (afterFid) {
        itemsAfter = snapshotFromInvoice(afterFid)
      } else if (stripe && e.stripe_id) {
        // Pas de facture postérieure → l'état Stripe actuel est notre meilleure
        // approximation de l'état post-event (suppose qu'aucun autre changement
        // n'est survenu depuis — vrai pour les events les plus récents).
        const live = await fetchCurrentStripeItems(e.stripe_id)
        if (live) itemsAfter = live
      }
    }

    const hasContent = itemsBefore.length > 0 || itemsAfter.length > 0
    if (!hasContent) {
      console.log(`  · ${e.id} (${e.category}, ${String(e.event_date).slice(0,10)}) — aucune source, skip`)
      continue
    }
    touched++
    if (e.category === 'upgrade' || e.category === 'downgrade') {
      // Diagnostic : utilise la même logique de matching que la prod.
      const upDiff = diffSnapshots(itemsBefore, itemsAfter, 'upgrade')
      const downDiff = diffSnapshots(itemsBefore, itemsAfter, 'downgrade')
      const direction = e.category === 'upgrade' ? upDiff : downDiff
      if (direction.length > 0) withDiff++
      const names = direction.map(it => it.name || it.stripe_product_id || '?').join(', ')
      console.log(`  · ${e.id} (${e.category}, ${String(e.event_date).slice(0,10)}) — before=${itemsBefore.length} after=${itemsAfter.length} → ${direction.length} item(s): ${names}`)
    } else {
      console.log(`  · ${e.id} (${e.category}, ${String(e.event_date).slice(0,10)}) — before=${itemsBefore.length} after=${itemsAfter.length}`)
    }

    if (APPLY) {
      db.prepare(`
        UPDATE subscription_events
        SET items_before_json = ?, items_after_json = ?
        WHERE id = ?
      `).run(JSON.stringify(itemsBefore), JSON.stringify(itemsAfter), e.id)

      // Met aussi à jour le miroir avec l'état "after" pour ce sub si non
      // annulé — utile pour que le prochain webhook ait un "before" cohérent.
      if (e.category !== 'churn' && itemsAfter.length > 0) {
        setCurrentItemsSnapshot(e.subscription_id, itemsAfter)
      }
    }
  }

  console.log(`\n${touched} événement(s) ${APPLY ? 'mis à jour' : 'à mettre à jour'}, dont ${withDiff} avec diff non vide.`)
  if (!APPLY) console.log('Lancer avec --apply pour persister.')
  process.exit(0)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
