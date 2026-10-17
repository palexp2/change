// Notes en étoiles — bornes communes dans shared/rating.mjs ; le rendu vit dans
// components/RatingStars.jsx.
import { RATING_MAX, clampRating } from '../../../shared/rating.mjs'
export { RATING_MAX, RATING_ICONS, clampRating, normalizeRating, normalizeRatingIcon } from '../../../shared/rating.mjs'

// Note lisible pour une infobulle : « 3/5 », « 3,5/5 » pour une moyenne.
export function formatRating(value, max = RATING_MAX) {
  const n = clampRating(value, max)
  if (n == null) return null
  const rounded = Math.round(n * 100) / 100
  return `${String(rounded).replace('.', ',')}/${max}`
}
