// Notes en étoiles (type de champ « Évaluation »).
//
// La valeur stockée est un NOMBRE entier de 0 à 5 — 0 (ou NULL) = pas de note.
// Rien d'autre : pas d'échelle configurable, pas d'icône au choix. Le rendu vit
// dans components/RatingStars.jsx ; ici seulement les bornes, partagées par le
// tableau (collage, fill-down), les fiches et les formulaires.
//
// Miroir de server/src/services/rating.js — tenir les deux alignés.

export const RATING_MAX = 5

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

// Note lisible pour une infobulle : « 3/5 », « 3,5/5 » pour une moyenne.
export function formatRating(value, max = RATING_MAX) {
  const n = clampRating(value, max)
  if (n == null) return null
  const rounded = Math.round(n * 100) / 100
  return `${String(rounded).replace('.', ',')}/${max}`
}
