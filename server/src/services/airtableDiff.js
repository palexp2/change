// Comparaison de ce qui est DÉJÀ en base avec ce qu'un sync s'apprête à
// écrire. Partagée par les deux écritures différentielles du miroir Airtable :
// les colonnes « cœur » (airtableMirrorEngine.differentialUpsert) et les champs
// dynamiques (airtableAutoSync.updateDynamicFields).
//
// Volontairement stricte sur les types : SQLite rend un INTEGER pour une
// colonne entière, et `0 == '0'` en JS masquerait un vrai changement de type.
// On normalise donc les deux côtés de la même façon avant de comparer.
export function sameStored(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined
  if (b === null || b === undefined) return false
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a)
    const nb = Number(b)
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb
  }
  return String(a) === String(b)
}
