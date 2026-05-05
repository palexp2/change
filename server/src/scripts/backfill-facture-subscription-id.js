#!/usr/bin/env node
// One-shot: rattache subscription_id sur les factures où kind='subscription'
// mais subscription_id est NULL.
//
// Cause racine : webhook invoice.paid résout subscription_id au moment de
// l'insertion en faisant un SELECT FROM subscriptions WHERE stripe_id=?. Si
// l'abonnement Stripe n'est pas encore synchronisé localement (le sync
// abonnements n'a pas tourné), le lookup retourne null. Une mise à jour
// ultérieure du facture utilise COALESCE(subscription_id, ?) — donc le lien
// ne se rattrape jamais.
//
// Le script :
// 1. Lance syncStripeSubscriptions() pour s'assurer que toutes les
//    subscriptions Stripe sont en base locale.
// 2. Pour chaque facture candidate, fetch l'invoice Stripe pour récupérer
//    invoice.subscription, lookup la subscription locale par stripe_id,
//    et UPDATE factures SET subscription_id=?.
//
// Usage :
//   node src/scripts/backfill-facture-subscription-id.js              # dry run
//   node src/scripts/backfill-facture-subscription-id.js --apply      # exécute
//   node src/scripts/backfill-facture-subscription-id.js --apply --no-sync   # skip étape 1

import Stripe from 'stripe'
import db from '../db/database.js'
import { syncStripeSubscriptions } from '../services/stripe.js'

const APPLY = process.argv.includes('--apply')
const NO_SYNC = process.argv.includes('--no-sync')

const stripeKey = db.prepare(
  "SELECT value FROM connector_config WHERE connector='stripe' AND key='secret_key'"
).get()?.value
if (!stripeKey) {
  console.error('❌ Stripe non configuré (connector_config: stripe.secret_key absent)')
  process.exit(1)
}
const stripe = new Stripe(stripeKey)

async function main() {
  if (!NO_SYNC) {
    console.log('🔄 Étape 1 : sync des abonnements Stripe → table locale subscriptions')
    if (APPLY) {
      const r = await syncStripeSubscriptions()
      console.log(`   ${r.created} créés, ${r.updated} mis à jour, ${r.total} total\n`)
    } else {
      console.log('   (dry run — saute le sync, relance avec --apply pour l\'exécuter)\n')
    }
  }

  console.log('🔍 Étape 2 : recherche des factures candidates')
  const candidates = db.prepare(`
    SELECT id, invoice_id, document_number, company_id, kind, subscription_id
    FROM factures
    WHERE kind = 'subscription'
      AND subscription_id IS NULL
      AND invoice_id IS NOT NULL
      AND invoice_id != ''
    ORDER BY created_at ASC
  `).all()

  console.log(`   ${candidates.length} facture(s) candidate(s).`)
  if (candidates.length === 0) {
    console.log('\n✅ Rien à faire.')
    process.exit(0)
  }

  let linked = 0
  let stripeNoSub = 0
  let localMissing = 0
  let errors = 0
  const details = []

  for (const f of candidates) {
    try {
      const invoice = await stripe.invoices.retrieve(f.invoice_id)
      // Stripe API ≥ 2024-09 : la subscription est exposée via
      // invoice.parent.subscription_details.subscription. L'ancien champ
      // invoice.subscription est undefined dans les versions récentes.
      const fromParent = invoice.parent?.subscription_details?.subscription
      const fromTopLevel = invoice.subscription
      const stripeSubRaw = fromTopLevel || fromParent || null
      const stripeSub = typeof stripeSubRaw === 'string'
        ? stripeSubRaw
        : (stripeSubRaw?.id || null)

      if (!stripeSub) {
        // L'invoice Stripe n'a finalement pas de subscription —
        // kind='subscription' est incorrect, on remet 'order' aussi.
        stripeNoSub++
        details.push({ facture: f.document_number || f.id, action: 'no-subscription-on-stripe', kind_was: f.kind })
        if (APPLY) {
          db.prepare("UPDATE factures SET kind='order', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(f.id)
        }
        continue
      }

      const sub = db.prepare('SELECT id FROM subscriptions WHERE stripe_id=?').get(stripeSub)
      if (!sub) {
        // Sync a tourné mais on ne trouve pas — l'abonnement n'existe peut-être
        // plus côté Stripe (purgé ?) ou est dans un statut non listé.
        localMissing++
        details.push({ facture: f.document_number || f.id, action: 'local-subscription-missing', stripe_sub: stripeSub })
        continue
      }

      details.push({ facture: f.document_number || f.id, action: 'link', stripe_sub: stripeSub, local_sub: sub.id })
      if (APPLY) {
        db.prepare(`
          UPDATE factures
          SET subscription_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?
        `).run(sub.id, f.id)
      }
      linked++
    } catch (e) {
      errors++
      details.push({ facture: f.document_number || f.id, action: 'error', error: e.message })
      console.error(`   ❌ ${f.invoice_id} (${f.document_number || f.id}): ${e.message}`)
    }
  }

  console.log(`\n   À rattacher : ${linked}`)
  console.log(`   Sans subscription côté Stripe (kind corrigé en 'order') : ${stripeNoSub}`)
  console.log(`   Subscription manquante en base locale après sync : ${localMissing}`)
  console.log(`   Erreurs : ${errors}`)

  console.log('\n📋 Détail :')
  for (const d of details) {
    if (d.action === 'link') {
      console.log(`   ✓ ${d.facture}: ${d.stripe_sub} → ${d.local_sub}`)
    } else if (d.action === 'no-subscription-on-stripe') {
      console.log(`   ! ${d.facture}: pas de subscription côté Stripe (kind: ${d.kind_was} → order)`)
    } else if (d.action === 'local-subscription-missing') {
      console.log(`   ? ${d.facture}: ${d.stripe_sub} introuvable en base locale après sync`)
    } else if (d.action === 'error') {
      console.log(`   ✗ ${d.facture}: ${d.error}`)
    }
  }

  console.log(APPLY ? '\n✅ Modifications appliquées.' : '\n⚠️  Dry run — relance avec --apply pour appliquer.')
  process.exit(0)
}

main().catch(e => {
  console.error('❌ Échec :', e)
  process.exit(1)
})
