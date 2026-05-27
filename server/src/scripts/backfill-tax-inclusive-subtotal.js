#!/usr/bin/env node
// One-shot : corrige amount_before_tax_cad / montant_avant_taxes (factures) et
// unit_amount / amount (stripe_invoice_items) pour les factures Stripe dont les
// prix sont configurés `tax_behavior: "inclusive"`. Avant correction, le code
// utilisait `invoice.subtotal` (TTC en inclusive) au lieu de
// `invoice.subtotal_excluding_tax` (HT), et `price.unit_amount` (TTC) au lieu
// de `line.subtotal / quantity` (HT).
//
// Usage :
//   node src/scripts/backfill-tax-inclusive-subtotal.js              # dry run
//   node src/scripts/backfill-tax-inclusive-subtotal.js --apply      # execute
//   node src/scripts/backfill-tax-inclusive-subtotal.js --apply --limit 10
import 'dotenv/config'
import db from '../db/database.js'
import Stripe from 'stripe'
import { upsertFromInvoiceLines } from '../services/stripeInvoiceItems.js'

const APPLY = process.argv.includes('--apply')
const limitIdx = process.argv.indexOf('--limit')
const LIMIT = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1]) : null

function getStripeKey() {
  const row = db.prepare("SELECT value FROM connector_config WHERE connector='stripe' AND key='secret_key'").get()
  return row?.value || null
}

const stripeKey = getStripeKey()
if (!stripeKey) {
  console.error('Stripe non configuré')
  process.exit(1)
}
const stripe = new Stripe(stripeKey)

const rows = db.prepare(`
  SELECT id, invoice_id, document_number, amount_before_tax_cad, total_amount
  FROM factures
  WHERE invoice_id IS NOT NULL AND sync_source = 'Factures Stripe'
  ORDER BY document_date DESC
`).all()

const target = LIMIT ? rows.slice(0, LIMIT) : rows
console.log(`Factures à examiner : ${target.length}${LIMIT ? ` (limit ${LIMIT})` : ''}`)

const updateStmt = db.prepare(`
  UPDATE factures SET
    amount_before_tax_cad = ?,
    montant_avant_taxes = ?,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`)

let examined = 0
let updated = 0
let linesUpdated = 0
let unchanged = 0
let errors = 0
const sampleChanges = []

for (const f of target) {
  examined++
  try {
    const inv = await stripe.invoices.retrieve(f.invoice_id)
    const subtotalHT = (inv.subtotal_excluding_tax ?? inv.subtotal ?? 0) / 100
    const oldSubtotal = Number(f.amount_before_tax_cad) || 0

    // Ne corriger QUE les factures avec au moins une ligne tax_behavior=inclusive.
    // Les autres écarts (subtotal_avant !== subtotal_HT sans ligne inclusive) sont
    // dus à un quirk historique de FX (amount_before_tax_cad stocké en CAD-converti
    // au lieu de natif pour les vieilles factures USD) — hors-scope de ce backfill.
    const hasInclusiveLine = (inv.lines?.data || []).some(
      l => Number.isFinite(l.subtotal) && Number.isFinite(l.amount) && l.subtotal !== l.amount
    )

    if (!hasInclusiveLine) {
      unchanged++
      continue
    }

    const subtotalDiff = Math.abs(subtotalHT - oldSubtotal) >= 0.01

    if (APPLY) {
      if (subtotalDiff) {
        updateStmt.run(subtotalHT, String(subtotalHT), f.id)
        updated++
      }
      // Re-upsert les lignes — normalizeLine corrigé utilisera line.subtotal.
      let allLines = inv.lines?.data || []
      if (inv.lines?.has_more) {
        for await (const ln of stripe.invoices.listLineItems(f.invoice_id, { limit: 100 })) {
          if (!allLines.find(x => x.id === ln.id)) allLines.push(ln)
        }
      }
      if (allLines.length) {
        const r = upsertFromInvoiceLines(f.id, f.invoice_id, allLines)
        if (r.updated > 0) linesUpdated += r.updated
      }
    } else {
      if (sampleChanges.length < 10) {
        sampleChanges.push({
          document_number: f.document_number,
          invoice_id: f.invoice_id,
          subtotal_avant: oldSubtotal,
          subtotal_apres: subtotalHT,
          diff: Math.round((subtotalHT - oldSubtotal) * 100) / 100,
        })
      }
      if (subtotalDiff) updated++
    }
  } catch (e) {
    errors++
    console.error(`✗ ${f.document_number || f.invoice_id}: ${e.message}`)
  }
  if (examined % 50 === 0) {
    console.log(`  ${examined}/${target.length} examinées (corrigées: ${updated}, inchangées: ${unchanged}, erreurs: ${errors})`)
  }
}

console.log(`\nRésumé :`)
console.log(`  Examinées      : ${examined}`)
console.log(`  À corriger     : ${updated}`)
console.log(`  Lignes MAJ     : ${linesUpdated}`)
console.log(`  Inchangées     : ${unchanged}`)
console.log(`  Erreurs        : ${errors}`)

if (!APPLY && sampleChanges.length) {
  console.log('\nÉchantillon de changements (dry run) :')
  for (const c of sampleChanges) console.log(' ', JSON.stringify(c))
  console.log('\nDry run terminé. Relance avec --apply pour appliquer.')
}

process.exit(0)
