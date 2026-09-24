// La date d'une facture, c'est celle de son passage à la banque.
//
// Règle posée par Charles (2026-09-15, re-confirmée le 2026-09-19 sur la facture
// Bell Mobilité du 13 septembre débitée le 17) : quand une ligne de relevé est
// appariée à un document, la date qui compte est celle où l'argent est sorti du
// compte, pas celle imprimée sur la facture. La publication dans QuickBooks
// appliquait déjà la règle ; le document, lui, continuait d'afficher la sienne.
//
// La date imprimée n'est pas perdue : elle passe dans `document_date`.
import db from '../db/database.js'

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

/** Date du passage au compte pour ce reçu, s'il est apparié à une ligne. */
export function bankDateForReceipt(receiptId) {
  return db.prepare(`
    SELECT txn_date FROM bank_transactions
    WHERE matched_type='receipt' AND matched_id=? AND deleted_at IS NULL
    ORDER BY txn_date LIMIT 1
  `).get(String(receiptId))?.txn_date || null
}

/**
 * Aligne la date d'un reçu sur celle de son débit. Sans ligne appariée, rien ne
 * bouge — la date du document reste la seule information disponible.
 * @returns {boolean} vrai si la date a changé
 */
export function alignReceiptDate(receiptId) {
  const rec = db.prepare('SELECT id, receipt_date, document_date FROM sale_receipts WHERE id=? AND deleted_at IS NULL').get(String(receiptId))
  if (!rec) return false
  const bankDate = bankDateForReceipt(rec.id)
  if (!bankDate || bankDate === rec.receipt_date) return false
  db.prepare(`
    UPDATE sale_receipts
    SET document_date=COALESCE(document_date, receipt_date), receipt_date=?, updated_at=${NOW}
    WHERE id=?
  `).run(bankDate, rec.id)
  return true
}

/** Tous les reçus appariés aux lignes d'un compte (appelé après chaque passage). */
export function alignReceiptDatesForAccount(accountId) {
  const ids = db.prepare(`
    SELECT DISTINCT t.matched_id AS id
    FROM bank_transactions t JOIN sale_receipts r ON r.id = t.matched_id
    WHERE t.account_id=? AND t.matched_type='receipt' AND t.deleted_at IS NULL
      AND r.deleted_at IS NULL AND (r.receipt_date IS NULL OR r.receipt_date != t.txn_date)
  `).all(accountId).map((r) => r.id)
  let changed = 0
  for (const id of ids) if (alignReceiptDate(id)) changed += 1
  return changed
}
