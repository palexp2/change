// % d'un rabais sur l'Achat : le sien, sinon celui de l'abonnement
// (`only: 'monthly'` : aucun — ex. Head start plan). Même règle que le serveur
// (services/soumissionTotals.js).
export const purchasePct = d => d.pct_purchase ?? (d.only === 'monthly' ? 0 : d.pct || 0)

// Montant retiré par chaque rabais : les $ d'abord, puis les % sur ce qui
// reste. Même règle que le serveur (discountLines).
export function discountOffs(discounts, monthlyBase, purchaseBase) {
  const fixed = k => discounts.reduce((t, d) => t + (Number(d[k]) || 0), 0)
  const monthlyRest = Math.max(0, monthlyBase - fixed('monthly'))
  const purchaseRest = Math.max(0, purchaseBase - fixed('amount'))
  return discounts.map(d => ({
    ...d,
    offMonthly: monthlyRest * (d.pct || 0) / 100 + (Number(d.monthly) || 0),
    offAmount: purchaseRest * purchasePct(d) / 100 + (Number(d.amount) || 0),
  }))
}
