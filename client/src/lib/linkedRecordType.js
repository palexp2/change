import { PEEK_ROUTES } from './recordPeekRoutes.jsx'
import { LINKED_RECORD_TYPE_LABELS, TABLE_RECORD_LABELS } from './tableDefs.js'

// Type « Lien vers <Table> » d'un champ natif, comme le type « Link to another
// record » d'Airtable. La liste figée LINKED_RECORD_TYPE_LABELS ne couvrait que
// cinq colonnes : toutes les autres (fournisseur d'un achat, employé d'une
// tâche, facture d'un paiement…) s'annonçaient « Texte » dans la modale du
// champ alors qu'elles ouvrent la fiche d'une autre table.
//
// Ordre des preuves :
//  1. `linkTarget` déclaré sur la colonne (tableDefs.js), ou `linksTo` — même
//     cible, mais ne sert QU'À nommer le type (`linkTarget` change aussi
//     l'éditeur de cellule et les filtres) ;
//  2. la liste figée (rendu sur-mesure connu) ;
//  3. le rendu lui-même : on l'appelle sur quelques lignes et on cherche dans
//     l'arbre produit un lien vers « /<ressource>/<id> » d'une AUTRE fiche
//     (un lien vers la ligne elle-même est son champ principal, pas un lien).

// Nom d'UNE fiche d'une ressource d'URL (« envois ») ou d'une table (« shipments »).
function recordLabelOf(key) {
  return PEEK_ROUTES[key]?.label || TABLE_RECORD_LABELS[key] || null
}

const RECORD_PATH = /^\/([a-z][a-z0-9_-]*)\/([^/?#]+)$/

function resourceOfPath(path, selfId) {
  if (typeof path !== 'string') return null
  const m = RECORD_PATH.exec(path)
  if (!m || !recordLabelOf(m[1])) return null
  if (selfId != null && m[2] === String(selfId)) return null
  return m[1]
}

// Ressource visée par le premier lien de fiche trouvé dans un arbre d'éléments
// React (sans les monter : seules les props sont lues).
function findLinkedResource(node, selfId, depth = 0) {
  if (!node || depth > 8) return null
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findLinkedResource(n, selfId, depth + 1)
      if (r) return r
    }
    return null
  }
  if (typeof node !== 'object' || !node.props) return null
  const p = node.props
  const direct = resourceOfPath(p.to, selfId) || resourceOfPath(p.href, selfId)
  if (direct) return direct
  // Pastilles de fiches liées (LinkedRecordsValue) : table visée du champ.
  const linked = p.field?.record_link_target
  if (typeof linked === 'string' && recordLabelOf(linked)) return linked
  // Champ référence de fiche (LinkedRecordField) : table cherchée, ou lien
  // construit pour la valeur posée.
  if (typeof p.searchTarget === 'string' && recordLabelOf(p.searchTarget)) return p.searchTarget
  if (typeof p.getHref === 'function') {
    try {
      const r = resourceOfPath(p.getHref({ id: p.value ?? 1 }), null)
      if (r) return r
    } catch { /* rendu qui exige plus qu'un id : on passe */ }
  }
  return findLinkedResource(p.children, selfId, depth + 1)
}

const asLabel = key => `Lien vers ${recordLabelOf(key)}`

// Libellé « Lien vers … » d'une colonne de tableau, ou null.
// `rows` : quelques lignes pour éprouver le rendu (facultatif).
// `table` : table qui porte la colonne (facultatif). La liste figée ne vaut pas
// pour la table visée elle-même : « # Commande » des Commandes est leur champ
// principal, pas un « Lien vers Commande ».
export function linkedRecordTypeLabel(col, rows = [], table = null) {
  if (!col) return null
  if (col.linkTarget && recordLabelOf(col.linkTarget)) return asLabel(col.linkTarget)
  if (col.linksTo && recordLabelOf(col.linksTo)) return asLabel(col.linksTo)
  if (!col.render) return null
  const known = LINKED_RECORD_TYPE_LABELS[col.id]
  if (known && !(table && recordLabelOf(table) && known === asLabel(table))) return known
  let tried = 0
  for (const row of rows || []) {
    if (!row || tried >= 25) break
    tried++
    let el
    // Un rendu qui appelle un hook ne s'exécute pas hors de React : sans preuve,
    // la colonne garde son type de stockage.
    try { el = col.render(row) } catch { continue }
    const res = findLinkedResource(el, row.id)
    if (res) return asLabel(res)
  }
  return null
}

// Même chose pour un bloc de fiche (<DetailField>) : son contenu déjà rendu.
export function linkedRecordTypeLabelOfNode(node, selfId) {
  const res = findLinkedResource(node, selfId)
  return res ? asLabel(res) : null
}

export function isLinkedRecordTypeLabel(label) {
  return typeof label === 'string' && label.startsWith('Lien vers ')
}
