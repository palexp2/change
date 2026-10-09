import db from '../db/database.js'
import { emitEntity } from './realtimeEmitters.js'

const today = () => new Date().toISOString().slice(0, 10)

// Statut d'une facture ouverte (impayée) : « En retard » passé l'échéance, ou
// dès qu'un prélèvement Stripe a échoué (Stripe affiche « Retrying »).
export function openFactureStatus(dueDate, paymentFailed = false) {
  if (paymentFailed) return 'En retard'
  return (dueDate && String(dueDate).slice(0, 10) < today()) ? 'En retard' : 'À payer'
}

// « Retrying » côté Stripe : facture ouverte dont au moins une tentative de
// prélèvement a échoué.
export function isStripeInvoiceRetrying(inv) {
  return inv?.status === 'open' && Number(inv.attempt_count) > 0
}

// Une facture « À payer » ne bascule pas seule le jour où l'échéance passe :
// ce balayage (démarrage + chaque jour) la passe « En retard », et l'inverse
// si l'échéance a été repoussée (sauf prélèvement Stripe en échec).
export function refreshOverdueFactures() {
  const d = today()
  const rows = db.prepare(`
    UPDATE factures
    SET status = CASE WHEN status = 'À payer' THEN 'En retard' ELSE 'À payer' END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE (status = 'À payer' AND (COALESCE(stripe_payment_failed, 0) = 1
             OR (due_date IS NOT NULL AND due_date != '' AND substr(due_date, 1, 10) < ?)))
       OR (status = 'En retard' AND COALESCE(stripe_payment_failed, 0) = 0
             AND (due_date IS NULL OR due_date = '' OR substr(due_date, 1, 10) >= ?))
    RETURNING id, status, company_id
  `).all(d, d)
  for (const r of rows) emitEntity('facture', 'updated', r.id, r, null)
  return rows.length
}

// Relit les factures Stripe ouvertes et tient à jour le drapeau « Retrying »
// (un webhook manqué ne laisse pas une facture en échec affichée « À payer »),
// puis applique le balayage des retards.
export async function refreshStripeRetryingFactures() {
  try {
    const { getStripeKey } = await import('./stripe.js')
    const key = getStripeKey()
    if (key) {
      const { default: Stripe } = await import('stripe')
      const retrying = []
      for await (const inv of new Stripe(key).invoices.list({ status: 'open', limit: 100 })) {
        if (isStripeInvoiceRetrying(inv)) retrying.push(inv.id)
      }
      const ph = retrying.map(() => '?').join(',') || "''"
      db.prepare(`UPDATE factures SET stripe_payment_failed = CASE WHEN invoice_id IN (${ph}) THEN 1 ELSE 0 END
        WHERE invoice_id IS NOT NULL AND (COALESCE(stripe_payment_failed, 0) = 1 OR invoice_id IN (${ph}))`)
        .run(...retrying, ...retrying)
    }
  } catch (e) {
    console.error('factures Stripe « Retrying »:', e.message)
  }
  return refreshOverdueFactures()
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
    'SELECT id, total_amount, currency, status, paid_at, due_date, balance_due, stripe_payment_failed FROM factures WHERE id = ?'
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
      newStatus = openFactureStatus(f.due_date, !!f.stripe_payment_failed)
    }
  }

  if (Number(f.balance_due) === newBalance && f.status === newStatus) return

  db.prepare(`
    UPDATE factures
    SET balance_due = ?, status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(newBalance, newStatus, factureId)
}
