// Convertit la JE 17744 (versement BDC du 2026-07-23) en Dépense QB :
// 1) DELETE JournalEntry 17744 dans QB
// 2) publishDebtPaymentExpense — recrée la transaction en Purchase (cédule jointe)
// 3) UPDATE lt_debt_payments (qb_txn_id + qb_txn_type='purchase')
// Usage : node src/scripts/convert-lt-debt-je-17744-to-expense.js [--apply]
import db from '../db/database.js'
import { qbGet, qbPost } from '../connectors/quickbooks.js'
import { publishDebtPaymentExpense } from '../services/ltDebtQb.js'

const PAYMENT_ID = 'fa8f9013-32c6-442f-ad43-a0b64b1d53cf'
const JE_ID = '17744'
const APPLY = process.argv.includes('--apply')

const payment = db.prepare('SELECT * FROM lt_debt_payments WHERE id = ? AND deleted_at IS NULL').get(PAYMENT_ID)
if (!payment) throw new Error(`Versement introuvable: ${PAYMENT_ID}`)
if (payment.qb_txn_id !== JE_ID || payment.qb_txn_type === 'purchase') {
  throw new Error(`Inattendu: qb_txn_id=${payment.qb_txn_id} type=${payment.qb_txn_type} (attendu JE ${JE_ID}) — abort par sécurité.`)
}
const debt = db.prepare('SELECT * FROM lt_debts WHERE id = ?').get(payment.debt_id)
console.log(`Versement ${payment.payment_date} — capital ${payment.principal} + intérêts ${payment.interest} (${debt.label})`)

const je = (await qbGet(`/journalentry/${JE_ID}`)).JournalEntry
console.log(`JE QB actuelle: Id=${je.Id} SyncToken=${je.SyncToken} TxnDate=${je.TxnDate} Lines=${je.Line?.length}`)

if (!APPLY) {
  console.log('\nDRY-RUN. Relancer avec --apply pour exécuter :')
  console.log(`  1) DELETE JournalEntry ${JE_ID} dans QB`)
  console.log('  2) publishDebtPaymentExpense — création de la Dépense (cédule jointe)')
  console.log('  3) UPDATE lt_debt_payments (qb_txn_id, qb_txn_type=purchase)')
  process.exit(0)
}

console.log(`\n1) Suppression JE ${JE_ID}…`)
await qbPost('/journalentry?operation=delete', { Id: je.Id, SyncToken: je.SyncToken })
db.prepare(`UPDATE lt_debt_payments SET qb_txn_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(PAYMENT_ID)

console.log('2) Création de la Dépense…')
const { purchaseId, attachmentWarning } = await publishDebtPaymentExpense(debt, payment)
db.prepare(`UPDATE lt_debt_payments SET qb_txn_id = ?, qb_txn_type = 'purchase', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
  .run(purchaseId, PAYMENT_ID)
console.log(`✓ Dépense QB #${purchaseId} créée et liée au versement.`)
if (attachmentWarning) console.log(`⚠ ${attachmentWarning}`)
