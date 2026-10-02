// Champs « Pourcentage » — miroir de server/src/services/percent.js.
//
// La colonne stocke le NOMBRE DE POURCENTS, pas une fraction : 45 vaut 45 %.
// C'est ce que l'utilisateur tape dans la cellule, ce que la barre de totaux
// additionne, et ce qu'un champ nombre passé en pourcentage garde tel quel.
//
// Le TYPE dit la nature de la donnée ; le mode d'AFFICHAGE dit comment elle se
// montre — « 45 % », ou une barre de progression remplie à 45 %.

export const PERCENT_DISPLAYS = ['percent', 'bar']

export function normalizePercentDisplay(display) {
  return PERCENT_DISPLAYS.includes(display) ? display : 'percent'
}

// « 45 % » — virgule décimale et espace insécable (fr-CA). `decimals` borné
// 0..5, `null` = valeur telle quelle. Retourne null si ce n'est pas un nombre.
export function formatPercent(value, decimals = 0) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const d = Number.isInteger(decimals) ? Math.max(0, Math.min(5, decimals)) : null
  const body = d == null ? String(n) : n.toFixed(d)
  return `${body.replace('.', ',')}\u00a0%`
}

// Remplissage d'une barre de progression, en pourcents bornés 0..100 : une
// valeur négative ne remplit rien, au-delà de 100 la barre est pleine (la
// valeur exacte, elle, reste lisible en infobulle). null si pas un nombre.
export function percentFill(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, n))
}

