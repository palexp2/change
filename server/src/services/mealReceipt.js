import { round2Safe as round2 } from '../utils/money.js'
// Reçus de repas / représentation (restaurant, traiteur, livraison de repas).
//
// Deux particularités comptables, systématiquement les mêmes :
//  1. Le POURBOIRE n'est pas une fourniture taxable — aucune TPS/TVQ n'est facturée
//     dessus. Il va sur sa propre ligne, au code QB « Hors champ » (0 %, hors des cases
//     du rapport de taxes). Le mettre au même code que le repas ferait réclamer un
//     crédit sur un montant jamais taxé.
//  2. Le REPAS lui-même est taxable mais la récupération CTI/RTI est limitée à 50 % →
//     code QB « TPS/TVQ repas » (le taux plein est facturé, c'est QB qui applique la
//     restriction de 50 % au posting). Voir fiscalStatus.js, type `repas_representation`.
//
// Le pourboire est imprimé sur le coupon du TERMINAL de paiement (« POURBOIRE », « TIP »),
// pas sur l'addition : l'addition s'arrête au total taxes incluses. Le montant réellement
// débité est donc addition + pourboire — c'est lui qu'on comptabilise.


export const MEAL_TAX_CODE_NAME = 'TPS/TVQ repas'
export const TIP_TAX_CODE_NAME = 'Hors champ'

// Une ligne de pourboire — libellés vus sur les coupons de terminal (FR et EN) et les
// factures de traiteur/livraison. « Frais de service » est aussi un pourboire imposé.
const TIP_RE = /pourboire|\btips?\b|gratuit(?:y|ies|é|és)|frais de service|service charge/i

export function isTipLine(description) {
  return TIP_RE.test(String(description || ''))
}

// Pose le code de taxe (par NOM QB) sur chaque ligne d'un reçu de repas :
// pourboire → « Hors champ », tout le reste → « TPS/TVQ repas ».
// Les lignes qui portent DÉJÀ un code (posé à la main ou par un autre traitement) ne
// sont pas touchées. Retourne { items, applied } — `applied` = nb de lignes codées.
export function applyMealTaxCodeNames(items) {
  let applied = 0
  const out = (items || []).map(it => {
    if (!it || typeof it !== 'object') return it
    if (it.tax_code_name || it.tax_code_id) return it
    applied++
    return { ...it, tax_code_name: isTipLine(it.description) ? TIP_TAX_CODE_NAME : MEAL_TAX_CODE_NAME }
  })
  return { items: out, applied }
}

// Recale les montants d'un reçu de repas AVEC pourboire.
// L'IA lit souvent le total de l'ADDITION (taxes incluses, sans pourboire) comme total
// du document : l'invariant subtotal + taxes = total casse dès que la ligne de pourboire
// est présente. On rétablit la seule lecture correcte : sous-total = somme des lignes
// (repas + pourboire), taxes inchangées (elles ne portent que sur le repas), total =
// sous-total + taxes = montant réellement débité.
// Retourne null si rien à corriger (pas de pourboire, ou invariant déjà exact).
export function reconcileMealAmounts({ items, subtotal, tps, tvq, other_taxes, total }) {
  const lines = (items || []).filter(it => it && it.total != null)
  if (!lines.length) return null
  if (!lines.some(it => isTipLine(it.description))) return null

  const taxes = round2((Number(tps) || 0) + (Number(tvq) || 0) + (Number(other_taxes) || 0))
  const newSubtotal = round2(lines.reduce((a, it) => a + (Number(it.total) || 0), 0))
  const newTotal = round2(newSubtotal + taxes)
  if (Math.abs(newSubtotal - round2(subtotal)) < 0.02 && Math.abs(newTotal - round2(total)) < 0.02) return null
  return { subtotal: newSubtotal, total: newTotal }
}
