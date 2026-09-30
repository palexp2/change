/**
 * Spinner réutilisable : indicateur de chargement homogène pour toute l'app
 * (une Thinking Orb, voir ThinkingOrb.jsx).
 *
 * Remplace les `<div className="animate-spin rounded-full …" />` dupliqués dans
 * les fiches détail et les `<div>Chargement…</div>` en texte brut sans feedback
 * visuel. Complète <EmptyState> (états vides) côté états de chargement.
 *
 * Props :
 *  - size       : 'xs' | 'sm' | 'md' | 'lg' (défaut 'md') — diamètre de l'orbe
 *  - color      : 'brand' | 'white' (défaut 'brand') — 'white' = couleur du texte hôte
 *  - state      : état Thinking Orb (défaut 'breathing')
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
import ThinkingOrb from './ThinkingOrb'

// Diamètre en px de l'orbe par taille.
const SIZES = { xs: 14, sm: 20, md: 32, lg: 40 }

export default function Spinner({
  size = 'md',
  color = 'brand',
  label,
  center = false,
  fullscreen = false,
  className = '',
  state = 'breathing',
}) {
  // `white` = posé sur un bouton plein : l'orbe prend la couleur du texte.
  const circle = (
    <span data-testid="spinner" aria-hidden="true" className={`inline-flex ${color === 'white' ? 'text-white' : ''}`}>
      <ThinkingOrb state={state} size={SIZES[size] || SIZES.md} ink={color === 'white'} />
    </span>
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
