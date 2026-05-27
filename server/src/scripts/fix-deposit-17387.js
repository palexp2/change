// One-off : corrige Deposit QB 17387 (payout po_1Tb8r3EO122sMsbJb2oDwaJt, mai 2026)
// dont la ligne « Ajustement d'arrondi taxes (-15.00) » plug en réalité un dispute fee
// Stripe non bucketé. Le fix dans buildDepositFromPayout est en place — il suffit de
// supprimer le Deposit existant et de relancer le push.
//
// Usage :
//   cd server && node src/scripts/fix-deposit-17387.js [--apply]
// Par défaut dry-run (affiche le plan). Avec --apply : exécute.

import db from '../db/database.js'
import { qbGet, qbPost } from '../connectors/quickbooks.js'
import { pushDepositFromPayout } from '../services/quickbooks.js'

const PAYOUT_ID = 'po_1Tb8r3EO122sMsbJb2oDwaJt'
const EXPECTED_DEPOSIT_ID = '17387'
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
if (adjLine) console.log(`  → Ligne d'arrondi présente: ${adjLine.Description} (${adjLine.Amount})`)
else console.log(`  → Aucune ligne d'arrondi visible (le fix s'applique quand même — re-push propre).`)

if (!APPLY) {
  console.log('\nDRY-RUN. Relancer avec --apply pour exécuter :')
  console.log('  1) DELETE Deposit 17387 dans QB')
  console.log('  2) UPDATE stripe_payouts SET qb_deposit_id=NULL WHERE stripe_id=?')
  console.log('  3) pushDepositFromPayout(payout) — recrée Deposit avec dispute fee correctement bucketé')
  process.exit(0)
}

console.log('\n--- APPLY ---')

console.log('1) DELETE Deposit dans QB…')
const delResult = await qbPost(`/deposit?operation=delete`, { Id: dep.Id, SyncToken: dep.SyncToken })
console.log('   →', JSON.stringify(delResult).slice(0, 200))

console.log('2) Clear qb_deposit_id sur le payout…')
db.prepare('UPDATE stripe_payouts SET qb_deposit_id=NULL, qb_pushed_at=NULL WHERE stripe_id=?').run(PAYOUT_ID)
console.log('   → done')

console.log('3) pushDepositFromPayout…')
const res = await pushDepositFromPayout(PAYOUT_ID)
console.log('   → qb_deposit_id =', res.qb_deposit_id)
if (res.warnings?.length) console.log('   → warnings:', res.warnings)
console.log('   → summary.amount=', res.summary.amount, res.summary.currency)

console.log('\nVérification :')
const after = await qbGet(`/deposit/${res.qb_deposit_id}`)
console.log(`  Deposit ${res.qb_deposit_id}  TotalAmt=${after.Deposit.TotalAmt}  Lines=${after.Deposit.Line?.length}`)
const stillAdj = (after.Deposit.Line || []).find(l => /Ajustement d'arrondi taxes/i.test(l.Description || ''))
if (stillAdj) console.log(`  ⚠️ Ligne d'arrondi présente après fix: ${stillAdj.Description} (${stillAdj.Amount})`)
else console.log(`  ✅ Aucune ligne d'arrondi — le delta est résorbé par le bucket dispute fee.`)

db.close()
