// Remédiation du Deposit QB 17561 (payout po_1Tjq87EO122sMsbJA7yWrG0Z, 22 juin 2026).
//
// Cause d'origine : deux charges en TVH Ontario (« Sales tax 13% ON », txr_1QcAx2…)
// avaient leur taxe non ventilée en GST/QST → lignes HT = brut (taxe incluse) avec
// TaxCodeRef 20 → QB recalculait 13 % par-dessus → ligne « Ajustement d'arrondi taxes
// (-1505.88) ». Fix code : classifyTaxRate gère 13/15 %, filet défensif dans
// buildDepositFromPayout, garde-fou |delta|>5 $ dans pushDepositFromPayout. Les
// balance_transactions du payout ont été re-synchronisées (invoice_tax_gst corrigé).
//
// Contraintes QBO découvertes sur ce Deposit apparié en banque (delete → code 6480) :
//   • Impossible de supprimer le Deposit (apparié).
//   • Update de ligne par Id = fiable (édition en place).
//   • Toute ligne envoyée SANS Id est AJOUTÉE ; les lignes omises ne sont JAMAIS
//     supprimées (même en full update sparse:false) sur une opération appariée.
//   • Un update sparse ne recalcule pas la taxe ; un full update la recalcule sur
//     l'ensemble des lignes présentes.
// → Les essais delete+re-push puis remplacement ont laissé 56 lignes (38 doublons).
//
// Stratégie retenue (seule possible en place) : garder les 18 lignes propres (Id ≥ 45,
// Σ HT 12492,66) et NEUTRALISER les 38 doublons (Id < 45) à 0 $ / code exonéré. Sans
// TxnTaxDetail, QB recalcule la taxe sur les seules lignes ≠ 0 :
//   Σ HT 12492,66 + taxe 1722,84 = 14215,50 (= payout, match bancaire restauré).
//
// Les 38 lignes à 0 restent visibles dans QB (inertes). Pour un Deposit 100 % propre,
// dé-apparier la transaction bancaire dans QB puis delete + re-push (push recrée 18
// lignes correctes via le fix).
//
// Usage : cd server && node src/scripts/fix-deposit-17561-zeroout.js [--apply]

import db from '../db/database.js'
import { qbGet, qbPost } from '../connectors/quickbooks.js'

const DEPOSIT_ID = '17561'
const KEEP_MIN_ID = 45
const EXPECTED_TOTAL = 14215.50
const APPLY = process.argv.includes('--apply')

let { Deposit: dep } = await qbGet(`/deposit/${DEPOSIT_ID}`)
console.log(`Deposit ${DEPOSIT_ID} : SyncToken=${dep.SyncToken} TotalAmt=${dep.TotalAmt} TotalTax=${dep.TxnTaxDetail?.TotalTax} Lines=${dep.Line.length}`)

const keep = dep.Line.filter(l => Number(l.Id) >= KEEP_MIN_ID)
const zero = dep.Line.filter(l => Number(l.Id) < KEEP_MIN_ID)
const sumKeep = keep.reduce((s, l) => s + Number(l.Amount || 0), 0)
console.log(`  garder (Id ≥ ${KEEP_MIN_ID}) : ${keep.length} lignes, Σ HT ${sumKeep.toFixed(2)}`)
console.log(`  neutraliser (Id < ${KEEP_MIN_ID}) : ${zero.length} lignes → 0 $`)

if (keep.length !== 18 || Math.abs(sumKeep - 12492.66) > 0.01) {
  throw new Error(`Garde-fou : keep=${keep.length} (att 18) Σ=${sumKeep.toFixed(2)} (att 12492.66) — abort.`)
}

const feesAcct = (zero.find(l => l.DepositLineDetail?.AccountRef)?.DepositLineDetail?.AccountRef?.value)
  || keep.find(l => l.DepositLineDetail?.AccountRef)?.DepositLineDetail?.AccountRef?.value

// Lignes finales : 18 gardées telles quelles + 38 mises à 0 $ (code exonéré), toutes par Id.
const newLines = [
  ...keep.map(l => ({ ...l })),
  ...zero.map(l => ({
    Id: l.Id,
    Amount: 0,
    DetailType: 'DepositLineDetail',
    DepositLineDetail: { AccountRef: { value: feesAcct }, TaxCodeRef: { value: '3' }, TaxApplicableOn: 'Purchase' },
    Description: 'Ligne dupliquée annulée (0)',
  })),
]

if (!APPLY) {
  console.log(`\nDRY-RUN. --apply : full update, 18 lignes gardées + ${zero.length} à 0 $, QB recalcule la taxe.`)
  console.log(`Attendu : TotalAmt ${EXPECTED_TOTAL}, TotalTax ~1722,84.`)
  process.exit(0)
}

console.log('\n--- APPLY ---')
const body = {
  Id: dep.Id, SyncToken: dep.SyncToken, sparse: false,
  DepositToAccountRef: dep.DepositToAccountRef, TxnDate: dep.TxnDate, CurrencyRef: dep.CurrencyRef,
  ...(dep.ExchangeRate ? { ExchangeRate: dep.ExchangeRate } : {}),
  GlobalTaxCalculation: 'TaxExcluded',
  ...(dep.PrivateNote ? { PrivateNote: dep.PrivateNote } : {}),
  Line: newLines,
}
const updated = (await qbPost('/deposit', body)).Deposit
console.log(`  → TotalAmt=${updated.TotalAmt} TotalTax=${updated.TxnTaxDetail?.TotalTax} Lines=${updated.Line.length}`)

const after = (await qbGet(`/deposit/${DEPOSIT_ID}`)).Deposit
const nonZero = after.Line.filter(l => Number(l.Amount) !== 0)
const l3 = after.Line.find(l => /868A5792-0003/.test(l.Description || '') && Number(l.Amount) !== 0)
const l5 = after.Line.find(l => /868A5792-0005/.test(l.Description || '') && Number(l.Amount) !== 0)
console.log('\nVérification :')
console.log(`  TotalAmt=${after.TotalAmt} (att ${EXPECTED_TOTAL}, écart ${(Number(after.TotalAmt) - EXPECTED_TOTAL).toFixed(2)})`)
console.log(`  TotalTax=${after.TxnTaxDetail?.TotalTax} (att ~1722.84)`)
console.log(`  Lignes ≠ 0 : ${nonZero.length} (att 18) ; total lignes ${after.Line.length}`)
console.log(`  HT 0003=${l3?.Amount} (att 6111)  0005=${l5?.Amount} (att 4140)`)
const ok = nonZero.length === 18
  && Math.abs(Number(after.TotalAmt) - EXPECTED_TOTAL) <= 0.01
  && Math.abs(Number(after.TxnTaxDetail?.TotalTax) - 1722.84) <= 0.05
console.log(ok
  ? '  ✅ Numériquement correct : 18 lignes actives, taxe 1722,84, total 14215,50. (38 lignes à 0 résiduelles.)'
  : '  ⚠️ État inattendu — inspecter dans QB.')
db.close()
