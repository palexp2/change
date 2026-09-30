import { round2Safe as round2 } from '../utils/money.js'

// Une seule pièce absorbe son transport et son escompte, même avant rattachement LIA.
// Libellés de frais précis : « caisse de transport » reste un véritable article.
const TRANSPORT = /^(?:(?:frais|co[uû]ts?|charges?)\s+(?:de\s+|d[e’']\s*)?)?(?:transport|livraison|expedition|port|manutention)(?:\s+(?:et\s+manutention|charges?|fees?))?\s*$|^(?:shipping(?:\s*(?:&|and)\s*handling)?|freight|delivery|handling)(?:\s+(?:cost|charges?|fees?))?\s*$/i
const DISCOUNT = /^(?:escompte|remise|rabais|discount)(?:\s+global)?(?:\s+[\d.,]+\s*%)?\s*$/i
// Frais globaux de la facture (Charles, 2026-09-27 : « Frais de traitement bancaire »
// PCBWay) : répartis comme le transport. Ajouter ici les prochains frais à ventiler.
const FEES = /^(?:frais\s+(?:de\s+|d[e’']\s*)?(?:traitement(?:\s+bancaire)?|bancaires?|paiement|transaction|service|dossier|carte)|frais\s+paypal|(?:bank|processing|transaction|payment|paypal|card|service|handling)\s+(?:processing\s+)?(?:fees?|charges?))\s*$/i
const normalized = it => (it?.description || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
const amount = it => it?.total != null ? Number(it.total) : Number(it?.unit_price) * Number(it?.quantity)

// Une ligne de frais est un montant global sur la facture, pas un article : transport
// positif, escompte négatif. Une ligne déjà rattachée à un achat LIA est un article.
export const isChargeLine = it => !it?.purchase_id && !it?.lia_ref && (
  ((TRANSPORT.test(normalized(it)) || FEES.test(normalized(it))) && amount(it) >= 0)
  || (DISCOUNT.test(normalized(it)) && amount(it) <= 0)
)

// Ventilations comptables/fiscales explicitement différentes : on ne fusionne pas.
const splitKey = it => ['tax_code_id', 'expense_account_id'].map(k => it?.[k] || '').join('|')

export function consolidateSingleItemCharges(items) {
  if (!Array.isArray(items) || items.length < 2) return items
  const articles = items.filter(it => !isChargeLine(it))
  if (articles.length !== 1 || !(amount(articles[0]) > 0)) return items
  const article = articles[0]
  if (items.some(it => !Number.isFinite(amount(it)) || splitKey(it) !== splitKey(article))) return items
  const total = round2(items.reduce((sum, it) => sum + amount(it), 0))
  if (total <= 0) return items
  return [{ ...article, total, quantity: null, unit_price: null }]
}

// PLUSIEURS articles : le transport/escompte imprimé sur sa propre ligne est le même
// montant global que celui extrait dans `freight_amount`/`discount_amount` — l'IA le
// recopie tantôt dans l'un, tantôt dans l'autre. Sorti des lignes ici, il repart dans
// la répartition au prorata (« Pro rata transport ») au lieu de rester une ligne à part
// qu'aucune pièce ne porte. Renvoie null quand il n'y a rien à sortir.
export function extractChargeLines(items) {
  const list = Array.isArray(items) ? items : []
  if (list.length < 2) return null
  const charges = list.filter(isChargeLine)
  const articles = list.filter(it => !isChargeLine(it))
  if (!charges.length || articles.length < 2) return null
  if (!list.every(it => Number.isFinite(amount(it)))) return null
  if (!articles.every(it => amount(it) > 0)) return null
  const ref = splitKey(articles[0])
  if (!list.every(it => splitKey(it) === ref)) return null
  let freight = 0
  let discount = 0
  for (const c of charges) {
    const a = amount(c)
    if (a >= 0) freight += a
    else discount -= a
  }
  const labels = charges.map(c => ({ label: (c.description || '').trim(), amount: round2(amount(c)) }))
  return { articles, freight: round2(freight), discount: round2(discount), labels }
}
