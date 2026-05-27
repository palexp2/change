// Backfill : pose `factures.revenue_recognized_at` pour les commandes dont la
// vente a été constatée DIRECTEMENT par la ligne Cr 40000 d'un Deposit Stripe
// déjà poussé en QB — mais où le flag n'a pas été posé en DB (push antérieur
// à l'ajout du bloc `directlyRecognizedFactures` dans pushDepositFromPayout).
//
// Critères (= mêmes conditions que `directlyRecognizedFactures` au push) :
//   - kind = 'order'
//   - revenue_recognized_at IS NULL
//   - revenue_recognized_je_id IS NULL
//   - deferred_revenue_at IS NULL
//   - balance_due = 0  (sinon la ligne du Deposit aurait été 12000/12100, pas 40000)
//   - lien shipment présent (factureHasLinkedShipment = true)
//   - payment Stripe rattaché → payout poussé (qb_deposit_id non NULL)
//
// Date posée : payout.arrival_date (date comptable du Deposit en QB).
//
// Usage :
//   cd server && node src/scripts/backfill-direct-deposit-recognition.js          # dry-run
//   cd server && node src/scripts/backfill-direct-deposit-recognition.js --apply  # exécute

import db from '../db/database.js'

const APPLY = process.argv.includes('--apply')

// Mêmes conditions que server/src/services/quickbooks.js:factureHasLinkedShipment
const candidatesQuery = `
  SELECT
    f.id, f.document_number, f.invoice_id, f.paid_charge_id, f.currency,
    f.amount_before_tax_cad, f.total_amount, f.balance_due,
    bt.payout_stripe_id,
    po.arrival_date AS payout_arrival_date,
    po.qb_deposit_id AS payout_qb_deposit_id
  FROM factures f
  LEFT JOIN orders o_d ON o_d.id = f.order_id
  LEFT JOIN orders o_p ON o_p.project_id = f.project_id AND f.project_id IS NOT NULL
  -- Trouve la balance_transaction (charge) du paiement Stripe, soit par invoice, soit par charge id
  LEFT JOIN stripe_balance_transactions bt
    ON ( (f.invoice_id IS NOT NULL AND bt.stripe_invoice_id = f.invoice_id)
      OR (f.paid_charge_id IS NOT NULL AND bt.source_id = f.paid_charge_id) )
    AND bt.type IN ('charge', 'payment')
  LEFT JOIN stripe_payouts po ON po.stripe_id = bt.payout_stripe_id
  WHERE f.kind = 'order'
    AND f.revenue_recognized_at IS NULL
    AND f.revenue_recognized_je_id IS NULL
    AND f.deferred_revenue_at IS NULL
    AND COALESCE(f.balance_due, 0) = 0
    AND f.paid_at IS NOT NULL
    AND po.qb_deposit_id IS NOT NULL
    AND po.arrival_date IS NOT NULL
    AND (
      f.is_sent_manual = 1
      OR (f.order_id IS NULL AND f.project_id IS NULL)
      OR EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o_d.id OR s.order_id = o_p.id)
    )
  ORDER BY po.arrival_date, f.document_number
`

const rows = db.prepare(candidatesQuery).all()

console.log(`Candidates : ${rows.length} facture(s)`)
console.log('')

if (rows.length === 0) {
  console.log('Rien à faire.')
  process.exit(0)
}

console.log('document_number'.padEnd(20) + 'currency '.padEnd(10) + 'total'.padStart(10) + '   payout            DEP    arrival_date')
console.log('-'.repeat(110))
for (const r of rows) {
  console.log(
    String(r.document_number || r.id.slice(0, 8)).padEnd(20)
    + String(r.currency || '').padEnd(10)
    + String(r.total_amount || 0).padStart(10)
    + '   ' + String(r.payout_stripe_id || '').padEnd(30)
    + String(r.payout_qb_deposit_id || '').padEnd(7)
    + String(r.payout_arrival_date || '')
  )
}

if (!APPLY) {
  console.log('')
  console.log('Dry-run. Relance avec --apply pour exécuter.')
  process.exit(0)
}

const updateStmt = db.prepare(`
  UPDATE factures
  SET revenue_recognized_at = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
    AND revenue_recognized_at IS NULL
    AND revenue_recognized_je_id IS NULL
    AND deferred_revenue_at IS NULL
`)

let updated = 0
const tx = db.transaction(() => {
  for (const r of rows) {
    const res = updateStmt.run(r.payout_arrival_date, r.id)
    if (res.changes) updated += 1
  }
})
tx()

console.log('')
console.log(`✅ ${updated} facture(s) mises à jour.`)
