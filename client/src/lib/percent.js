// Champs « Pourcentage » — logique commune dans shared/percent.mjs ; ici
// seulement ce qui ne sert qu'à l'écran.
export { PERCENT_DISPLAYS, normalizePercentDisplay, formatPercent } from '../../../shared/percent.mjs'

// Remplissage d'une barre de progression, en pourcents bornés 0..100 : une
// valeur négative ne remplit rien, au-delà de 100 la barre est pleine (la
// valeur exacte, elle, reste lisible en infobulle). null si pas un nombre.
export function percentFill(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, n))
}
