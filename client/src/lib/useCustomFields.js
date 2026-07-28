import { useState, useEffect, useCallback } from 'react'
import api from './api.js'

// Hook qui charge la liste des champs custom actifs pour une table.
// Retourne { fields, loaded, reload, setFields } pour les mises à jour optimistes.
// `erpTable` falsy → pas de fetch (permet un usage conditionnel du hook).
//
// `loaded` : false tant que le premier fetch n'a pas résolu, true ensuite (y
// compris si la table n'a aucun champ custom). Load-bearing pour distinguer
// « champs pas encore chargés » (Map vide transitoire) de « chargé, 0 champ » —
// sans quoi l'auto-affichage des nouveaux champs dans DataTable prend le vide
// initial pour une baseline et ré-ajoute tous les champs masqués au chargement.
export function useCustomFields(erpTable) {
  const [fields, setFields] = useState([])
  const [loaded, setLoaded] = useState(false)
  const reload = useCallback(() => {
    if (!erpTable) { setFields([]); setLoaded(true); return Promise.resolve() }
    return api.customFields.list(erpTable)
      .then(d => setFields(d.data || []))
      .catch(() => setFields([]))
      .finally(() => setLoaded(true))
  }, [erpTable])
  useEffect(() => { reload() }, [reload])
  return { fields, loaded, reload, setFields }
}
