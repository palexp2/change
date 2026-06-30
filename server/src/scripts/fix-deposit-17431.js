// One-off : corrige Deposit QB 17431 (payout po_1TcF3rEO122sMsbJQ1Bl5wao, juin 2026)
// dont la ligne « Ajustement d'arrondi taxes (-610.38) » plug en réalité de la taxe
// de remboursement manquante. Un refund partiel de 730 $ (sur facture 4805,96 $ TTC)
// avait hérité de 100 % de la taxe de la facture (625,96 $) au lieu de sa part
// proratisée (~95 $). La ligne refund du Deposit était donc en HT -104,04 (au lieu
// de -634,92), et QB recalculait 15,58 $ de taxe au lieu de 95,08 $ — l'écart de
// 610,38 $ étant déversé dans l'ajustement d'arrondi.
//
// Le fix est dans stripe.js (proRateRefundTax). Ce script :
//   1) resync les balance_transactions du payout → la taxe stockée devient correcte
//   2) DELETE le Deposit existant dans QB
//   3) clear qb_deposit_id sur le payout
//   4) pushDepositFromPayout → recrée le Deposit avec la taxe de refund correcte,
//      sans ligne d'arrondi de 610 $ (résidu attendu : quelques cents max)
//
// Usage :
//   cd server && node src/scripts/fix-deposit-17431.js [--apply]
// Par défaut dry-run (affiche le plan). Avec --apply : exécute.

import db from '../db/database.js'
import { qbGet, qbPost } from '../connectors/quickbooks.js'
import { pushDepositFromPayout } from '../services/quickbooks.js'
import { syncStripeBalanceTransactions } from '../services/stripe.js'

const PAYOUT_ID = 'po_1TcF3rEO122sMsbJQ1Bl5wao'
const EXPECTED_DEPOSIT_ID = '17431'
const APPLY = process.argv.includes('--apply')

const payout = db.prepare('SELECT * FROM stripe_payouts WHERE stripe_id=?').get(PAYOUT_ID)
if (!payout) throw new Error(`Payout introuvable: ${PAYOUT_ID}`)
console.log(`Payout: ${PAYOUT_ID}  amount=${payout.amount} ${payout.currency}  qb_deposit_id=${payout.qb_deposit_id}`)

if (payout.qb_deposit_id !== EXPECTED_DEPOSIT_ID) {
  throw new Error(`Inattendu: qb_deposit_id=${payout.qb_deposit_id} (attendu ${EXPECTED_DEPOSIT_ID}) — abort par sécurité.`)
}

const verify = await qbGet(`/deposit/${EXPECTED_DEPOSIT_ID}`)
const dep = verify.Deposit
console.log(`Deposit QB actuel: Id=${dep.Id} SyncToken=${dep.SyncToken} TotalAmt=${dep.TotalAmt} Lines=${dep.Line?.length}`)
const adjLine = (dep.Line || []).find(l => /Ajustement d'arrondi taxes/i.test(l.Description || ''))
if (adjLine) console.log(`  → Ligne d'arrondi présente: "${adjLine.Description}" (${adjLine.Amount})`)
else console.log(`  → Aucune ligne d'arrondi visible (le fix s'applique quand même — re-push propre).`)

// Aperçu de la taxe refund stockée AVANT resync (pour traçabilité).
const refBefore = db.prepare(
  "SELECT amount, invoice_tax_gst, invoice_tax_qst FROM stripe_balance_transactions WHERE payout_stripe_id=? AND type='refund'"
).all(PAYOUT_ID)
for (const r of refBefore) {
  console.log(`  refund BT avant resync: amount=${r.amount} gst=${r.invoice_tax_gst} qst=${r.invoice_tax_qst} (somme=${((r.invoice_tax_gst || 0) + (r.invoice_tax_qst || 0)).toFixed(2)})`)
}

if (!APPLY) {
  console.log('\nDRY-RUN. Relancer avec --apply pour exécuter :')
  console.log('  1) syncStripeBalanceTransactions(payout) — recalcule la taxe refund proratisée')
  console.log(`  2) DELETE Deposit ${EXPECTED_DEPOSIT_ID} dans QB`)
  console.log('  3) UPDATE stripe_payouts SET qb_deposit_id=NULL WHERE stripe_id=?')
  console.log('  4) pushDepositFromPayout(payout) — recrée le Deposit avec taxe correcte')
  process.exit(0)
}

console.log('\n--- APPLY ---')

console.log('1) Resync balance_transactions (taxe refund proratisée)…')
const syncRes = await syncStripeBalanceTransactions(PAYOUT_ID)
console.log('   →', JSON.stringify(syncRes))
const refAfter = db.prepare(
  "SELECT amount, invoice_tax_gst, invoice_tax_qst FROM stripe_balance_transactions WHERE payout_stripe_id=? AND type='refund'"
).all(PAYOUT_ID)
for (const r of refAfter) {
  console.log(`   refund BT après resync: amount=${r.amount} gst=${r.invoice_tax_gst} qst=${r.invoice_tax_qst} (somme=${((r.invoice_tax_gst || 0) + (r.invoice_tax_qst || 0)).toFixed(2)})`)
}

console.log('2) DELETE Deposit dans QB…')
const delResult = await qbPost(`/deposit?operation=delete`, { Id: dep.Id, SyncToken: dep.SyncToken })
console.log('   →', JSON.stringify(delResult).slice(0, 200))

console.log('3) Clear qb_deposit_id sur le payout…')
db.prepare('UPDATE stripe_payouts SET qb_deposit_id=NULL, qb_pushed_at=NULL WHERE stripe_id=?').run(PAYOUT_ID)
console.log('   → done')

console.log('4) pushDepositFromPayout…')
const res = await pushDepositFromPayout(PAYOUT_ID)
console.log('   → qb_deposit_id =', res.qb_deposit_id)
if (res.warnings?.length) console.log('   → warnings:', res.warnings)
console.log('   → summary.amount=', res.summary.amount, res.summary.currency)

console.log('\nVérification :')
const after = await qbGet(`/deposit/${res.qb_deposit_id}`)
console.log(`  Deposit ${res.qb_deposit_id}  TotalAmt=${after.Deposit.TotalAmt}  Lines=${after.Deposit.Line?.length}`)
console.log(`  payout.amount attendu = ${payout.amount}  →  écart = ${(Number(after.Deposit.TotalAmt) - payout.amount).toFixed(2)}`)
const stillAdj = (after.Deposit.Line || []).find(l => /Ajustement d'arrondi taxes/i.test(l.Description || ''))
if (stillAdj) {
  const amt = Math.abs(Number(stillAdj.Amount) || 0)
  if (amt > 1) console.log(`  ⚠️ Ligne d'arrondi encore importante: "${stillAdj.Description}" (${stillAdj.Amount}) — vérifier`)
  else console.log(`  ✅ Ligne d'arrondi résiduelle ${stillAdj.Amount} (centimes — normal).`)
} else {
  console.log(`  ✅ Aucune ligne d'arrondi — la taxe de refund est désormais correcte.`)
}

db.close()
