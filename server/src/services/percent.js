// Champs « Pourcentage » — miroir serveur de client/src/lib/percent.js.
//
// La colonne stocke le NOMBRE DE POURCENTS, pas une fraction : 45 vaut 45 %.
// C'est ce que l'utilisateur tape, ce que la barre de totaux additionne, et ce
// qu'un champ nombre converti en pourcentage garde tel quel — un stockage en
// fraction (0,45) obligerait à multiplier par 100 partout et ferait mentir
// toutes les valeurs déjà en base au changement de type.
//
// Le TYPE dit la nature de la donnée ; le mode d'AFFICHAGE dit comment elle se
// montre : « 45 % », ou une barre de progression remplie à 45 %.

export const PERCENT_DISPLAYS = ['percent', 'bar']

export function normalizePercentDisplay(display) {
  return PERCENT_DISPLAYS.includes(display) ? display : 'percent'
}

// « 45 % » — virgule décimale et espace insécable (convention fr-CA, écrit en
// échappement \u00a0 : un caractère invisible dans le code est illisible).
// `decimals` borné 0..5 ; null = pas d'arrondi, la valeur telle quelle, ce que
// veut la conversion de type (elle ne doit rien perdre en chemin).
// Retourne null si la valeur n'est pas un nombre.
export function formatPercent(value, decimals = 0) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const d = Number.isInteger(decimals) ? Math.max(0, Math.min(5, decimals)) : null
  const body = d == null ? String(n) : n.toFixed(d)
  return `${body.replace('.', ',')}\u00a0%`
}
