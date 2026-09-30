/**
 * 100 — Rabais sur une facture en attente (modale « Nouvelle facture Stripe »).
 *
 * `discount_json` = { kind: 'percent' | 'amount', value, name } ou NULL.
 * Appliqué à la session Checkout par un coupon Stripe (taxes calculées après
 * rabais) ; les totaux ERP d'une facture en attente sont nets du rabais.
 */

export const id = '100-pending-invoice-discount'
export const description = 'Ajoute pending_invoices.discount_json'

export function up(db) {
  const cols = db.prepare('PRAGMA table_info(pending_invoices)').all().map(c => c.name)
  if (!cols.includes('discount_json')) db.exec('ALTER TABLE pending_invoices ADD COLUMN discount_json TEXT')
}
