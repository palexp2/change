// Totaux d'une soumission (Achat = prix fixe, Service = mensuel), rabais
// déduits. Même règle partout : PDF, paiement Stripe, colonnes « Prix achat » /
// « Prix abo » des listes.

// Rabais nommés ; sans liste (soumissions d'avant), le rabais global unique.
export function soumissionDiscounts(s) {
  try {
    const list = s.discounts ? JSON.parse(s.discounts) : null
    if (Array.isArray(list)) return list
  } catch { /* JSON illisible : repli sur le rabais global */ }
  const pct = s.discount_pct || 0, amount = s.discount_amount || 0
  return pct || amount ? [{ name: 'Rabais', pct, monthly: 0, amount }] : []
}

// % du rabais sur l'Achat : le sien, sinon celui de l'abonnement
// (`only: 'monthly'` : aucun — ex. Head start plan).
export const purchasePct = d => d.pct_purchase ?? (d.only === 'monthly' ? 0 : d.pct || 0)

// Montant retiré par chaque rabais : les rabais en $ d'abord, puis les % sur
// ce qui reste (Pierre-Alexandre 2026-10-05). Même règle côté client
// (lib/soumissionDiscount.js).
export function discountLines(discounts, monthlyBase, purchaseBase) {
  const fixed = k => discounts.reduce((t, d) => t + (Number(d[k]) || 0), 0)
  const monthlyRest = Math.max(0, monthlyBase - fixed('monthly'))
  const purchaseRest = Math.max(0, purchaseBase - fixed('amount'))
  return discounts.map(d => ({
    ...d,
    monthly: monthlyRest * (d.pct || 0) / 100 + (Number(d.monthly) || 0),
    amount: purchaseRest * purchasePct(d) / 100 + (Number(d.amount) || 0),
  }))
}

export function totalsOf(items, discounts) {
  const monthly = items.reduce((t, it) => t + (it.qty || 1) * (it.unit_monthly_price || 0), 0)
  const amount = items.reduce((t, it) => t + (it.qty || 1) * (it.unit_price_cad || 0), 0)
  const lines = discountLines(discounts, monthly, amount).map(l => ({ name: l.name, until: l.until, monthly: l.monthly, amount: l.amount }))
  const sum = k => lines.reduce((t, l) => t + l[k], 0)
  return { lines, monthly: Math.max(0, monthly - sum('monthly')), amount: Math.max(0, amount - sum('amount')) }
}

const cents = n => Math.round(n * 100) / 100

// Recopie les totaux d'une soumission Boréal dans purchase_price /
// subscription_price (les soumissions Airtable reçoivent les leurs du miroir).
export function storeSoumissionTotals(db, id) {
  const s = db.prepare('SELECT * FROM soumissions WHERE id = ? AND airtable_id IS NULL').get(id)
  if (!s) return null
  const items = db.prepare(
    "SELECT qty, unit_price_cad, unit_monthly_price FROM document_items WHERE document_id = ? AND document_type = 'soumission'"
  ).all(id)
  const t = totalsOf(items, soumissionDiscounts(s))
  db.prepare('UPDATE soumissions SET purchase_price = ?, subscription_price = ? WHERE id = ?')
    .run(cents(t.amount), cents(t.monthly), id)
  return t
}
