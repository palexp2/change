// Titre de la page affichée, publié par <PageTitle> et lu au moment d'épingler
// un signet. La route seule ne suffit pas à nommer une page : `/champs/shipments`
// s'appelle « Configuration des champs — Envois », et seule la page le sait.
// Un simple module-store (pas de contexte) : la valeur n'est lue qu'au clic,
// aucun rendu n'en dépend.
let current = { key: null, title: '' }

export function publishPageTitle(key, title) {
  current = { key, title }
}

// Ne rend le titre que s'il appartient bien à la route demandée : après une
// navigation, l'ancien titre ne doit pas servir de nom au nouveau signet.
export function currentPageTitle(key) {
  return current.key === key ? current.title : ''
}
