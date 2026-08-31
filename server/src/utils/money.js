// Arrondi monétaire à 2 décimales — helper partagé (le corps était recopié
// dans une trentaine de fichiers).
//
// Deux variantes aux sémantiques distinctes, à ne PAS fusionner :
//  • round2(n)     : arrondi brut — NaN/undefined restent NaN (l'appelant a
//                    déjà validé son nombre, une valeur invalide doit se voir).
//  • round2Safe(n) : coercition d'abord — null/undefined/NaN/'' → 0. Pour les
//                    champs libres (extractions, colonnes optionnelles) où
//                    « absent » veut dire zéro.
export function round2(n) {
  return Math.round(n * 100) / 100
}

export function round2Safe(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}
