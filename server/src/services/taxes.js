import { round2 } from '../utils/money.js'
// Taxes canadiennes — calcul par province et régimes nommés dans shared/taxes.mjs
// (partagé avec l'aperçu des formulaires) ; ici ce qui n'existe que pour la
// facturation serveur : régime effectif d'une facture et ventilation TPS/TVQ.
import { TAX_REGIMES, computeCanadaTaxes, taxesForRegime } from '../../../shared/taxes.mjs'
export { TAX_REGIMES, computeCanadaTaxes, isCanada, suggestTaxRegime, taxesForRegime } from '../../../shared/taxes.mjs'

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
