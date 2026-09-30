import db from '../db/database.js'

// Projet d'un paiement Stripe lancé depuis le PDF d'une soumission : les
// boutons « S'abonner » / « Acheter » posent erp_project_id (et
// erp_soumission_id) dans les métadonnées de la session, de l'abonnement et
// de la facture. Demande de Pierre-Alexandre Papillon (2026-09-30).

// Métadonnées d'une facture Stripe : les siennes (paiement unique), puis
// celles de l'abonnement recopiées par Stripe (API ≥ 2024-09 sous parent,
// avant sous subscription_details).
export function invoiceMetadatas(invoice) {
  return [invoice?.metadata, invoice?.parent?.subscription_details?.metadata, invoice?.subscription_details?.metadata]
}

/** Premier projet existant nommé par ces métadonnées, sinon celui de la soumission. */
export function projectIdFromStripeMetadata(...metas) {
  for (const m of metas) {
    const pid = m?.erp_project_id
    if (pid && db.prepare('SELECT 1 FROM projects WHERE id=?').get(pid)) return pid
  }
  for (const m of metas) {
    const sid = m?.erp_soumission_id
    const pid = sid ? db.prepare('SELECT project_id FROM soumissions WHERE id=?').get(sid)?.project_id : null
    if (pid) return pid
  }
  return null
}

/** Rattache la facture ERP au projet de sa soumission — jamais d'écrasement d'un lien posé. */
export function linkFactureToProject(factureId, invoice) {
  const pid = projectIdFromStripeMetadata(...invoiceMetadatas(invoice))
  if (!pid || !factureId) return null
  const { changes } = db.prepare(`
    UPDATE factures SET project_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=? AND (project_id IS NULL OR project_id='')
  `).run(pid, factureId)
  return changes ? pid : null
}
