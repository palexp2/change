import { useState } from 'react'
import { Star } from 'lucide-react'
import { RATING_MAX, clampRating, formatRating } from '../lib/rating.js'

// Rendu d'une note en étoiles — le seul, partagé par les tableaux, les fiches
// et les formulaires (cf. lib/rating.js).
//
// Lecture (`RatingStars`) : uniquement les étoiles GAGNÉES, comme Airtable —
// cinq étoiles grises sur chaque ligne d'un tableau feraient du bruit pour rien.
// `showEmpty` affiche l'échelle complète (utile hors tableau). Une valeur
// fractionnaire (moyenne d'un rollup) remplit la dernière étoile en partie.
export function RatingStars({ value, max = RATING_MAX, size = 14, showEmpty = false, className = '' }) {
  const v = clampRating(value, max) ?? 0
  if (!v && !showEmpty) return <span className="text-slate-300">—</span>
  const stars = []
  for (let i = 0; i < max; i++) {
    const fill = Math.max(0, Math.min(1, v - i))
    if (fill === 0 && !showEmpty) break
    stars.push(
      fill >= 1
        ? <Star key={i} size={size} strokeWidth={1.5} fill="currentColor" className="text-amber-400 flex-shrink-0" />
        : fill === 0
          ? <Star key={i} size={size} strokeWidth={1.5} className="text-slate-300 flex-shrink-0" />
          : (
            // Étoile partielle : l'étoile pleine est rognée à la fraction
            // atteinte, par-dessus le contour gris.
            <span key={i} className="relative inline-flex flex-shrink-0" style={{ width: size, height: size }}>
              <Star size={size} strokeWidth={1.5} className="text-slate-300" />
              <span className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>
                <Star size={size} strokeWidth={1.5} fill="currentColor" className="text-amber-400" />
              </span>
            </span>
          )
    )
  }
  return (
    <span
      className={`inline-flex items-center gap-0.5 align-middle ${className}`}
      title={formatRating(v, max)}
      data-rating={v}
    >
      {stars}
    </span>
  )
}

// Saisie d'une note : l'échelle complète, survol en aperçu, clic sur l'étoile
// courante pour retirer la note.
export function RatingInput({ value, max = RATING_MAX, size = 16, disabled = false, onChange, testId, className = '' }) {
  const [hover, setHover] = useState(0)
  const v = Math.round(clampRating(value, max) ?? 0)
  const shown = hover || v
  return (
    <span
      className={`inline-flex items-center gap-0.5 ${className}`}
      onMouseLeave={() => setHover(0)}
      data-testid={testId}
      data-rating={v}
    >
      {Array.from({ length: max }, (_, i) => i + 1).map(n => (
        <button
          key={n}
          type="button"
          disabled={disabled}
          title={n === v ? 'Retirer la note' : formatRating(n, max)}
          aria-label={formatRating(n, max)}
          onMouseEnter={() => setHover(n)}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onChange?.(n === v ? 0 : n) }}
          className="p-0.5 leading-none disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Star
            size={size}
            strokeWidth={1.5}
            fill={n <= shown ? 'currentColor' : 'none'}
            className={n <= shown ? 'text-amber-400' : 'text-slate-300'}
          />
        </button>
      ))}
    </span>
  )
}
