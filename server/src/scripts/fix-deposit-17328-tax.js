// Suite de fix-deposit-17328-inplace.js : QB a GELÉ le TxnTaxDetail lors du patch
// de ligne (TotalTax resté 843,16 alors que la ligne refund est passée à -6,96 HT).
// Le Deposit était donc incohérent. Ici on FORCE le TxnTaxDetail corrigé :
//   - refund (code 8) : base GST et QST réduites de 4,95 (= -6,96 vs -2,01 d'origine)
//   - rate 8 (GST 5%)   : 5261,99 → 5257,04  ⇒ 262,85
//   - rate 23 (QST 9,975%): 5193,99 → 5189,04 ⇒ 517,61
//   - TotalTax : 843,16 → 842,40 (refund reversal correct : -1,04 au lieu de -0,30)
//   - ligne d'arrondi rajustée pour TotalAmt = payout (6306,40) inchangé.
//
// Usage : cd server && node src/scripts/fix-deposit-17328-tax.js [--apply]

import db from '../db/database.js'
import { qbGet, qbPost } from '../connectors/quickbooks.js'

const DEPOSIT_ID = '17328'
const PAYOUT_ID = 'po_1TX9vFEO122sMsbJXlpzXyXc'
const ADJ_RX = /Ajustement d'arrondi taxes/i
const REFUND_DELTA = -4.95   // -6.96 (corrigé) − (-2.01) (origine)
const APPLY = process.argv.includes('--apply')

const payout = db.prepare('SELECT amount FROM stripe_payouts WHERE stripe_id=?').get(PAYOUT_ID)
const EXPECTED_TOTAL = Math.round(payout.amount * 100) / 100

const dep = (await qbGet(`/deposit/${DEPOSIT_ID}`)).Deposit
const r2 = (n) => Math.round(n * 100) / 100

// Corrige les TaxLine GST(rate 8) et QST(rate 23) : réduit la base de |REFUND_DELTA|.
const newTaxLine = dep.TxnTaxDetail.TaxLine.map(t => {
  const d = t.TaxLineDetail
  const rate = d.TaxRateRef.value
  if (rate === '8' || rate === '23') {
    const newBase = r2(d.NetAmountTaxable + REFUND_DELTA)
    const newAmt = r2(newBase * (d.TaxPercent / 100))
    return { Amount: newAmt, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: rate }, PercentBased: true, TaxPercent: d.TaxPercent, NetAmountTaxable: newBase } }
  }
  return { Amount: t.Amount, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: rate }, PercentBased: true, TaxPercent: d.TaxPercent, NetAmountTaxable: d.NetAmountTaxable } }
})
const newTotalTax = r2(newTaxLine.reduce((s, t) => s + t.Amount, 0))

// Rajuste la ligne d'arrondi : lineSubtotal doit = EXPECTED_TOTAL − newTotalTax.
const adjIdx = dep.Line.findIndex(l => ADJ_RX.test(l.Description || ''))
const sumNonAdj = dep.Line.reduce((s, l, i) => i === adjIdx ? s : s + (Number(l.Amount) || 0), 0)
const targetSubtotal = r2(EXPECTED_TOTAL - newTotalTax)
const newAdj = r2(targetSubtotal - sumNonAdj)

console.log(`Deposit ${DEPOSIT_ID}: TotalAmt=${dep.TotalAmt} TotalTax(gelé)=${dep.TxnTaxDetail.TotalTax}`)
console.log(`  → TotalTax corrigé = ${newTotalTax}`)
newTaxLine.forEach(t => console.log(`     rate ${t.TaxLineDetail.TaxRateRef.value} ${t.TaxLineDetail.TaxPercent}% : ${t.Amount} (base ${t.TaxLineDetail.NetAmountTaxable})`))
console.log(`  → ligne arrondi ${dep.Line[adjIdx].Amount} → ${newAdj} (pour TotalAmt=${EXPECTED_TOTAL})`)

if (!APPLY) { console.log('\nDRY-RUN. --apply pour exécuter.'); process.exit(0) }

const lines = dep.Line.map(l => ({ ...l }))
lines[adjIdx].Amount = newAdj
lines[adjIdx].Description = `Ajustement d'arrondi taxes (${newAdj >= 0 ? '+' : ''}${newAdj.toFixed(2)})`

const body = {
  Id: dep.Id, SyncToken: dep.SyncToken, sparse: true,
  DepositToAccountRef: dep.DepositToAccountRef, TxnDate: dep.TxnDate, CurrencyRef: dep.CurrencyRef,
  ...(dep.ExchangeRate ? { ExchangeRate: dep.ExchangeRate } : {}),
  GlobalTaxCalculation: 'TaxExcluded',
  ...(dep.PrivateNote ? { PrivateNote: dep.PrivateNote } : {}),
  Line: lines,
  TxnTaxDetail: { TotalTax: newTotalTax, TaxLine: newTaxLine },
}
const updated = (await qbPost('/deposit', body)).Deposit
console.log(`\nAprès update: TotalAmt=${updated.TotalAmt} TotalTax=${updated.TxnTaxDetail?.TotalTax}`)

const after = (await qbGet(`/deposit/${DEPOSIT_ID}`)).Deposit
const okTotal = Math.abs(Number(after.TotalAmt) - EXPECTED_TOTAL) <= 0.01
const okTax = Math.abs(Number(after.TxnTaxDetail?.TotalTax) - newTotalTax) <= 0.02
console.log(`Vérif: TotalAmt=${after.TotalAmt} (écart ${(Number(after.TotalAmt) - EXPECTED_TOTAL).toFixed(2)}) | TotalTax=${after.TxnTaxDetail?.TotalTax}`)
console.log(okTotal && okTax ? '  ✅ Total préservé + taxe corrigée + cohérence rétablie.' : '  ⚠️ État inattendu — vérifier dans QB.')
db.close()
