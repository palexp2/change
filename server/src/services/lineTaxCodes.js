import { round2Safe as round2 } from '../utils/money.js'

// Code de taxe PAR LIGNE sur un document à taxation MIXTE (épicerie, pharmacie,
// dépanneur : panier d'aliments de base détaxés + quelques articles taxables).
//
// Le total de taxes imprimé est juste, mais il ne porte que sur une PARTIE du
// sous-total. Publier toutes les lignes au code du document déclare alors la
// totalité de l'achat comme fourniture taxable (QB inscrit NetAmountTaxable =
// sous-total complet) : la déclaration de TPS/TVQ surestime les achats taxables,
// même si la taxe réclamée, elle, est exacte.
//
// On pose donc le code de chaque ligne : « Détaxé » pour les lignes sans taxe,
// le code taxable du document pour les autres. Le signal vient de l'extraction
// (indicateur de taxe imprimé à côté de chaque ligne du reçu, champ `taxable`),
// et il n'est retenu QUE s'il redonne exactement les taxes imprimées — sinon on
// ne code rien plutôt que d'inventer une ventilation.

export const ZERO_RATED_TAX_CODE_NAME = 'Détaxé'
export const FULL_TAX_CODE_NAME = 'TPS/TVQ QC - 9,975'
export const GST_ONLY_TAX_CODE_NAME = 'TPS'

const GST_RATE = 0.05
const QST_RATE = 0.09975
// Un cent d'écart par taxe : l'arrondi du commerçant se fait sur la base taxable
// entière, pas ligne par ligne.
const TOLERANCE = 0.02

const amountOf = it => Number(it?.total) || 0

// Retire la marque de taxabilité produite par l'extraction : elle sert au calcul
// ci-dessous, elle n'a rien à faire dans les lignes stockées.
export function stripTaxableFlags(items) {
  return (items || []).map(it => {
    if (!it || typeof it !== 'object' || !('taxable' in it)) return it
    const { taxable: _taxable, ...rest } = it
    return rest
  })
}

// Pose `tax_code_name` sur chaque ligne quand les taxes imprimées ne portent que
// sur une partie du sous-total. Retourne { items, applied, taxableBase } ou null
// (rien à faire, ou signal non fiable).
export function applyMixedTaxCodeNames({ items, tps, tvq, other_taxes }) {
  const lines = Array.isArray(items) ? items.filter(it => it && typeof it === 'object') : []
  if (lines.length < 2) return null
  // Une ligne déjà codée (repas, transport, saisie humaine) : on ne touche à rien.
  if (lines.some(it => it.tax_code_name || it.tax_code_id)) return null

  const gst = round2(Number(tps) || 0)
  const qst = round2(Number(tvq) || 0)
  if (round2(Number(other_taxes) || 0) !== 0) return null
  if (gst <= 0) return null

  const qstBilled = qst > 0
  const rate = qstBilled ? GST_RATE + QST_RATE : GST_RATE
  const codeName = qstBilled ? FULL_TAX_CODE_NAME : GST_ONLY_TAX_CODE_NAME

  const base = round2(lines.reduce((s, it) => s + amountOf(it), 0))
  if (base <= 0) return null

  // Taxes = taux plein sur tout le document → rien de mixte, le code du document suffit.
  if (matchesBilledTaxes(base, gst, qst, qstBilled)) return null

  const flagged = lines.filter(it => it.taxable === true)
  if (!flagged.length || flagged.length === lines.length) return null
  const taxableBase = round2(flagged.reduce((s, it) => s + amountOf(it), 0))
  if (!matchesBilledTaxes(taxableBase, gst, qst, qstBilled)) return null

  return {
    items: lines.map(it => ({ ...it, tax_code_name: it.taxable === true ? codeName : ZERO_RATED_TAX_CODE_NAME })),
    applied: lines.length,
    taxableBase,
    rate,
  }
}

function matchesBilledTaxes(taxableBase, gst, qst, qstBilled) {
  if (Math.abs(round2(taxableBase * GST_RATE) - gst) > TOLERANCE) return false
  if (qstBilled && Math.abs(round2(taxableBase * QST_RATE) - qst) > TOLERANCE) return false
  return true
}
