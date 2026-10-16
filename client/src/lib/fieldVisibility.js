// Évaluateur de règles de visibilité conditionnelle des champs.
//
// Forme d'un arbre de conditions :
//   { op: 'AND'|'OR', rules: [ leaf | group, ... ] }
//   leaf = { field: 'subscription_id', operator: 'populated'|'empty'|'equals'|'not_equals', value?: any }
//        | { field, operator: 'any_of'|'none_of', value: string[] }  (champ Sélection)
//
// Une feuille s'évalue contre un `record` (objet plat de type ce que renvoie
// l'API factures/orders/etc.). Un groupe combine ses enfants avec AND ou OR.

function isPopulated(v) {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.trim() !== ''
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v).length > 0
  return true
}

// Comparaison souple — on coerce vers string pour éviter les surprises 1=='1'.
// Valeur booléenne (case à cocher) : comparée en vrai/faux, vide = faux.
export function isChecked(v) {
  return v === true || v === 1 || (typeof v === 'string' && ['1', 'true'].includes(v.trim().toLowerCase()))
}
function looseEquals(a, b) {
  if (typeof b === 'boolean') return isChecked(a) === b
  if (a === null || a === undefined) return b === null || b === undefined || b === ''
  if (b === null || b === undefined) return a === '' || false
  return String(a) === String(b)
}

// Vrai si la valeur (simple, ou tableau d'un multi-select) figure dans la liste.
function inList(v, list) {
  const wanted = new Set((Array.isArray(list) ? list : [list]).filter(x => x != null && x !== '').map(String))
  const values = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v])
  return values.some(x => wanted.has(String(x)))
}

export function evaluateLeaf(leaf, record) {
  const v = record ? record[leaf.field] : undefined
  switch (leaf.operator) {
    case 'populated': return isPopulated(v)
    case 'empty':     return !isPopulated(v)
    case 'equals':    return looseEquals(v, leaf.value)
    case 'not_equals':return !looseEquals(v, leaf.value)
    case 'any_of':    return inList(v, leaf.value)
    case 'none_of':   return !inList(v, leaf.value)
    default:          return false
  }
}

export function evaluateConditions(node, record) {
  if (!node || typeof node !== 'object') return false
  // Groupe
  if ('op' in node) {
    if (!Array.isArray(node.rules) || node.rules.length === 0) return false
    if (node.op === 'AND') return node.rules.every(r => evaluateConditions(r, record))
    if (node.op === 'OR')  return node.rules.some(r => evaluateConditions(r, record))
    return false
  }
  // Feuille
  return evaluateLeaf(node, record)
}

// Une règle dit quand MONTRER le champ. Sans règle : visible. Avec règles :
// visible si AU MOINS UNE est vraie, masqué sinon.
export function shouldHide(rules, record) {
  if (!Array.isArray(rules) || rules.length === 0) return false
  return !rules.some(r => evaluateConditions(r.conditions, record))
}
