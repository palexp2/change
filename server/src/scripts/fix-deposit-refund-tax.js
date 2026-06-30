// Générique : corrige un Deposit QB dont la ligne « Ajustement d'arrondi taxes »
// plug en réalité de la taxe de remboursement manquante (bug refund partiel qui
// héritait de 100 % de la taxe de la facture d'origine, corrigé dans
// stripe.js::proRateRefundTax). Détection : voir le scan
//   SELECT … WHERE type IN ('refund') AND |tax|/|amount| > 0.16
//
// Procédure (identique à fix-deposit-17431.js, généralisée par payout) :
//   1) resync les balance_transactions du payout → taxe refund proratisée
//   2) DELETE le Deposit existant dans QB
//   3) clear qb_deposit_id sur le payout
//   4) pushDepositFromPayout → recrée le Deposit avec la taxe correcte
//
// Garde-fou : refuse de toucher un Deposit dont la ligne d'arrondi est ≤ 1 $
// (rien à corriger) sauf si --force.
//
// Usage :
//   cd server && node src/scripts/fix-deposit-refund-tax.js --payout=po_xxx [--apply] [--force]

import db from '../db/database.js'
import { qbGet, qbPost } from '../connectors/quickbooks.js'
import { pushDepositFromPayout } from '../services/quickbooks.js'
import { syncStripeBalanceTransactions } from '../services/stripe.js'

const arg = (name) => {
  const m = process.argv.find(a => a.startsWith(`--${name}=`))
  return m ? m.split('=')[1] : null
}
const PAYOUT_ID = arg('payout')
const APPLY = process.argv.includes('--apply')
const FORCE = process.argv.includes('--force')
if (!PAYOUT_ID) throw new Error('Usage: --payout=po_xxx [--apply] [--force]')

const payout = db.prepare('SELECT * FROM stripe_payouts WHERE stripe_id=?').get(PAYOUT_ID)
if (!payout) throw new Error(`Payout introuvable: ${PAYOUT_ID}`)
if (!payout.qb_deposit_id) throw new Error(`Payout ${PAYOUT_ID} non poussé en QB (qb_deposit_id NULL).`)
console.log(`Payout: ${PAYOUT_ID}  amount=${payout.amount} ${payout.currency}  qb_deposit_id=${payout.qb_deposit_id}`)

const verify = await qbGet(`/deposit/${payout.qb_deposit_id}`)
const dep = verify.Deposit
console.log(`Deposit QB actuel: Id=${dep.Id} SyncToken=${dep.SyncToken} TotalAmt=${dep.TotalAmt} Lines=${dep.Line?.length}`)
const adjLine = (dep.Line || []).find(l => /Ajustement d'arrondi taxes/i.test(l.Description || ''))
const adjAmt = adjLine ? Math.abs(Number(adjLine.Amount) || 0) : 0
if (adjLine) console.log(`  → Ligne d'arrondi présente: "${adjLine.Description}" (${adjLine.Amount})`)
else console.log(`  → Aucune ligne d'arrondi visible.`)

if (adjAmt <= 1 && !FORCE) {
  throw new Error(`Ligne d'arrondi ${adjAmt} ≤ 1 $ — rien à corriger (utiliser --force pour passer outre).`)
}

const refBefore = db.prepare(
  "SELECT amount, invoice_tax_gst, invoice_tax_qst, invoice_number FROM stripe_balance_transactions WHERE payout_stripe_id=? AND type IN ('refund','payment_refund')"
).all(PAYOUT_ID)
for (const r of refBefore) {
  console.log(`  refund BT avant resync: ${r.invoice_number || ''} amount=${r.amount} gst=${r.invoice_tax_gst} qst=${r.invoice_tax_qst} (somme=${((r.invoice_tax_gst || 0) + (r.invoice_tax_qst || 0)).toFixed(2)})`)
}

if (!APPLY) {
  console.log('\nDRY-RUN. Relancer avec --apply pour exécuter (resync → delete → re-push).')
  process.exit(0)
}

console.log('\n--- APPLY ---')
console.log('1) Resync balance_transactions…')
console.log('   →', JSON.stringify(await syncStripeBalanceTransactions(PAYOUT_ID)))
const refAfter = db.prepare(
  "SELECT amount, invoice_tax_gst, invoice_tax_qst, invoice_number FROM stripe_balance_transactions WHERE payout_stripe_id=? AND type IN ('refund','payment_refund')"
).all(PAYOUT_ID)
for (const r of refAfter) {
  console.log(`   refund BT après resync: ${r.invoice_number || ''} amount=${r.amount} gst=${r.invoice_tax_gst} qst=${r.invoice_tax_qst} (somme=${((r.invoice_tax_gst || 0) + (r.invoice_tax_qst || 0)).toFixed(2)})`)
}

console.log('2) DELETE Deposit dans QB…')
console.log('   →', JSON.stringify(await qbPost(`/deposit?operation=delete`, { Id: dep.Id, SyncToken: dep.SyncToken })).slice(0, 200))

console.log('3) Clear qb_deposit_id…')
db.prepare('UPDATE stripe_payouts SET qb_deposit_id=NULL, qb_pushed_at=NULL WHERE stripe_id=?').run(PAYOUT_ID)

console.log('4) pushDepositFromPayout…')
const res = await pushDepositFromPayout(PAYOUT_ID)
console.log('   → qb_deposit_id =', res.qb_deposit_id)
if (res.warnings?.length) console.log('   → warnings:', res.warnings)

const after = await qbGet(`/deposit/${res.qb_deposit_id}`)
console.log(`\nVérif: Deposit ${res.qb_deposit_id}  TotalAmt=${after.Deposit.TotalAmt}  écart vs payout=${(Number(after.Deposit.TotalAmt) - payout.amount).toFixed(2)}`)
const stillAdj = (after.Deposit.Line || []).find(l => /Ajustement d'arrondi taxes/i.test(l.Description || ''))
if (stillAdj && Math.abs(Number(stillAdj.Amount) || 0) > 1) console.log(`  ⚠️ Arrondi encore important: ${stillAdj.Amount}`)
else console.log(`  ✅ Arrondi résiduel ${stillAdj ? stillAdj.Amount : 0} (centimes / nul).`)

db.close()
