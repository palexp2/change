import { useState, useEffect } from 'react'
import api from './api.js'

// Hook : retourne un Map<column_name, { airtable_field_name }> des colonnes
// dont l'import Airtable est désactivé via la modale de sync.
// `null` tant que pas chargé (pour distinguer "pas encore chargé" de "vide").
export function useDisabledColumns(erpTable) {
  const [disabled, setDisabled] = useState(null)
  useEffect(() => {
    let cancelled = false
    api.airtable.disabledColumns(erpTable)
      .then(d => {
        if (cancelled) return
        const m = new Map()
        for (const r of (d.columns || [])) {
          if (r.column_name && r.column_name !== '__pending__') {
            m.set(r.column_name, { airtable_field_name: r.airtable_field_name })
          }
        }
        setDisabled(m)
      })
      .catch(() => { if (!cancelled) setDisabled(new Map()) })
    return () => { cancelled = true }
  }, [erpTable])
  return disabled
}
