import { createContext, useContext, useCallback } from 'react'
import { translate } from './discoveryFormI18n.js'

// Langue du formulaire public, lue par la page et ses choix illustrés. Hors du
// formulaire public (fiche interne, éditeur), le défaut reste le français.
export const DiscoveryLangContext = createContext('fr')

export function useDiscoveryLang() {
  return useContext(DiscoveryLangContext)
}

export function useDiscoveryTr() {
  const lang = useContext(DiscoveryLangContext)
  return useCallback(fr => translate(lang, fr), [lang])
}
