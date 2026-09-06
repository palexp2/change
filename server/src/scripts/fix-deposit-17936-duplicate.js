// One-off : le paiement Interac de la facture JQGA5BF3-0002 (Artisans Maraichers,
// 8 853,10 $ TTC) a été comptabilisé DEUX FOIS dans QuickBooks.
//
//   Deposit 17936 (2026-09-01, auto via postPaymentDeposit) — FAUX : ligne HT à
//     11 000 $ au lieu de 7 700 $. Cause : buildPaymentDeposit dérivait le HT du
//     ratio invoice.subtotal/invoice.total de Stripe, mais invoice.subtotal est
//     AVANT rabais — cette facture porte 30 % de rabais (total_discount_amounts
//     = 3300 $), donc subtotal (11000) > total (8853.10) et le ratio dérape au-delà
//     de 1. Total du Deposit : 12 647,25 $ (11000 + taxe) au lieu de 8 853,10 $.
//   Deposit 17955 (2026-09-06, créé manuellement dans QBO) — CORRECT : ligne HT à
//     7 700 $, taxe 1 153,10 $, total 8 853,10 $ — concorde avec factures.amount_
//     before_tax_cad / total_amount et payments.amount.
//
// Le bug source est corrigé dans services/quickbooks.js (buildPaymentDeposit :
// net des rabais Stripe dans le ratio HT/TTC). Ce script :
//   1) DELETE le Deposit 17936 (le doublon erroné) dans QB
//   2) Réaligne payments (qb_deposit_id → 17955) et factures (deferred_revenue_*)
//      sur le Deposit correct déjà en place
//
// Usage : cd server && node src/scripts/fix-deposit-17936-duplicate.js [--apply]
// Par défaut dry-run.

import db from '../db/database.js'
import { qbGet, qbPost } from '../connectors/quickbooks.js'

const WRONG_DEPOSIT_ID = '17936'
const CORRECT_DEPOSIT_ID = '17955'
const PAYMENT_ID = '4dc40aac-a3f7-4a1b-bf16-0508a69ee9f3'
const FACTURE_ID = '57d9b3f5-d17d-473e-b1af-94555622e090'
const APPLY = process.argv.includes('--apply')

const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(PAYMENT_ID)
if (!payment) throw new Error(`Paiement introuvable: ${PAYMENT_ID}`)
if (payment.qb_deposit_id !== WRONG_DEPOSIT_ID) {
  throw new Error(`Inattendu: payments.qb_deposit_id=${payment.qb_deposit_id} (attendu ${WRONG_DEPOSIT_ID}) — abort par sécurité.`)
}

const wrong = (await qbGet(`/deposit/${WRONG_DEPOSIT_ID}`)).Deposit
const correct = (await qbGet(`/deposit/${CORRECT_DEPOSIT_ID}`)).Deposit
console.log(`Deposit ${WRONG_DEPOSIT_ID} (à supprimer): TotalAmt=${wrong.TotalAmt} SyncToken=${wrong.SyncToken}`)
console.log(`Deposit ${CORRECT_DEPOSIT_ID} (à garder):   TotalAmt=${correct.TotalAmt} Line[0].Amount=${correct.Line?.[0]?.Amount}`)

if (Math.abs(Number(correct.TotalAmt) - Number(payment.amount)) > 0.01) {
  throw new Error(`Deposit ${CORRECT_DEPOSIT_ID} TotalAmt=${correct.TotalAmt} ne concorde pas avec payments.amount=${payment.amount} — abort.`)
}

const lineHt = Number(correct.Line?.[0]?.Amount || 0)

if (!APPLY) {
  console.log('\nDRY-RUN. Relancer avec --apply pour exécuter :')
  console.log(`  1) DELETE Deposit ${WRONG_DEPOSIT_ID} dans QB`)
  console.log(`  2) UPDATE payments SET qb_deposit_id='${CORRECT_DEPOSIT_ID}' WHERE id='${PAYMENT_ID}'`)
  console.log(`  3) UPDATE factures SET deferred_revenue_amount_native=${lineHt}, deferred_revenue_amount_cad=${lineHt}, deferred_revenue_qb_ref='deposit:${CORRECT_DEPOSIT_ID}' WHERE id='${FACTURE_ID}'`)
  process.exit(0)
}

console.log('\n--- APPLY ---')

console.log(`1) DELETE Deposit ${WRONG_DEPOSIT_ID} dans QB…`)
const delResult = await qbPost(`/deposit?operation=delete`, { Id: wrong.Id, SyncToken: wrong.SyncToken })
console.log('   →', JSON.stringify(delResult).slice(0, 200))

console.log('2) Réaligner payments.qb_deposit_id…')
db.prepare(`
  UPDATE payments
  SET qb_deposit_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`).run(CORRECT_DEPOSIT_ID, PAYMENT_ID)
console.log('   → done')

console.log('3) Réaligner factures.deferred_revenue_amount_*…')
db.prepare(`
  UPDATE factures
  SET deferred_revenue_amount_native = ?,
      deferred_revenue_amount_cad = ?,
      deferred_revenue_qb_ref = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`).run(lineHt, lineHt, `deposit:${CORRECT_DEPOSIT_ID}`, FACTURE_ID)
console.log('   → done')

console.log('\nVérification :')
const check = db.prepare('SELECT qb_deposit_id FROM payments WHERE id = ?').get(PAYMENT_ID)
console.log(`  payments.qb_deposit_id = ${check.qb_deposit_id}`)
const factureCheck = db.prepare('SELECT deferred_revenue_amount_native, deferred_revenue_amount_cad, deferred_revenue_qb_ref FROM factures WHERE id = ?').get(FACTURE_ID)
console.log(`  factures.deferred_revenue_* =`, factureCheck)

db.close()
