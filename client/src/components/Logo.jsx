/**
 * Marque Boréal — l'épinette : trois étages de branches et un tronc, en
 * silhouette pleine.
 *
 * Un seul tracé, en `currentColor` : la couleur vient du parent (`text-brand-600`),
 * ce qui la fait suivre le mode nuit sans variante à maintenir. Les décrochés
 * entre étages font 5,5 unités sur 48 — assez larges pour rester lisibles à
 * 17 px dans le rail, où un pleine-silhouette tient mieux qu'un trait fin.
 *
 * Pour changer de marque (cf. planche /erp/boreal.html), il n'y a que SPRUCE à
 * remplacer : tout le reste de l'app passe par ce composant. Le favicon
 * (`client/public/boreal.svg`) porte le même tracé, en vert de marque en dur.
 */

const SPRUCE = [
  'M24 4',
  'L31.5 18 L26 18 L35 29 L29 29 L39 40',
  'L26 40 L26 45.5 L22 45.5 L22 40',
  'L9 40 L19 29 L13 29 L22 18 L16.5 18',
  'Z',
].join(' ')

export function Logo({ size = 24, className = '', title = 'Boréal', ...rest }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 48 48" fill="none"
      role="img" aria-label={title} className={className} {...rest}
    >
      <path d={SPRUCE} fill="currentColor" strokeLinejoin="round" />
    </svg>
  )
}
