#!/usr/bin/env node
// One-shot : remplit factures.lien_stripe pour les factures Stripe natives.
//
// Contexte : la colonne `lien_stripe` (champ personnalisé « Lien stripe » sur
// /factures) était alimentée par la sync Airtable legacy. Depuis le passage au
// sync natif (webhooks Stripe + batch-enrich, ~2026-04-23), les nouvelles
// factures n'avaient plus de lien — la colonne apparaissait vide. Le fix
// pérenne est dans stripe-webhooks.js / stripe-queue.js (upsert écrit
// lien_stripe) ; ce script rattrape le stock existant.
//
// URL dérivée de invoice_id, même logique que buildStripeUrl côté client
// (FactureDetail.jsx) :
//   in_…              → https://dashboard.stripe.com/invoices/<id>
//   re_… / pyr_…      → https://dashboard.stripe.com/refunds/<id>
//   ch_… / pi_… / py_…→ https://dashboard.stripe.com/payments/<id>
//
// Usage :
//   node src/scripts/backfill-lien-stripe.js           # dry run
//   node src/scripts/backfill-lien-stripe.js --apply   # execute
import 'dotenv/config'
import db from '../db/database.js'

const APPLY = process.argv.includes('--apply')

function stripeUrlFor(invoiceId) {
  if (!invoiceId) return null
  if (invoiceId.startsWith('in_')) return `https://dashboard.stripe.com/invoices/${invoiceId}`
  if (invoiceId.startsWith('re_') || invoiceId.startsWith('pyr_')) return `https://dashboard.stripe.com/refunds/${invoiceId}`
  if (invoiceId.startsWith('ch_') || invoiceId.startsWith('pi_') || invoiceId.startsWith('py_')) {
    return `https://dashboard.stripe.com/payments/${invoiceId}`
  }
  return null
}

const rows = db.prepare(`
  SELECT id, invoice_id, sync_source, document_number
  FROM factures
  WHERE sync_source IN ('Factures Stripe', 'Remboursements Stripe')
    AND (lien_stripe IS NULL OR lien_stripe = '')
    AND invoice_id IS NOT NULL
`).all()

const upd = db.prepare(
  `UPDATE factures SET lien_stripe=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`
)

let updated = 0
let skipped = 0
for (const r of rows) {
  const url = stripeUrlFor(r.invoice_id)
  if (!url) { skipped++; console.log(`  ⏭️  ${r.document_number || r.id} : invoice_id non reconnu (${r.invoice_id})`); continue }
  if (APPLY) upd.run(url, r.id)
  updated++
}

console.log(`${APPLY ? '✅' : '🔍 [dry-run]'} ${updated} factures ${APPLY ? 'mises à jour' : 'à mettre à jour'}, ${skipped} skip (préfixe inconnu) sur ${rows.length}`)
if (!APPLY) console.log('Relancer avec --apply pour exécuter.')
