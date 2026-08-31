// Sélection du transporteur pour une étiquette de retour. Fonction pure —
// aucun accès réseau/DB — pour être testable isolément (cf. returnCarrier.test.js).
//
// Règle : on préfère un transporteur par défaut selon le pays du client
// (Purolator si Canada, UPS si US), sauf si le tarif le moins cher de la
// liste bat ce préféré de plus que `threshold` (économie réelle) — auquel cas
// on bascule. Le choix ET sa raison sont toujours retournés : un changement
// de transporteur silencieux est le genre d'effet de bord que l'ERP doit
// rendre visible (cf. CLAUDE.md — visibilité des side effects).

function carrierNameOf(rate) {
  return String(rate.carrier_name || rate.carrier || '').toLowerCase()
}

function priceOf(rate) {
  return parseFloat(rate.total?.value ?? rate.total_charge ?? rate.total ?? 0) || 0
}

export function selectReturnRate(rates, senderCountry, { threshold = 0, preferCA = 'purolator', preferUS = 'ups' } = {}) {
  if (!rates?.length) return null

  // `rates` est déjà trié ascendant par prix (novoxpress.js getRates/getReturnRates).
  const cheapest = rates[0]
  const preferredName = (senderCountry === 'CA' ? preferCA : preferUS).toLowerCase()
  const preferred = rates.find(r => carrierNameOf(r).includes(preferredName))

  if (!preferred) {
    return { rate: cheapest, reason: 'fallback_cheapest' }
  }

  const savings = priceOf(preferred) - priceOf(cheapest)
  if (cheapest !== preferred && savings > (Number(threshold) || 0)) {
    return { rate: cheapest, reason: `cheaper_by_${savings.toFixed(2)}` }
  }

  return { rate: preferred, reason: 'preferred' }
}
