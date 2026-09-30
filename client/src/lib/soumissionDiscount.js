// % d'un rabais sur l'Achat : le sien, sinon celui de l'abonnement
// (`only: 'monthly'` : aucun — ex. Head start plan). Même règle que le serveur
// (services/soumissionTotals.js).
export const purchasePct = d => d.pct_purchase ?? (d.only === 'monthly' ? 0 : d.pct || 0)
