#!/usr/bin/env node
// One-shot : corrige amount_before_tax_cad / montant_avant_taxes (factures
// Stripe) pour les factures portant un RABAIS. Avant correction, le sync
// utilisait `invoice.subtotal_excluding_tax` — HT mais AVANT rabais : une
// facture de 11 600 $ remisée à 5 220 $ était enregistrée à 11 600 $. Le revenu
// (dashboard, Rentabilité d'une commande) était donc surévalué, et l'invariant
// HT + taxes = total cassé. La valeur juste est `invoice.total_excluding_tax`
// (HT après rabais) — cf. services/stripeFactureFieldMap.js.
//
// Trois cas par facture remisée :
//   - déjà égale au HT après rabais → inchangée (idempotent) ;
//   - égale au HT natif avant rabais → remplacée par le HT après rabais ;
//   - ni l'un ni l'autre (vieilles factures USD dont amount_before_tax_cad est
//     converti en CAD, cf. backfill-tax-inclusive-subtotal.js) → on applique le
//     seul ratio du rabais pour ne pas écraser la conversion de devise.
//
// Les colonnes deferred_revenue_* ne sont PAS touchées : elles gardent la trace
// du montant réellement posté dans QuickBooks. Le script liste à la fin les
// factures corrigées déjà poussées en QB — leur écriture QB reste à revoir à la
// main.
//
// Usage :
//   node src/scripts/backfill-factures-ht-after-discount.js            # dry run
//   node src/scripts/backfill-factures-ht-after-discount.js --apply
//   node src/scripts/backfill-factures-ht-after-discount.js --apply --limit 10
import 'dotenv/config'
import db from '../db/database.js'
import Stripe from 'stripe'
import { getStripeKey } from '../services/stripe.js'

const APPLY = process.argv.includes('--apply')
const limitIdx = process.argv.indexOf('--limit')
const LIMIT = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1]) : null

const stripeKey = getStripeKey()
if (!stripeKey) {
  console.error('Stripe non configuré')
  process.exit(1)
}
const stripe = new Stripe(stripeKey)

const round2 = n => Math.round(n * 100) / 100

const rows = db.prepare(`
  SELECT id, invoice_id, document_number, currency, amount_before_tax_cad,
         total_amount, deferred_revenue_qb_ref
  FROM factures
  WHERE invoice_id LIKE 'in_%' AND sync_source = 'Factures Stripe'
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
let noDiscount = 0
let alreadyOk = 0
let fixedNative = 0
let fixedProrata = 0
let ambiguous = 0
let errors = 0
let deltaTotal = 0
const qbPushed = []
const sample = []

for (const f of target) {
  examined++
  try {
    const inv = await stripe.invoices.retrieve(f.invoice_id)
    const discount = (inv.total_discount_amounts || []).reduce((a, x) => a + (x.amount || 0), 0)
    if (discount <= 0) { noDiscount++; continue }

    const beforeNative = (inv.subtotal_excluding_tax ?? inv.subtotal ?? 0) / 100
    const afterNative = (inv.total_excluding_tax ?? beforeNative) / 100
    const old = Number(f.amount_before_tax_cad) || 0

    let next = null
    let kind = null
    if (Math.abs(old - afterNative) <= 0.01) {
      alreadyOk++
      continue
    } else if (Math.abs(old - beforeNative) <= 0.01) {
      next = afterNative
      kind = 'natif'
    } else if (beforeNative > 0) {
      next = round2(old * (afterNative / beforeNative))
      kind = 'prorata'
    } else {
      ambiguous++
      console.warn(`? ${f.document_number || f.invoice_id}: HT stocké ${old}, HT Stripe avant rabais ${beforeNative} — non corrigé`)
      continue
    }

    if (kind === 'natif') fixedNative++
    else fixedProrata++
    deltaTotal += next - old
    if (f.deferred_revenue_qb_ref) {
      qbPushed.push({ document_number: f.document_number, qb_ref: f.deferred_revenue_qb_ref, avant: old, apres: next })
    }
    if (sample.length < 15) {
      sample.push({ document_number: f.document_number, kind, avant: old, apres: next, rabais: discount / 100 })
    }

    if (APPLY) updateStmt.run(next, String(next), f.id)
  } catch (e) {
    errors++
    console.error(`✗ ${f.document_number || f.invoice_id}: ${e.message}`)
  }
  if (examined % 100 === 0) {
    console.log(`  ${examined}/${target.length} examinées (à corriger: ${fixedNative + fixedProrata}, sans rabais: ${noDiscount}, déjà bonnes: ${alreadyOk}, erreurs: ${errors})`)
  }
}

console.log(`\nRésumé :`)
console.log(`  Examinées         : ${examined}`)
console.log(`  Sans rabais       : ${noDiscount}`)
console.log(`  Déjà après rabais : ${alreadyOk}`)
console.log(`  Corrigées (natif) : ${fixedNative}`)
console.log(`  Corrigées (ratio) : ${fixedProrata}`)
console.log(`  Ambiguës          : ${ambiguous}`)
console.log(`  Erreurs           : ${errors}`)
console.log(`  Écart de revenu   : ${round2(deltaTotal)} $`)

if (sample.length) {
  console.log(`\nÉchantillon :`)
  for (const s of sample) console.log(' ', JSON.stringify(s))
}
if (qbPushed.length) {
  console.log(`\n⚠️  ${qbPushed.length} facture(s) corrigée(s) ont déjà un revenu perçu d'avance dans QuickBooks — écriture QB à revoir :`)
  for (const q of qbPushed.slice(0, 30)) console.log(' ', JSON.stringify(q))
}
if (!APPLY) console.log('\nDry run terminé. Relance avec --apply pour appliquer.')

process.exit(0)
