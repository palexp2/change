// Notes en étoiles (type de champ « Évaluation »).
//
// La colonne porte un ENTIER de 0 à 5 (0 / NULL = pas de note). Échelle fixe :
// pas d'option de champ, rien à normaliser côté `options`.
//
// Miroir de client/src/lib/rating.js — tenir les deux alignés.

export const RATING_MAX = 5

// Valeur bornée à [0, max], fractions tolérées (moyenne d'un rollup).
// `null` si ce n'est pas un nombre.
export function clampRating(value, max = RATING_MAX) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(max, n))
}

// Valeur à STOCKER : entier 0..max, ou `null` pour vider.
export function normalizeRating(value, max = RATING_MAX) {
  const n = clampRating(value, max)
  return n == null ? null : Math.round(n)
}

export default { RATING_MAX, clampRating, normalizeRating }
