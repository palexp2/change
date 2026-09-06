/**
 * 007 — Régime de taxe explicite sur une facture en attente.
 *
 * Jusqu'ici les taxes étaient recalculées de la province de livraison à chaque
 * création de session Stripe. Le choix de l'utilisateur n'existait pas : pas
 * moyen d'exonérer un client autochtone livré sur réserve, ni de corriger une
 * province mal saisie sans toucher l'adresse.
 *
 * `tax_regime` NULL = comportement historique (déduction par province), donc
 * les factures existantes ne changent pas de montant.
 * `tax_exempt_reason` porte la justification obligatoire quand on facture un
 * client canadien sans taxe (statut autochtone, export, etc.).
 */

export const id = '007-pending-invoice-tax-regime'
export const description = 'Ajoute pending_invoices.tax_regime et tax_exempt_reason'

export function up(db) {
  const cols = db.prepare('PRAGMA table_info(pending_invoices)').all().map(c => c.name)
  if (!cols.includes('tax_regime')) db.exec('ALTER TABLE pending_invoices ADD COLUMN tax_regime TEXT')
  if (!cols.includes('tax_exempt_reason')) db.exec('ALTER TABLE pending_invoices ADD COLUMN tax_exempt_reason TEXT')
}
