/**
 * Apparier ici, comptabiliser là-bas.
 *
 * Demande de Charles (2026-09-19) : un appariement fait dans Boréal doit se
 * retrouver dans QuickBooks. Jusqu'ici le geste ne faisait que poser un lien
 * en base — le document apparié restait non publié, et QuickBooks ne savait
 * rien de la ligne de relevé.
 *
 * Le lien reste la vérité côté ERP ; la publication est la conséquence. Un
 * échec QuickBooks n'annule donc jamais l'appariement : il se raconte, et le
 * geste reste rejouable (« Publier » sur la ligne, ou la fiche du document).
 */
import db from '../db/database.js'

/** Le document apparié et son état de publication, ou null si la ligne n'en a pas. */
export function matchedDocState(txn) {
  if (!txn?.matched_type || !txn?.matched_id) return null
  const id = String(txn.matched_id)
  if (txn.matched_type === 'achat') {
    const a = db.prepare('SELECT vendor, quickbooks_id FROM achats_fournisseurs WHERE id=?').get(id)
    if (!a) return null
    return { type: 'achat', id, label: a.vendor || 'Achat', booked: !!a.quickbooks_id }
  }
  if (txn.matched_type === 'receipt') {
    const r = db.prepare('SELECT company, status, quickbooks_id FROM sale_receipts WHERE id=? AND deleted_at IS NULL').get(id)
    if (!r) return null
    // Un reçu pas encore lu ne peut pas être publié : QuickBooks n'aurait ni
    // montant ni fournisseur. Il se publiera depuis sa fiche une fois extrait.
    return { type: 'receipt', id, label: r.company || 'Reçu', booked: !!r.quickbooks_id, blocked: r.status !== 'done' }
  }
  if (txn.matched_type === 'stripe_payout') {
    const p = db.prepare('SELECT stripe_id, qb_deposit_id FROM stripe_payouts WHERE id=?').get(id)
    if (!p) return null
    return { type: 'stripe_payout', id, key: p.stripe_id, label: 'Versement Stripe', booked: !!p.qb_deposit_id }
  }
  return null
}

/**
 * Publie le document apparié s'il ne l'est pas déjà.
 * Retourne { quickbooks_id, already, error, field } — jamais d'exception.
 */
export async function publishMatchedDoc(txn) {
  const doc = matchedDocState(txn)
  if (!doc) return { quickbooks_id: null, already: false, error: null, field: null }
  if (doc.booked) {
    // Reçu comptabilisé au mois du service : son paiement attendait le débit.
    if (doc.type === 'receipt') {
      try { await (await import('./quickbooks.js')).settleAccruedReceipt(doc.id) } catch (e) {
        return { quickbooks_id: null, already: true, error: `Paiement de la facture non publié : ${e.message}`, field: null }
      }
    }
    return { quickbooks_id: null, already: true, error: null, field: null }
  }
  if (doc.blocked) return { quickbooks_id: null, already: false, error: 'Document pas encore lu — publication impossible', field: null }
  try {
    const qb = await import('./quickbooks.js')
    let quickbooks_id = null
    if (doc.type === 'achat') {
      // Achat sans code ni taxe : le code à taux zéro du statut fiscal (celui que
      // le panneau du rapprochement affiche) est posé avant la publication.
      const a = db.prepare('SELECT vendor, currency, tax_code_id, tax_cad, total_cad FROM achats_fournisseurs WHERE id=?').get(doc.id)
      if (a && !a.tax_code_id && !(a.tax_cad > 0)) {
        const { zeroRateTaxCodeFor } = await import('./bankTaxCode.js')
        const z = await zeroRateTaxCodeFor({ vendor: a.vendor, currency: a.currency, amount: a.total_cad })
        if (z) db.prepare('UPDATE achats_fournisseurs SET tax_code_id=? WHERE id=?').run(z.id, doc.id)
      }
      quickbooks_id = await qb.pushAchatToQB(doc.id)
    }
    else if (doc.type === 'receipt') quickbooks_id = await qb.pushSaleReceiptToQB(doc.id)
    else if (doc.type === 'stripe_payout') quickbooks_id = await qb.pushDepositFromPayout(doc.key)
    return { quickbooks_id, already: false, error: null, field: null }
  } catch (e) {
    return { quickbooks_id: null, already: false, error: e.message, field: e.field || null }
  }
}
