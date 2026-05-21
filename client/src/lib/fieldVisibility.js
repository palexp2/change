// Évaluateur de règles de visibilité conditionnelle des champs.
//
// Forme d'un arbre de conditions :
//   { op: 'AND'|'OR', rules: [ leaf | group, ... ] }
//   leaf = { field: 'subscription_id', operator: 'populated'|'empty'|'equals'|'not_equals', value?: any }
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
function looseEquals(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined || b === ''
  if (b === null || b === undefined) return a === '' || false
  return String(a) === String(b)
}

export function evaluateLeaf(leaf, record) {
  const v = record ? record[leaf.field] : undefined
  switch (leaf.operator) {
    case 'populated': return isPopulated(v)
    case 'empty':     return !isPopulated(v)
    case 'equals':    return looseEquals(v, leaf.value)
    case 'not_equals':return !looseEquals(v, leaf.value)
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

// Renvoie true si AU MOINS UNE règle (parmi celles applicables au champ)
// évalue à true contre le record. Le champ doit alors être masqué.
export function shouldHide(rules, record) {
  if (!Array.isArray(rules) || rules.length === 0) return false
  return rules.some(r => evaluateConditions(r.conditions, record))
}
