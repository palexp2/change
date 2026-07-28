// Helpers partagés pour le rapport de dépendances d'un champ custom
// (GET /custom-fields/:id/dependents). Consommés par CustomFieldModal (rendu
// riche groupé par catégorie) et par les dialogues confirm() des pages qui
// suppriment un champ sans passer par la modale (Factures, Pipeline, DataTable).

export const DEPENDENT_CATEGORY_LABELS = {
  field: 'Champs calculés',
  automation: 'Automations',
  view: 'Vues',
  visibility: 'Règles de visibilité',
}

export const DEPENDENT_CATEGORY_ORDER = ['field', 'automation', 'view', 'visibility']

// Regroupe les dépendances par catégorie, dans l'ordre d'affichage canonique.
// Les entrées sans catégorie (rétro-compat serveur) retombent sur 'field'.
// Retourne [[category, items], …] (catégories vides omises).
export function groupDependents(dependents) {
  const byCat = new Map()
  for (const d of dependents || []) {
    const cat = DEPENDENT_CATEGORY_LABELS[d.category] ? d.category : 'field'
    if (!byCat.has(cat)) byCat.set(cat, [])
    byCat.get(cat).push(d)
  }
  return DEPENDENT_CATEGORY_ORDER.filter(c => byCat.has(c)).map(c => [c, byCat.get(c)])
}

// Résumé texte multi-lignes pour un dialogue confirm() natif : une ligne par
// catégorie, précédée d'un avertissement sur les conséquences.
export function summarizeDependents(dependents) {
  if (!dependents?.length) return ''
  const lines = groupDependents(dependents)
    .map(([cat, items]) => `• ${DEPENDENT_CATEGORY_LABELS[cat]} : ${items.map(d => d.name).join(', ')}`)
  return `\n\n⚠️ ${dependents.length} dépendance${dependents.length > 1 ? 's' : ''} affectée${dependents.length > 1 ? 's' : ''} :\n${lines.join('\n')}\nLes champs calculés cesseront de se calculer (#ERROR) ; les automations et vues concernées devront être ajustées.`
}
