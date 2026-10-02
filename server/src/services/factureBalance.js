import db from '../db/database.js'
import { emitEntity } from './realtimeEmitters.js'

const today = () => new Date().toISOString().slice(0, 10)

// Statut d'une facture ouverte (impayée) : « En retard » passé l'échéance.
export function openFactureStatus(dueDate) {
  return (dueDate && String(dueDate).slice(0, 10) < today()) ? 'En retard' : 'À payer'
}

// Une facture « À payer » ne bascule pas seule le jour où l'échéance passe :
// ce balayage (démarrage + chaque jour) la passe « En retard », et l'inverse
// si l'échéance a été repoussée.
export function refreshOverdueFactures() {
  const d = today()
  const rows = db.prepare(`
    UPDATE factures
    SET status = CASE WHEN status = 'À payer' THEN 'En retard' ELSE 'À payer' END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE (status = 'À payer' AND due_date IS NOT NULL AND due_date != '' AND substr(due_date, 1, 10) < ?)
       OR (status = 'En retard' AND (due_date IS NULL OR due_date = '' OR substr(due_date, 1, 10) >= ?))
    RETURNING id, status, company_id
  `).all(d, d)
  for (const r of rows) emitEntity('facture', 'updated', r.id, r, null)
  return rows.length
}

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
      newStatus = openFactureStatus(f.due_date)
    }
  }

  if (Number(f.balance_due) === newBalance && f.status === newStatus) return

  db.prepare(`
    UPDATE factures
    SET balance_due = ?, status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(newBalance, newStatus, factureId)
}
