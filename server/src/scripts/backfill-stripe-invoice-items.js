#!/usr/bin/env node
// One-shot: peuple stripe_invoice_items à partir des factures existantes ayant
// un invoice_id Stripe. Pour chaque facture, fetch les lignes via Stripe
// (listLineItems avec price expandé) et upsert dans stripe_invoice_items.
//
// Usage :
//   node src/scripts/backfill-stripe-invoice-items.js                # dry run (compte uniquement)
//   node src/scripts/backfill-stripe-invoice-items.js --apply        # execute
//   node src/scripts/backfill-stripe-invoice-items.js --apply --limit 50  # limite pour test

import Database from 'better-sqlite3'
import Stripe from 'stripe'
import { upsertFromInvoiceLines } from '../services/stripeInvoiceItems.js'

const DB_PATH = process.env.DB_PATH || './data/erp.db'
const APPLY = process.argv.includes('--apply')
const limitArg = process.argv.indexOf('--limit')
const LIMIT = limitArg >= 0 ? parseInt(process.argv[limitArg + 1]) : null

const db = new Database(DB_PATH)

const stripeKey = db.prepare(
  "SELECT value FROM connector_config WHERE connector='stripe' AND key='secret_key'"
).get()?.value
if (!stripeKey) {
  console.error('❌ Stripe non configuré (connector_config: stripe.secret_key absent)')
  process.exit(1)
}
const stripe = new Stripe(stripeKey)

const factures = db.prepare(`
  SELECT id, invoice_id, document_number
  FROM factures
  WHERE invoice_id IS NOT NULL AND invoice_id != ''
  ORDER BY created_at DESC
  ${LIMIT ? 'LIMIT ' + LIMIT : ''}
`).all()

console.log(`Factures candidates (invoice_id NON NULL): ${factures.length}`)

if (!APPLY) {
  console.log('\nDry run. Relance avec --apply pour appliquer.')
  process.exit(0)
}

let totalInserted = 0
let totalUpdated = 0
let processed = 0
const errors = []

for (const f of factures) {
  try {
    const allLines = []
    for await (const ln of stripe.invoices.listLineItems(f.invoice_id, { limit: 100, expand: ['data.price'] })) {
      allLines.push(ln)
    }
    if (allLines.length) {
      const r = upsertFromInvoiceLines(f.id, f.invoice_id, allLines)
      totalInserted += r.inserted
      totalUpdated += r.updated
    }
    processed++
    if (processed % 25 === 0) {
      console.log(`  … ${processed}/${factures.length} (insérées=${totalInserted}, MAJ=${totalUpdated})`)
    }
  } catch (e) {
    errors.push({ facture: f.id, invoice: f.invoice_id, error: e.message })
    console.error(`  ❌ ${f.invoice_id}: ${e.message}`)
  }
}

console.log(`\n✅ Terminé : ${processed} factures traitées`)
console.log(`   Lignes insérées : ${totalInserted}`)
console.log(`   Lignes mises à jour : ${totalUpdated}`)
console.log(`   Erreurs : ${errors.length}`)
if (errors.length && errors.length <= 20) {
  for (const e of errors) console.log(`   - ${e.invoice}: ${e.error}`)
}
process.exit(0)
