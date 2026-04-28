// Mirroir client de server/src/services/taxes.js — pour le preview live des
// taxes dans le formulaire de création de facture.

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
  return [{ name: 'TPS', percentage: 5, jurisdiction: 'CA', amount: round2(sub * 0.05) }]
}
