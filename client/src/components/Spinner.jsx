/**
 * Spinner réutilisable : indicateur de chargement homogène pour toute l'app.
 *
 * Remplace les `<div className="animate-spin rounded-full …" />` dupliqués dans
 * les fiches détail et les `<div>Chargement…</div>` en texte brut sans feedback
 * visuel. Complète <EmptyState> (états vides) côté états de chargement.
 *
 * Props :
 *  - size       : 'xs' | 'sm' | 'md' | 'lg' (défaut 'md') — diamètre du cercle
 *  - color      : 'brand' | 'white' | 'slate' | 'emerald' (défaut 'brand')
 *  - label      : texte optionnel affiché à côté du cercle (ex. « Chargement… »)
 *  - center     : true → centre le spinner dans une zone h-64 (loader de page détail)
 *  - fullscreen : true → centre le spinner en plein écran (min-h-screen, pages publiques)
 *  - className  : classes supplémentaires sur le conteneur
 *
 * Exemples :
 *  <Spinner center />                          // loader de fiche détail
 *  <Spinner center label="Chargement…" />      // loader avec libellé
 *  <Spinner size="sm" color="white" />         // dans un bouton
 *  <Spinner fullscreen label="Chargement…" />  // page publique plein écran
 */
const SIZES = {
  xs: 'h-3.5 w-3.5',
  sm: 'h-5 w-5',
  md: 'h-8 w-8',
  lg: 'h-10 w-10',
}
const COLORS = {
  brand: 'border-brand-600',
  white: 'border-white',
  slate: 'border-slate-500',
  emerald: 'border-emerald-600',
}

export default function Spinner({
  size = 'md',
  color = 'brand',
  label,
  center = false,
  fullscreen = false,
  className = '',
}) {
  const circle = (
    <span
      data-testid="spinner"
      aria-hidden="true"
      className={`inline-block animate-spin rounded-full border-b-2 ${SIZES[size] || SIZES.md} ${COLORS[color] || COLORS.brand}`}
    />
  )

  if (center || fullscreen) {
    return (
      <div
        role="status"
        aria-label={label || 'Chargement…'}
        className={`flex items-center justify-center gap-3 ${fullscreen ? 'min-h-screen' : 'h-64'} ${className}`}
      >
        {circle}
        {label && <span className="text-sm text-slate-400">{label}</span>}
        {!label && <span className="sr-only">Chargement…</span>}
      </div>
    )
  }

  if (label) {
    return (
      <span role="status" className={`inline-flex items-center gap-2 text-sm text-slate-400 ${className}`}>
        {circle}
        <span>{label}</span>
      </span>
    )
  }

  return (
    <span role="status" className={className}>
      {circle}
      <span className="sr-only">Chargement…</span>
    </span>
  )
}
