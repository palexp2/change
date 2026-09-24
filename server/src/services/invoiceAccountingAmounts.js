// Stripe exprime ses montants en cents. Le subtotal est AVANT rabais et
// peut inclure des taxes : total_excluding_tax est la base comptable nette.
export function invoiceNetHtCents(invoice) {
  if (!invoice) return null
  if (invoice.total_excluding_tax != null) return Number(invoice.total_excluding_tax)
  const taxes = Array.isArray(invoice.total_taxes) ? invoice.total_taxes
    : Array.isArray(invoice.total_tax_amounts) ? invoice.total_tax_amounts : null
  if (invoice.total != null && taxes !== null) {
    return Number(invoice.total) - taxes.reduce((sum, tax) => sum + Number(tax.amount || 0), 0)
  }
  const subtotal = invoice.subtotal_excluding_tax ?? invoice.subtotal
  if (subtotal == null) return null
  return Number(subtotal) - (invoice.total_discount_amounts || []).reduce((sum, discount) => sum + Number(discount.amount || 0), 0)
}

export function recognitionNetAmount(facture, invoice = null) {
  const cents = invoiceNetHtCents(invoice)
  const net = cents == null ? Number(facture.amount_before_tax_cad) : cents / 100
  if (!Number.isFinite(net) || net <= 0) throw new Error('Montant HT net de rabais inconnu ou nul sur la facture')
  if (!facture.deferred_revenue_at) return Math.round(net * 100) / 100
  const deferred = Number(facture.deferred_revenue_amount_native)
  if (!Number.isFinite(deferred) || deferred <= 0) throw new Error('Montant déféré inconnu — vérifier le dépôt lié')
  if ((facture.deferred_revenue_currency || 'CAD') !== (facture.currency || 'CAD')) {
    throw new Error('La devise du montant déféré ne correspond pas à la facture')
  }
  // Préserve les encaissements partiels, mais ne reprend jamais un ancien
  // montant brut supérieur au revenu net de la facture.
  return Math.round(Math.min(deferred, net) * 100) / 100
}
