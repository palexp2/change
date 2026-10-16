/**
 * 137 — Factures Stripe payées hors Stripe : solde dû remis à 0.
 *
 * Audit comptable du 2026-10-15 : une facture payée par virement ou Interac,
 * puis marquée payée dans Stripe, gardait tout son montant en « solde dû » et
 * 0 $ en montant encaissé (9 factures). Stripe les donne bien soldées ; le
 * code est corrigé (resolveStripeInvoiceFields, webhook), ceci répare l'existant.
 */
import db from '../database.js'

export const id = '137-factures-paid-stripe-zero-balance'
export const description = 'Factures Stripe payées : solde dû à 0 et montant encaissé = total'

export function up(migrationDb) {
  const d = migrationDb || db
  d.prepare(`
    UPDATE factures
    SET balance_due = 0,
        paid_amount = CASE WHEN COALESCE(paid_amount, 0) = 0 THEN total_amount ELSE paid_amount END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE sync_source = 'Factures Stripe' AND status = 'Payé' AND paid_at IS NOT NULL
      AND invoice_id LIKE 'in\\_%' ESCAPE '\\'
      AND total_amount > 0 AND balance_due > 0.009
  `).run()
}
