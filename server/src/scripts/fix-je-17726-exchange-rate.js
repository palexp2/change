// Correctif ponctuel — JE de constatation 17726 (facture 493D7047-0022).
//
// La JE a été posée au taux du jour de l'expédition (2026-07-21 → 1,4014) alors
// que le passif 23900 avait été crédité au taux du jour de l'encaissement
// (Deposit 17698, 2026-07-13 → 1,4145). Résultat : 30 286 USD × 0,0131 =
// 396,80 $ CAD orphelins dans 23900, jamais soldés.
//
// Ce script réaligne l'ExchangeRate de la JE sur celui du Deposit. Les montants
// USD (30 286 au débit et au crédit) sont inchangés : seule la conversion CAD
// bouge, ce qui solde 23900 à zéro et porte la vente à 42 839,55 $ CAD — le
// montant réellement encaissé.
//
// La cause racine est corrigée dans postRevenueRecognitionJE
// (resolveEncaissementExchangeRate) — ce script ne sert qu'au rattrapage.
//
// Usage : node src/scripts/fix-je-17726-exchange-rate.js [--dry-run]

import { qbGet, qbPost } from '../connectors/quickbooks.js'

const JE_ID = '17726'
const DEPOSIT_ID = '17698'
const DRY = process.argv.includes('--dry-run')

const dep = (await qbGet(`/deposit/${DEPOSIT_ID}`)).Deposit
const targetRate = Number(dep.ExchangeRate)
if (!(targetRate > 0)) throw new Error(`ExchangeRate illisible sur le Deposit ${DEPOSIT_ID}`)

const je = (await qbGet(`/journalentry/${JE_ID}`)).JournalEntry
const currentRate = Number(je.ExchangeRate)
console.log(`Deposit ${DEPOSIT_ID} (${dep.TxnDate}) : taux ${targetRate}`)
console.log(`JE ${JE_ID} (${je.TxnDate}) : taux ${currentRate} → ${targetRate}`)
const usd = Number(je.Line?.[0]?.Amount || 0)
console.log(`Impact : ${usd} USD → CAD ${(usd * currentRate).toFixed(2)} devient ${(usd * targetRate).toFixed(2)} ` +
            `(delta ${(usd * (targetRate - currentRate)).toFixed(2)} $)`)

if (Math.abs(currentRate - targetRate) < 1e-6) {
  console.log('Taux déjà aligné — rien à faire.')
  process.exit(0)
}
if (DRY) {
  console.log('--dry-run : aucune écriture QB.')
  process.exit(0)
}

// Full update : QB exige l'objet complet (Id + SyncToken + Line). On renvoie les
// lignes telles quelles — seul ExchangeRate change, les montants USD sont intacts.
const body = {
  Id: je.Id,
  SyncToken: je.SyncToken,
  TxnDate: je.TxnDate,
  CurrencyRef: je.CurrencyRef,
  ExchangeRate: targetRate,
  ...(je.DocNumber ? { DocNumber: je.DocNumber } : {}),
  ...(je.PrivateNote ? { PrivateNote: `${je.PrivateNote} — taux réaligné sur l'encaissement (Deposit ${DEPOSIT_ID})` } : {}),
  ...(je.Adjustment != null ? { Adjustment: je.Adjustment } : {}),
  Line: je.Line,
}
const res = await qbPost('/journalentry', body)
const updated = res.JournalEntry
console.log(`✅ JE ${updated.Id} mise à jour — taux ${updated.ExchangeRate}, HomeTotalAmt ${updated.HomeTotalAmt}`)
