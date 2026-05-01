import { useState, useEffect, useCallback } from 'react'
import api from './api.js'

// Hook qui charge la liste des champs custom actifs pour une table.
// Retourne { fields, reload, setFields } pour les mises à jour optimistes.
export function useCustomFields(erpTable) {
  const [fields, setFields] = useState([])
  const reload = useCallback(() => {
    return api.customFields.list(erpTable)
      .then(d => setFields(d.data || []))
      .catch(() => setFields([]))
  }, [erpTable])
  useEffect(() => { reload() }, [reload])
  return { fields, reload, setFields }
}
