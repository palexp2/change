// REFAIRE UNE DÉPENSE EN FACTURE DU MOIS DU SERVICE.
//
// Règle (Charles, 2026-10-03) : un service d'un mois, débité au début du mois
// suivant, est une facture à payer datée de la fin du mois du service, réglée
// au jour du débit. Les pièces publiées avant la règle (ou par une autre voie)
// sont des dépenses datées du jour : on les refait (Charles, 2026-10-06 :
// Google Workspace d'août et de septembre).
//
// 1. Supprimer la dépense QuickBooks. Appariée au flux bancaire, QuickBooks
//    refuse (6480) : le robot « Annuler » la correspondance, puis on réessaie.
// 2. Délier la pièce, puis la republier : pushSaleReceiptToQB fait seul la
//    facture datée de fin de période et son paiement au jour du débit.
// 3. La ligne de relevé oublie l'ancienne écriture ; la vérification QB la
//    reliera au paiement.

import db from '../db/database.js'
import { qbGet, qbPost } from '../connectors/quickbooks.js'
import { pushSaleReceiptToQB } from './quickbooks.js'
import { serviceAccrualDate } from './servicePeriod.js'
import { undoBankFeedMatch } from './qbBankFeedUndo.js'
import { refreshStatuses } from './bankReconciliation.js'
import { touchBankTxns } from './realtimeEmitters.js'

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
const isMatchedRefusal = (e) => e?.qbCode === '6480' || /6480/.test(String(e?.message))

async function deletePurchase(id) {
  const cur = (await qbGet(`/purchase/${id}`))?.Purchase
  if (!cur) return false
  await qbPost('/purchase?operation=delete', { Id: String(id), SyncToken: cur.SyncToken })
  return true
}

/** @returns {Promise<{ quickbooks_id: string, bill_date: string, payment_id: string|null, undone: boolean }>} */
export async function republishForServiceMonth(receiptId) {
  const rec = db.prepare('SELECT * FROM sale_receipts WHERE id=? AND deleted_at IS NULL').get(receiptId)
  if (!rec) throw new Error('Pièce introuvable')
  if (!rec.quickbooks_id || rec.quickbooks_type !== 'purchase') throw new Error('Seule une dépense publiée peut être refaite en facture')
  const bankLine = db.prepare(`
    SELECT id, account_id, txn_date, amount, description FROM bank_transactions
    WHERE matched_type='receipt' AND matched_id=? AND deleted_at IS NULL ORDER BY txn_date LIMIT 1
  `).get(String(receiptId))
  const billDate = serviceAccrualDate(rec.service_period, bankLine?.txn_date || rec.receipt_date)
  if (!billDate) throw new Error('Cette pièce ne couvre pas un mois antérieur au débit')

  let undone = false
  try {
    await deletePurchase(rec.quickbooks_id)
  } catch (e) {
    if (!isMatchedRefusal(e)) throw e
    if (!bankLine) throw new Error('Dépense appariée dans QuickBooks, et aucune ligne de relevé pour la retrouver')
    const u = await undoBankFeedMatch(bankLine.account_id, { date: bankLine.txn_date, amount: bankLine.amount, label: bankLine.description })
    if (!u.ok) throw new Error(`Correspondance QuickBooks non annulée : ${u.error}`)
    undone = true
    await deletePurchase(rec.quickbooks_id)
  }

  db.prepare(`
    UPDATE sale_receipts SET quickbooks_id=NULL, quickbooks_type=NULL, service_accrual_date=NULL,
      accrual_payment_qb_id=NULL, updated_at=${NOW} WHERE id=?
  `).run(receiptId)
  if (bankLine) {
    db.prepare(`
      UPDATE bank_transactions
      SET qb_txn_type=NULL, qb_txn_id=NULL, qb_match_method=NULL, qb_match_delta=NULL,
          qb_match_account=NULL, qb_match_rate=NULL, updated_at=${NOW}
      WHERE id=? AND qb_txn_id=?
    `).run(bankLine.id, String(rec.quickbooks_id))
  }

  const qbId = await pushSaleReceiptToQB(receiptId, {
    type: 'purchase',
    expenseAccountId: rec.expense_account_id || undefined,
    paymentAccountId: rec.payment_account_id || undefined,
    vendorId: rec.vendor_id || undefined,
    taxCodeId: rec.tax_code_id || undefined,
    transactionType: rec.transaction_type || undefined,
    anomalyOverride: 'Republication de la même pièce en facture du mois du service',
  })
  if (bankLine) {
    refreshStatuses(bankLine.account_id)
    touchBankTxns([bankLine.id])
  }
  const after = db.prepare('SELECT service_accrual_date, accrual_payment_qb_id FROM sale_receipts WHERE id=?').get(receiptId)
  return { quickbooks_id: qbId, bill_date: after?.service_accrual_date || billDate, payment_id: after?.accrual_payment_qb_id || null, undone }
}
