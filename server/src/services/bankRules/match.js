/**
 * Le comparateur des règles bancaires. Pur : aucune base, aucun réseau.
 *
 * Une règle est une liste de CONDITIONS ; celles qui sont vides ne conditionnent
 * rien (une règle sans fourchette de montant s'applique à tous les montants).
 * Une règle sans AUCUNE condition ne s'applique à rien : elle attraperait tout
 * le relevé, ce qui n'est jamais ce que l'on veut dire.
 *
 * Le libellé se compare par JETONS normalisés, pas en LIKE ni en expression
 * régulière — comme les motifs que Charles édite déjà sur les fiches
 * fournisseurs. « NOVO EXPRESS » attrape « PMTS ENTREPRISES NOVO EXPRESS INC ».
 */
import { normalizeLabel } from '../bankReconciliation.js'
import { patternVariants } from './glossary.js'

const num = (v) => (v == null || v === '' ? null : Number(v))

// Le libellé sur lequel on compare : « Autres détails » d'abord (le BNC y range
// le bénéficiaire réel), puis la description.
export function ruleLabelOf(txn) {
  const details = (txn?.details || '').trim()
  const description = (txn?.description || '').trim()
  // Les deux colonnes portent souvent le même texte : le répéter fausse le
  // décompte des libellés distincts sans rien apporter à la comparaison.
  if (!description || normalizeLabel(details) === normalizeLabel(description)) return details || description
  return [details, description].filter(Boolean).join(' ')
}

// Tous les jetons du motif doivent se retrouver dans le libellé. Un motif vide
// ne matche rien — jamais tout.
//
// Le motif est essayé dans les deux langues de la banque : une règle écrite
// dans QuickBooks (« MISCELLANEOUS ACC. ») reconnaît le libellé de notre relevé
// (« COMPTE DIVERS »), et l'inverse. Voir glossary.js — liste fermée et relevée
// sur nos propres relevés, pas une traduction à vue.
export function labelMatches(label, pattern) {
  const hay = normalizeLabel(label)
  if (!hay) return false
  for (const variant of patternVariants(pattern)) {
    const tokens = variant.split(' ').filter(Boolean)
    if (tokens.length && tokens.every((t) => hay.includes(t))) return true
  }
  return false
}

// Écart en jours entre le jour du mois de la transaction et celui attendu, en
// tenant compte du passage d'un mois à l'autre : le 1er est à un jour du 31.
export function dayOfMonthDistance(isoDate, day) {
  const d = Number(String(isoDate || '').slice(8, 10))
  if (!d || !day) return null
  const raw = Math.abs(d - day)
  return Math.min(raw, 31 - raw)
}

// Une règle s'applique-t-elle à cette ligne ? Renvoie le nombre de conditions
// satisfaites (0 = ne s'applique pas) — il départage deux règles de même rang :
// la plus précise gagne.
// Les conditions détaillées d'une règle, quand elle en porte (une règle
// QuickBooks en a presque toujours plusieurs). `mode: 'any'` = OU, `'all'` = ET.
// Les seuils de montant sont SIGNÉS : « moins de −1 000 » veut dire un débit de
// plus de 1 000 $, et c'est ainsi que QuickBooks les écrit.
export function parseConditions(raw) {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try {
    const o = JSON.parse(raw)
    return Array.isArray(o?.terms) && o.terms.length ? o : null
  } catch { return null }
}

function termMatches(term, txn) {
  if (term.field === 'amount') {
    const a = Number(txn.amount)
    const v = Number(term.value)
    if (!Number.isFinite(a) || !Number.isFinite(v)) return false
    if (term.op === 'lt') return a < v
    if (term.op === 'gt') return a > v
    if (term.op === 'eq') return Math.abs(a - v) < 0.005
    return false
  }
  return labelMatches(ruleLabelOf(txn), term.value)
}

export function conditionsMatch(conditions, txn) {
  const c = parseConditions(conditions)
  if (!c) return null
  const terms = c.terms || []
  if (!terms.length) return null
  return c.mode === 'any' ? terms.some((t) => termMatches(t, txn)) : terms.every((t) => termMatches(t, txn))
}

export function ruleSpecificity(rule, txn) {
  if (!rule || rule.active === 0 || rule.deleted_at) return 0
  let conditions = 0

  if (rule.account_id) {
    if (rule.account_id !== txn.account_id) return 0
    conditions++
  }

  const direction = rule.direction || 'sortie'
  if (direction !== 'tous') {
    const isOut = Number(txn.amount) < 0
    if (direction === 'sortie' ? !isOut : isOut) return 0
    conditions++
  }

  // La liste détaillée fait autorité quand elle existe : le motif simple n'est
  // que son résumé lisible, il ne doit pas conditionner une deuxième fois.
  const detailed = conditionsMatch(rule.conditions, txn)
  if (detailed !== null) {
    if (!detailed) return 0
    conditions += (parseConditions(rule.conditions).terms || []).length
  } else if (rule.label_pattern) {
    if (!labelMatches(ruleLabelOf(txn), rule.label_pattern)) return 0
    conditions++
  }

  const amount = Math.abs(Number(txn.amount) || 0)
  const min = num(rule.amount_min)
  const max = num(rule.amount_max)
  if (min != null) { if (amount < min) return 0; conditions++ }
  if (max != null) { if (amount > max) return 0; conditions++ }

  if (rule.day_of_month) {
    const dist = dayOfMonthDistance(txn.txn_date, Number(rule.day_of_month))
    const tol = num(rule.tolerance_days) ?? 3
    if (dist == null || dist > tol) return 0
    conditions++
  }

  return conditions
}

/**
 * La règle qui gagne pour cette ligne : la priorité la plus basse d'abord (1
 * avant 100, comme QuickBooks), puis la plus précise, puis la plus récente.
 * Aucune règle ⇒ null, et le dossier de préparation se passe d'elle.
 */
export function matchBankRule(txn, rules) {
  let best = null; let bestSpec = 0
  for (const rule of rules || []) {
    const spec = ruleSpecificity(rule, txn)
    if (!spec) continue
    if (!best) { best = rule; bestSpec = spec; continue }
    const p = (rule.priority ?? 100) - (best.priority ?? 100)
    if (p < 0 || (p === 0 && spec > bestSpec)) { best = rule; bestSpec = spec }
  }
  return best
}

// Ce que la règle pose, en français, pour l'aperçu « cette règle remplirait… ».
export function ruleSetsLabels(rule) {
  const out = []
  if (rule?.vendor_name) out.push(`fournisseur ${rule.vendor_name}`)
  if (rule?.expense_account_id) out.push('compte de dépense')
  if (rule?.tax_code_id) out.push('code de taxe')
  if (rule?.memo) out.push('mémo')
  if (rule?.qb_type) out.push(rule.qb_type === 'bill' ? 'facture fournisseur' : 'dépense')
  return out
}
