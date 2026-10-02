// URL du tableau de bord Stripe d'une facture (ou d'un remboursement/paiement
// synchronisé comme facture). null si la facture ne vient pas de Stripe.
export function stripeFactureUrl(facture) {
  if (!facture) return null
  if (facture.lien_stripe) return facture.lien_stripe
  const id = String(facture.invoice_id || '')
  if (!id) return null
  if (id.startsWith('in_')) return `https://dashboard.stripe.com/invoices/${id}`
  if (id.startsWith('re_')) return `https://dashboard.stripe.com/refunds/${id}`
  if (id.startsWith('ch_') || id.startsWith('pi_') || id.startsWith('py_') || id.startsWith('pyr_')) {
    return `https://dashboard.stripe.com/payments/${id}`
  }
  return null
}
