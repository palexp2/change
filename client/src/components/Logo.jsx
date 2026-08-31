/**
 * Marque Boréal — l'aiguille de la rose des vents : moitié pleine vers le nord,
 * moitié évidée vers le sud.
 *
 * Un seul tracé, en `currentColor` : la couleur vient du parent (`text-brand-600`),
 * ce qui la fait suivre le mode nuit sans variante à maintenir. Sous 20 px le trait
 * de la moitié sud s'épaissit — sinon il s'efface au rendu et la silhouette penche.
 *
 * Pour changer de marque (cf. planche /erp/boreal.html), il n'y a que NEEDLE à
 * remplacer : tout le reste de l'app passe par ce composant.
 */

const NEEDLE_NORTH = 'M24 3 L32 26 L24 21.5 L16 26 Z'
const NEEDLE_SOUTH = 'M24 45 L32 26 L24 30.5 L16 26 Z'

export function Logo({ size = 24, className = '', title = 'Boréal', ...rest }) {
  const stroke = size < 20 ? 3.4 : size < 28 ? 2.6 : 2.2
  return (
    <svg
      width={size} height={size} viewBox="0 0 48 48" fill="none"
      role="img" aria-label={title} className={className} {...rest}
    >
      <path d={NEEDLE_NORTH} fill="currentColor" />
      <path d={NEEDLE_SOUTH} stroke="currentColor" strokeWidth={stroke} strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Marque + mot, l'un contre l'autre. `word` porte l'interlettrage serré du
 * lockup de la planche ; la pile système suffit — pas de webfont chargée pour
 * un seul mot.
 */
export function LogoLockup({ size = 26, className = '', markClassName = 'text-brand-600', wordClassName = '' }) {
  return (
    <span className={`inline-flex items-center gap-2 min-w-0 ${className}`}>
      <Logo size={size} className={`flex-shrink-0 ${markClassName}`} />
      <span className={`font-semibold tracking-tight ${wordClassName}`}>Boréal</span>
    </span>
  )
}
