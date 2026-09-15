// Vue « À envoyer » des commandes — un seul endroit pour sa définition.
//
// Le filtre de statut vit dans le pill `table_view_pills` (label ci-dessous) :
// il est éditable dans l'app, on ne le duplique jamais en dur. Ce qu'on ajoute
// ici est la règle qui ne s'exprime pas en filtre de colonne : une commande
// SANS article n'a rien à préparer ni à expédier, elle n'appartient donc pas à
// cette vue (ni à l'étape 3 de la priorité d'assemblage, qui rejoue le pill).
// Elle reste visible dans « Toutes les commandes ».
export const ENVOI_PILL_LABEL = 'À envoyer'

export const hasItemsToShip = o => (o.items_count || 0) > 0
