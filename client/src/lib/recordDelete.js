import api from './api.js'

// Suppression d'une fiche, par table.
//
// La case « Autoriser la suppression de la fiche » du mode de personnalisation
// (voir components/DetailFieldGrid.jsx) a besoin de deux choses par entité :
//  1. comment supprimer l'enregistrement (`run`), quand c'est la carte de
//     champs qui doit offrir l'action — les fiches qui portaient déjà leur
//     propre bouton Supprimer le gardent et se contentent de lire la case ;
//  2. ce que vaut la case quand personne ne l'a réglée (`allowedByDefault`) :
//     le comportement d'origine de la fiche. Sans ça, cocher la case ferait
//     apparaître une action là où il n'y en avait pas, ou décocherait
//     silencieusement une action qui existait.
//
// `undoTable` : table soft-delete acceptée par /api/undo — la suppression
// s'annonce alors avec un toast « Annuler » (8 s) et ne demande pas de
// confirmation. Sans elle, on confirme avant, la suppression étant définitive.
//
// Une entité absente de ce registre n'a pas de suppression de fiche : la case
// n'apparaît pas dans son mode de personnalisation.
export const RECORD_DELETE = {
  companies: {
    label: "Supprimer l'entreprise",
    allowedByDefault: false,
    run: id => api.companies.delete(id),
    undoTable: 'companies',
    toast: 'Entreprise supprimée',
    list: '/companies',
  },
  orders: {
    label: 'Supprimer la commande',
    allowedByDefault: false,
    run: id => api.orders.delete(id),
    undoTable: 'orders',
    toast: 'Commande supprimée',
    list: '/orders',
  },
  adresses: {
    label: "Supprimer l'adresse",
    allowedByDefault: false,
    run: id => api.adresses.delete(id),
    confirm: 'Supprimer cette adresse ?',
    toast: 'Adresse supprimée',
    list: '/companies',
  },

  // Fiches qui rendent elles-mêmes leur bouton Supprimer : elles lisent la case
  // (useRecordDeleteAllowed) et masquent l'action quand elle est décochée.
  contacts: { allowedByDefault: true },
  products: { allowedByDefault: true },
  projects: { allowedByDefault: true },
  tickets: { allowedByDefault: true },
  purchases: { allowedByDefault: true },
  shipments: { allowedByDefault: true },
  ops_issues: { allowedByDefault: true },
}

export function recordDeleteSpec(entityType) {
  if (!entityType) return null
  return RECORD_DELETE[entityType] || null
}

// Valeur de la case quand elle n'a jamais été réglée pour cette entité.
export function deleteAllowedByDefault(entityType) {
  return recordDeleteSpec(entityType)?.allowedByDefault === true
}
