import db from '../db/database.js'

// Recalcule factures.balance_due / status à partir des lignes payments locales.
//
// Cas d'usage canonique : facture Stripe "open" payée hors Stripe (Interac,
// chèque, virement…). Stripe ne sait rien de ce paiement, donc son
// `amount_remaining` reste au montant total et le webhook upsert écrasait
// balance_due à cette valeur — résultat : un "solde dû" affiché alors que la
// facture est en réalité acquittée.
//
// Règle : si `paid_at` est posé (encaissement Stripe confirmé via webhook),
// Stripe est autoritaire et on ne touche à rien. Sinon, balance_due = max(0,
// total_amount - sum(payments.amount where direction='in' AND currency match)).
// Les refunds (direction='out') ne réaugmentent pas balance_due : un refund est
// un flux séparé, le client ne "redoit" pas le montant remboursé.
//
// Idempotent — n'UPDATE que si balance_due ou status changent réellement.
export function recomputeFactureBalance(factureId) {
  const f = db.prepare(
    'SELECT id, total_amount, currency, status, paid_at, due_date, balance_due FROM factures WHERE id = ?'
  ).get(factureId)
  if (!f) return

  if (f.paid_at) return

  const cur = (f.currency || 'CAD').toUpperCase()
  const paidIn = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM payments
    WHERE facture_id = ? AND direction = 'in' AND UPPER(COALESCE(currency,'CAD')) = ?
  `).get(factureId, cur).total

  const total = Number(f.total_amount) || 0
  const newBalance = Math.max(0, total - Number(paidIn || 0))

  // On ne réécrit que les statuts "ouverts" gérés localement. Void / Draft /
  // Uncollectible viennent de Stripe et restent intouchés.
  const OVERRIDABLE = new Set(['À payer', 'En retard', 'Payé', 'Payée'])
  let newStatus = f.status
  if (OVERRIDABLE.has(f.status)) {
    if (newBalance <= 0 && total > 0) {
      newStatus = 'Payé'
    } else {
      const today = new Date().toISOString().slice(0, 10)
      newStatus = (f.due_date && f.due_date < today) ? 'En retard' : 'À payer'
    }
  }

  if (Number(f.balance_due) === newBalance && f.status === newStatus) return

  db.prepare(`
    UPDATE factures
    SET balance_due = ?, status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(newBalance, newStatus, factureId)
}
