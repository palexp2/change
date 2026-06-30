// One-off : corrige EN PLACE le Deposit QB 17328 (payout po_1TX9vF, mai 2026),
// rapproché en banque donc NON supprimable (cf. delete code 6480). On ne peut pas
// faire delete+re-push : on patche les lignes à TotalAmt constant pour préserver
// la réconciliation bancaire.
//
// Le refund #VKMQYH6B-0001 (8 $ partiel) avait hérité de 100 % de la taxe de la
// facture (-5,99) au lieu de sa part proratisée (-1,04). La ligne refund était donc
// en HT -2,01 (QB recalculait ~0,30 de taxe → -2,31) au lieu de -6,96 HT (→ -8,00).
// L'écart finissait dans la ligne « Ajustement d'arrondi taxes (-15,91) ».
//
// Fix : ligne refund -2,01 → -6,96 (HT, tax code 8 → QB recalcule ~1,04 de taxe),
// puis la ligne d'arrondi est rajustée pour que TotalAmt reste = payout (6306,40).
//
// Usage : cd server && node src/scripts/fix-deposit-17328-inplace.js [--apply]

import db from '../db/database.js'
import { qbGet, qbPost } from '../connectors/quickbooks.js'

const DEPOSIT_ID = '17328'
const PAYOUT_ID = 'po_1TX9vFEO122sMsbJXlpzXyXc'
const NEW_REFUND_HT = -6.96
const REFUND_RX = /Remboursement #VKMQYH6B/i
const ADJ_RX = /Ajustement d'arrondi taxes/i
const APPLY = process.argv.includes('--apply')

const payout = db.prepare('SELECT amount, currency, qb_deposit_id FROM stripe_payouts WHERE stripe_id=?').get(PAYOUT_ID)
if (!payout) throw new Error(`Payout introuvable: ${PAYOUT_ID}`)
if (payout.qb_deposit_id !== DEPOSIT_ID) throw new Error(`qb_deposit_id=${payout.qb_deposit_id} ≠ ${DEPOSIT_ID} — abort.`)
const EXPECTED_TOTAL = Math.round(payout.amount * 100) / 100

const sparse = (dep, lines) => ({
  Id: dep.Id, SyncToken: dep.SyncToken, sparse: true,
  DepositToAccountRef: dep.DepositToAccountRef, TxnDate: dep.TxnDate, CurrencyRef: dep.CurrencyRef,
  ...(dep.ExchangeRate ? { ExchangeRate: dep.ExchangeRate } : {}),
  ...(dep.GlobalTaxCalculation ? { GlobalTaxCalculation: dep.GlobalTaxCalculation } : {}),
  ...(dep.PrivateNote ? { PrivateNote: dep.PrivateNote } : {}),
  Line: lines,
})

let { Deposit: dep } = await qbGet(`/deposit/${DEPOSIT_ID}`)
console.log(`Deposit ${DEPOSIT_ID}: SyncToken=${dep.SyncToken} TotalAmt=${dep.TotalAmt} (attendu ${EXPECTED_TOTAL}) Lines=${dep.Line?.length}`)
const refIdx = dep.Line.findIndex(l => REFUND_RX.test(l.Description || ''))
const adjIdx = dep.Line.findIndex(l => ADJ_RX.test(l.Description || ''))
if (refIdx < 0) throw new Error('Ligne refund #VKMQYH6B introuvable — abort.')
if (adjIdx < 0) throw new Error('Ligne d\'arrondi introuvable — abort.')
console.log(`  ligne refund [#${refIdx}] = ${dep.Line[refIdx].Amount}  →  ${NEW_REFUND_HT}`)
console.log(`  ligne arrondi [#${adjIdx}] = ${dep.Line[adjIdx].Amount}  (sera rajustée pour TotalAmt constant)`)

if (!APPLY) {
  console.log('\nDRY-RUN. --apply pour exécuter (2 passes : corriger refund, puis rajuster arrondi).')
  process.exit(0)
}

console.log('\n--- APPLY ---')
// Passe 1 : corriger la ligne refund. QB recalcule TotalTax + TotalAmt.
const lines1 = dep.Line.map(l => ({ ...l }))
lines1[refIdx].Amount = NEW_REFUND_HT
console.log('Passe 1 : refund → ' + NEW_REFUND_HT + '…')
let updated = (await qbPost('/deposit', sparse(dep, lines1))).Deposit
console.log(`  → TotalAmt provisoire=${updated.TotalAmt}`)

// Passe 2 : rajuster la ligne d'arrondi pour ramener TotalAmt = EXPECTED_TOTAL.
let fresh = (await qbGet(`/deposit/${DEPOSIT_ID}`)).Deposit
const curTotal = Math.round(Number(fresh.TotalAmt) * 100) / 100
const delta = Math.round((EXPECTED_TOTAL - curTotal) * 100) / 100
const adjIdx2 = fresh.Line.findIndex(l => ADJ_RX.test(l.Description || ''))
const curAdj = Number(fresh.Line[adjIdx2].Amount) || 0
const newAdj = Math.round((curAdj + delta) * 100) / 100
console.log(`Passe 2 : TotalAmt=${curTotal}, delta vs attendu=${delta}, arrondi ${curAdj} → ${newAdj}…`)
const lines2 = fresh.Line.map(l => ({ ...l }))
lines2[adjIdx2].Amount = newAdj
lines2[adjIdx2].Description = `Ajustement d'arrondi taxes (${newAdj >= 0 ? '+' : ''}${newAdj.toFixed(2)})`
updated = (await qbPost('/deposit', sparse(fresh, lines2))).Deposit
console.log(`  → TotalAmt final=${updated.TotalAmt}`)

// Vérification finale
const after = (await qbGet(`/deposit/${DEPOSIT_ID}`)).Deposit
const refLine = after.Line.find(l => REFUND_RX.test(l.Description || ''))
const adjFinal = after.Line.find(l => ADJ_RX.test(l.Description || ''))
console.log('\nVérification :')
console.log(`  TotalAmt=${after.TotalAmt}  écart vs payout=${(Number(after.TotalAmt) - EXPECTED_TOTAL).toFixed(2)}`)
console.log(`  ligne refund=${refLine?.Amount} (attendu ${NEW_REFUND_HT})`)
console.log(`  ligne arrondi=${adjFinal?.Amount}`)
if (Math.abs(Number(after.TotalAmt) - EXPECTED_TOTAL) <= 0.01 && Math.abs(Number(refLine?.Amount) - NEW_REFUND_HT) <= 0.01) {
  console.log('  ✅ Deposit corrigé, total préservé, réconciliation intacte.')
} else {
  console.log('  ⚠️ État inattendu — vérifier dans QB.')
}
db.close()
