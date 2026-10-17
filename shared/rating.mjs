// Notes en étoiles (type de champ « Évaluation ») — partagé client / serveur.
//
// La valeur stockée est un ENTIER de 0 à 5 — 0 (ou NULL) = pas de note.
// Échelle fixe ; seul le SYMBOLE se choisit (options.icon), comme Airtable.
// Le rendu vit dans client/src/components/RatingStars.jsx ; ici les bornes et
// le vocabulaire des symboles.

export const RATING_MAX = 5

export const RATING_ICONS = ['star', 'heart', 'thumbs_up', 'flag', 'circle']

// Symbole d'un champ Évaluation ; 'star' à défaut (champs d'avant le réglage).
export function normalizeRatingIcon(icon) {
  return RATING_ICONS.includes(icon) ? icon : 'star'
}

// Valeur bornée à [0, max] pour l'AFFICHAGE. Tolère les fractions : un rollup
// « moyenne des notes » vaut 3,5 et se rend en étoile à moitié pleine.
// `null` si ce n'est pas un nombre (cellule vide, texte).
export function clampRating(value, max = RATING_MAX) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(max, n))
}

// Valeur à STOCKER : entier 0..max (une note se donne en étoiles entières),
// `null` pour vider la cellule.
export function normalizeRating(value, max = RATING_MAX) {
  const n = clampRating(value, max)
  return n == null ? null : Math.round(n)
}
