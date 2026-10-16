import { createContext, useContext } from 'react'

// Format d'un champ réglé dans « Modifier le champ » (type, décimales…), posé
// par la fiche autour de l'éditeur de la page : les éditeurs partagés
// (InlineNumber…) s'y conforment quand l'appelant ne fixe rien lui-même.
export const FieldFormatContext = createContext(null)

export function useFieldFormat() {
  return useContext(FieldFormatContext)
}
