// Helpers pour normaliser le montant d'un abonnement au cycle de facturation.
//
// Contexte : la sync Stripe (`server/src/services/stripe.js`) stocke
// `amount_monthly` toujours en équivalent mensuel (yearly / 12, weekly * 4.333),
// et `amount_cad` retourné par /api/projets/abonnements est aussi mensuel
// (juste converti en CAD si nécessaire). Pour afficher "X $ / an" sur un sub
// annuel, il faut donc multiplier par 12 — sinon on montre "5 $ / an" alors
// que le client paie 60 $ par an, ce qui est faux et trompeur.
//
// `interval_count` est ~toujours 1 en prod (cf. `SELECT interval_type,
// interval_count, COUNT(*) FROM subscriptions GROUP BY 1,2`), mais on le
// gère par sécurité au cas où Stripe enverrait du trimestriel/semestriel
// (sub `every 3 months`, etc.).

/**
 * Renvoie le montant facturé par cycle (le montant que le client voit sur sa
 * facture Stripe), à partir d'un objet sub qui contient `amount_monthly` ou
 * `amount_cad` (tous les deux normalisés en mensuel par la sync) plus
 * `interval_type` et `interval_count`.
 *
 * - sub mensuel (interval=month, count=1) → renvoie le montant tel quel
 * - sub annuel (interval=year, count=1)   → renvoie montant × 12
 * - sub trimestriel (month, count=3)      → renvoie montant × 3
 * - sub bisannuel (year, count=2)         → renvoie montant × 24
 *
 * Renvoie `null` si l'amount source est null/undefined (sync partielle).
 */
export function intervalAmount(sub) {
  if (!sub) return null
  const monthly = sub.amount_cad ?? sub.amount_monthly
  if (monthly == null) return null
  const type = sub.interval_type || 'month'
  const count = sub.interval_count || 1
  let monthsPerCycle = count
  if (type === 'year') monthsPerCycle = 12 * count
  else if (type === 'week') monthsPerCycle = count / 4.333
  // Pour 'month' (et fallback), monthsPerCycle = count
  return monthly * monthsPerCycle
}

/**
 * Renvoie le suffixe textuel du cycle de facturation : "mois", "an",
 * "3 mois", "2 ans", etc. À utiliser après un slash ("/" + intervalLabel).
 */
export function intervalLabel(sub) {
  if (!sub) return 'mois'
  const type = sub.interval_type || 'month'
  const count = sub.interval_count || 1
  if (count === 1) {
    if (type === 'year') return 'an'
    if (type === 'week') return 'sem'
    return 'mois'
  }
  // Multi-cycle : "3 mois", "2 ans", etc.
  if (type === 'year') return `${count} ans`
  if (type === 'week') return `${count} sem`
  return `${count} mois`
}
