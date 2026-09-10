// Opérateurs du filtre d'un champ lien — miroir de LINK_FILTER_OPS côté serveur
// (server/src/services/linkFilter.js). Tenir les deux listes alignées.
//
// Un champ lien filtré ne propose qu'un sous-ensemble des fiches de sa table
// cible au moment de lier (les produits actifs, les entreprises clientes…).
export const LINK_FILTER_OPS = [
  { v: 'is', label: 'est' },
  { v: 'is_not', label: 'n\'est pas' },
  { v: 'contains', label: 'contient' },
  { v: 'not_contains', label: 'ne contient pas' },
  { v: 'gt', label: '>' },
  { v: 'lt', label: '<' },
  { v: 'empty', label: 'est vide' },
  { v: 'not_empty', label: 'non vide' },
]

// Colonne à choix UNIQUE : « contient » ou « > » n'ont pas de sens sur une
// liste fermée — on propose les opérateurs de choix, dont les deux qui portent
// sur plusieurs choix à la fois. (Un choix multiple garde « contient » : sa
// colonne stocke une liste, c'est bien l'inclusion qu'on y cherche.)
export const SELECT_LINK_FILTER_OPS = [
  { v: 'is', label: 'est' },
  { v: 'is_not', label: 'n\'est pas' },
  { v: 'is_any_of', label: 'est l\'un des' },
  { v: 'is_none_of', label: 'n\'est aucun des' },
  { v: 'empty', label: 'est vide' },
  { v: 'not_empty', label: 'non vide' },
]

// Opérateurs qui n'attendent pas de valeur.
export const VALUE_LESS_LINK_OPS = new Set(['empty', 'not_empty'])

// Opérateurs dont la valeur est une LISTE de choix.
export const MULTI_VALUE_LINK_OPS = new Set(['is_any_of', 'is_none_of'])

// Opérateurs proposés pour une colonne, plus celui déjà enregistré s'il n'y
// figure pas (un filtre posé avant un changement de type garde un select qui
// dit la vérité).
export function linkFilterOpsForType(type, currentOp) {
  const ops = type === 'single_select' ? SELECT_LINK_FILTER_OPS : LINK_FILTER_OPS
  if (!currentOp || ops.some(o => o.v === currentOp)) return ops
  const known = LINK_FILTER_OPS.concat(SELECT_LINK_FILTER_OPS).find(o => o.v === currentOp)
  return [...ops, { v: currentOp, label: known?.label || currentOp }]
}

// Valeur vide correspondant à un opérateur (liste ou scalaire).
export function emptyLinkFilterValue(op) {
  return MULTI_VALUE_LINK_OPS.has(op) ? [] : ''
}

// Une condition est-elle renseignée ?
function hasValue(r) {
  if (VALUE_LESS_LINK_OPS.has(r.op)) return true
  if (MULTI_VALUE_LINK_OPS.has(r.op)) return Array.isArray(r.value) && r.value.length > 0
  return String(r.value ?? '').trim() !== ''
}

// Conditions complètes (une ligne en cours de saisie ne part pas au serveur).
export function completeLinkFilter(rows) {
  return (rows || [])
    .filter(r => r?.column && hasValue(r))
    .map(r => {
      if (VALUE_LESS_LINK_OPS.has(r.op)) return { column: r.column, op: r.op }
      if (MULTI_VALUE_LINK_OPS.has(r.op)) {
        return { column: r.column, op: r.op, value: r.value.map(v => String(v).trim()).filter(Boolean) }
      }
      return { column: r.column, op: r.op, value: String(r.value).trim() }
    })
}
