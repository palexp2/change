// Taxes canadiennes — partagé client (aperçu live des formulaires de facture et
// d'abonnement) / serveur (facturation). Orisha est inscrite aux taxes au Canada
// seulement, pas en Saskatchewan ni en Colombie-Britannique (TPS 5 % seule).

const HST_PROVINCES = { ON: 13, NB: 15, NL: 15, NS: 15, PE: 15 }

function round2(n) { return Math.round(n * 100) / 100 }

function normalizeProvince(province) {
  if (!province) return null
  const map = {
    'ALBERTA': 'AB', 'AB': 'AB',
    'BRITISH COLUMBIA': 'BC', 'COLOMBIE-BRITANNIQUE': 'BC', 'BC': 'BC',
    'MANITOBA': 'MB', 'MB': 'MB',
    'NEW BRUNSWICK': 'NB', 'NOUVEAU-BRUNSWICK': 'NB', 'NB': 'NB',
    'NEWFOUNDLAND AND LABRADOR': 'NL', 'TERRE-NEUVE-ET-LABRADOR': 'NL', 'NL': 'NL',
    'NOVA SCOTIA': 'NS', 'NOUVELLE-ÉCOSSE': 'NS', 'NS': 'NS',
    'ONTARIO': 'ON', 'ON': 'ON',
    'PRINCE EDWARD ISLAND': 'PE', 'ÎLE-DU-PRINCE-ÉDOUARD': 'PE', 'PE': 'PE', 'PEI': 'PE',
    'QUEBEC': 'QC', 'QUÉBEC': 'QC', 'QC': 'QC',
    'SASKATCHEWAN': 'SK', 'SK': 'SK',
    'YUKON': 'YT', 'YT': 'YT',
    'NORTHWEST TERRITORIES': 'NT', 'TERRITOIRES DU NORD-OUEST': 'NT', 'NT': 'NT',
    'NUNAVUT': 'NU', 'NU': 'NU',
  }
  return map[String(province).trim().toUpperCase()] || null
}

function normalizeCountry(country) {
  if (!country) return null
  const v = String(country).trim().toUpperCase()
  if (v === 'CA' || v === 'CANADA') return 'CA'
  return v
}

// Taxes déduites de la province : [{ name, percentage, jurisdiction, amount }].
// Tableau vide hors Canada ou province inconnue.
export function computeCanadaTaxes({ province, country, subtotal }) {
  const c = normalizeCountry(country)
  if (c !== 'CA') return []
  const p = normalizeProvince(province)
  if (!p) return []
  const sub = Number(subtotal) || 0

  if (HST_PROVINCES[p]) {
    const pct = HST_PROVINCES[p]
    return [{ name: 'HST', percentage: pct, jurisdiction: `CA-${p}`, amount: round2(sub * pct / 100) }]
  }
  if (p === 'QC') {
    return [
      { name: 'TPS', percentage: 5, jurisdiction: 'CA', amount: round2(sub * 0.05) },
      { name: 'TVQ', percentage: 9.975, jurisdiction: 'CA-QC', amount: round2(sub * 0.09975) },
    ]
  }
  // Tous les autres (AB, MB, YT, NT, NU + SK et BC où Orisha n'est pas inscrite) → TPS seule
  return [{ name: 'TPS', percentage: 5, jurisdiction: 'CA', amount: round2(sub * 0.05) }]
}

// ── Régimes de taxe nommés (facturation) ────────────────────────────────────
// `computeCanadaTaxes` déduit les taxes de la province de livraison. Bon défaut,
// pas une vérité : un client autochtone livré sur réserve est exonéré, un export
// ne porte pas de taxe. Chaque régime est nommé, stocké sur la facture
// (`pending_invoices.tax_regime`) ; la province ne fait que *suggérer*.
export const TAX_REGIMES = {
  qc: { label: 'TPS 5 % + TVQ 9,975 % — Québec', rates: [
    { name: 'TPS', percentage: 5, jurisdiction: 'CA' },
    { name: 'TVQ', percentage: 9.975, jurisdiction: 'CA-QC' },
  ] },
  hst_on: { label: 'TVH 13 % — Ontario', rates: [{ name: 'HST', percentage: 13, jurisdiction: 'CA-ON' }] },
  hst_nb: { label: 'TVH 15 % — Nouveau-Brunswick', rates: [{ name: 'HST', percentage: 15, jurisdiction: 'CA-NB' }] },
  hst_nl: { label: 'TVH 15 % — Terre-Neuve-et-Labrador', rates: [{ name: 'HST', percentage: 15, jurisdiction: 'CA-NL' }] },
  hst_ns: { label: 'TVH 15 % — Nouvelle-Écosse', rates: [{ name: 'HST', percentage: 15, jurisdiction: 'CA-NS' }] },
  hst_pe: { label: 'TVH 15 % — Île-du-Prince-Édouard', rates: [{ name: 'HST', percentage: 15, jurisdiction: 'CA-PE' }] },
  gst: { label: 'TPS 5 % seulement', rates: [{ name: 'TPS', percentage: 5, jurisdiction: 'CA' }] },
  none: { label: 'Aucune taxe', rates: [] },
}

const HST_REGIME_BY_PROVINCE = { ON: 'hst_on', NB: 'hst_nb', NL: 'hst_nl', NS: 'hst_ns', PE: 'hst_pe' }

export function isCanada(country) {
  return normalizeCountry(country) === 'CA'
}

// Régime suggéré par l'adresse de livraison — le défaut proposé dans l'UI.
export function suggestTaxRegime({ province, country }) {
  if (!isCanada(country)) return 'none'
  const p = normalizeProvince(province)
  if (!p) return 'none'
  if (HST_REGIME_BY_PROVINCE[p]) return HST_REGIME_BY_PROVINCE[p]
  if (p === 'QC') return 'qc'
  return 'gst'
}

// Applique un régime nommé à un sous-total. Même forme de retour que
// computeCanadaTaxes.
export function taxesForRegime(regime, subtotal) {
  const def = TAX_REGIMES[regime]
  if (!def) return []
  const sub = Number(subtotal) || 0
  return def.rates.map(r => ({ ...r, amount: round2(sub * r.percentage / 100) }))
}
