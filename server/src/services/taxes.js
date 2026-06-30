// Taxes canadiennes pour Orisha — inscrit aux taxes au Canada uniquement,
// pas en Saskatchewan ni Colombie-Britannique (donc TPS 5% seulement dans ces deux provinces).

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

// Returns an array of { name, percentage, jurisdiction, amount } describing
// the taxes to charge. Empty array for non-Canada, or for Canada with an
// unrecognized province.
export function computeCanadaTaxes({ province, country, subtotal }) {
  const c = normalizeCountry(country)
  if (c !== 'CA') return []
  const p = normalizeProvince(province)
  if (!p) return []

  const sub = Number(subtotal) || 0

  if (HST_PROVINCES[p]) {
    const pct = HST_PROVINCES[p]
    return [{
      name: 'HST',
      percentage: pct,
      jurisdiction: `CA-${p}`,
      amount: round2(sub * pct / 100),
    }]
  }

  if (p === 'QC') {
    return [
      { name: 'TPS', percentage: 5, jurisdiction: 'CA', amount: round2(sub * 0.05) },
      { name: 'TVQ', percentage: 9.975, jurisdiction: 'CA-QC', amount: round2(sub * 0.09975) },
    ]
  }

  // Tous les autres (AB, MB, YT, NT, NU + SK et BC où Orisha n'est pas inscrit) → TPS seul
  return [{ name: 'TPS', percentage: 5, jurisdiction: 'CA', amount: round2(sub * 0.05) }]
}

// Taux de référence pour la ventilation TPS/TVQ d'un montant de taxe global.
export const TPS_RATE = 0.05
export const TVQ_RATE = 0.09975
const QC_COMBINED_RATE = TPS_RATE + TVQ_RATE // 0.14975

// Ventile un montant de taxe TOTAL (souvent stocké comme une seule colonne, ex.
// `factures.total_amount - amount_before_tax_cad` ou `achats_fournisseurs.tax_cad`)
// en TPS / TVQ / autre, à partir de la base hors-taxe.
//
// Pourquoi heuristique : plusieurs tables ne conservent qu'un montant de taxe
// agrégé sans le détail par juridiction. On compare le total réel aux taux
// québécois attendus pour décider du régime, avec une tolérance (le plus grand de
// 0,02 $ ou 0,5 % de la base) qui absorbe les arrondis ligne-à-ligne.
//
// Catégories retournées :
//   - 'qc'       : TPS 5 % + TVQ 9,975 % (le cas courant). tps+tvq === taxTotal.
//   - 'gst_only' : TPS seule (AB, SK, BC, MB, territoires). tvq = 0.
//   - 'zero'     : aucune taxe (export / détaxé / hors-champ).
//   - 'other'    : ne correspond à aucun régime connu — probablement TVH d'une autre
//                  province, ou une base manquante. Mis dans `other` pour révision.
export function splitQcTax({ base, taxTotal }) {
  const b = Number(base) || 0
  const t = round2(Number(taxTotal) || 0)
  const tol = Math.max(0.02, Math.abs(b) * 0.005)

  if (Math.abs(t) <= tol) {
    return { tps: 0, tvq: 0, other: 0, category: 'zero' }
  }

  if (b > 0) {
    const expectedTps = round2(b * TPS_RATE)
    const expectedCombined = round2(b * QC_COMBINED_RATE)
    if (Math.abs(t - expectedCombined) <= tol) {
      // Régime QC : on fixe la TPS au taux exact et on met le reste en TVQ, de
      // sorte que tps + tvq === taxTotal (pas de perte d'arrondi).
      return { tps: expectedTps, tvq: round2(t - expectedTps), other: 0, category: 'qc' }
    }
    if (Math.abs(t - expectedTps) <= tol) {
      return { tps: t, tvq: 0, other: 0, category: 'gst_only' }
    }
  }

  // Base inconnue ou montant inattendu → on isole pour révision manuelle.
  return { tps: 0, tvq: 0, other: t, category: 'other' }
}
