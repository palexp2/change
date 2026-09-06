import { round2 } from '../utils/money.js'
// Taxes canadiennes pour Orisha — inscrit aux taxes au Canada uniquement,
// pas en Saskatchewan ni Colombie-Britannique (donc TPS 5% seulement dans ces deux provinces).

const HST_PROVINCES = { ON: 13, NB: 15, NL: 15, NS: 15, PE: 15 }


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

// ── Régimes de taxe explicites (facturation) ────────────────────────────────
//
// `computeCanadaTaxes` déduit les taxes de la province de livraison. C'est le
// bon défaut, mais pas une vérité : un client autochtone livré sur réserve est
// exonéré, un export ne porte pas de taxe. On nomme donc chaque régime, on le
// stocke sur la facture (`pending_invoices.tax_regime`) et l'utilisateur peut
// le changer — la province ne fait plus que *suggérer*.
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
// computeCanadaTaxes : [{ name, percentage, jurisdiction, amount }].
export function taxesForRegime(regime, subtotal) {
  const def = TAX_REGIMES[regime]
  if (!def) return []
  const sub = Number(subtotal) || 0
  return def.rates.map(r => ({ ...r, amount: round2(sub * r.percentage / 100) }))
}

// Taxes effectives d'une facture : le régime choisi s'il est connu, sinon le
// calcul historique par province (factures créées avant l'ajout du champ).
export function resolveInvoiceTaxes({ province, country, subtotal, taxRegime }) {
  if (taxRegime && TAX_REGIMES[taxRegime]) return taxesForRegime(taxRegime, subtotal)
  return computeCanadaTaxes({ province, country, subtotal })
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
