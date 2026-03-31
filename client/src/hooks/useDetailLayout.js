import { useState, useEffect, useMemo, useCallback } from 'react'
import api from '../lib/api.js'

/**
 * Hook for admin-configurable detail page field layouts.
 *
 * @param {string} entityType - e.g. 'companies', 'contacts', 'orders', 'tickets', 'products'
 * @param {Array} allFields - all available fields: [{ key, label, defaultVisible?, section? }]
 * @returns {{ visibleFields, allFields, isConfiguring, setConfiguring, saveLayout, moveField, toggleField }}
 */
export function useDetailLayout(entityType, allFields) {
  const [fieldOrder, setFieldOrder] = useState(null) // null = not loaded, [] = use defaults
  const [loaded, setLoaded] = useState(false)
  const [isConfiguring, setConfiguring] = useState(false)

  useEffect(() => {
    api.views.getDetailLayout(entityType)
      .then(({ field_order }) => {
        setFieldOrder(field_order) // null if no config saved
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [entityType])

  // Build the ordered + filtered list of visible fields
  const visibleFields = useMemo(() => {
    if (!loaded) return []
    if (!fieldOrder) {
      // No config saved — show all fields with defaultVisible !== false
      return allFields.filter(f => f.defaultVisible !== false)
    }
    // Config exists — return fields in saved order, only visible ones
    const fieldMap = new Map(allFields.map(f => [f.key, f]))
    return fieldOrder
      .filter(fo => fo.visible)
      .map(fo => fieldMap.get(fo.key))
      .filter(Boolean)
  }, [loaded, fieldOrder, allFields])

  // For the config panel: all fields with their current visibility + order
  const configFields = useMemo(() => {
    if (!loaded) return []
    if (!fieldOrder) {
      return allFields.map(f => ({
        key: f.key,
        label: f.label,
        visible: f.defaultVisible !== false,
      }))
    }
    const fieldMap = new Map(allFields.map(f => [f.key, f]))
    const ordered = fieldOrder
      .map(fo => {
        const def = fieldMap.get(fo.key)
        return def ? { key: fo.key, label: def.label, visible: fo.visible } : null
      })
      .filter(Boolean)
    // Add any new fields not yet in the config
    const inConfig = new Set(fieldOrder.map(fo => fo.key))
    for (const f of allFields) {
      if (!inConfig.has(f.key)) {
        ordered.push({ key: f.key, label: f.label, visible: false })
      }
    }
    return ordered
  }, [loaded, fieldOrder, allFields])

  const toggleField = useCallback((key) => {
    setFieldOrder(prev => {
      const current = prev || allFields.map(f => ({ key: f.key, visible: f.defaultVisible !== false }))
      return current.map(fo => fo.key === key ? { ...fo, visible: !fo.visible } : fo)
    })
  }, [allFields])

  const moveField = useCallback((fromIndex, toIndex) => {
    setFieldOrder(prev => {
      const current = prev || allFields.map(f => ({ key: f.key, visible: f.defaultVisible !== false }))
      const next = [...current]
      const [item] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, item)
      return next
    })
  }, [allFields])

  const saveLayout = useCallback(async () => {
    const order = fieldOrder || allFields.map(f => ({ key: f.key, visible: f.defaultVisible !== false }))
    await api.views.saveDetailLayout(entityType, order)
    setConfiguring(false)
  }, [entityType, fieldOrder, allFields])

  return {
    visibleFields,
    configFields,
    loaded,
    isConfiguring,
    setConfiguring,
    saveLayout,
    moveField,
    toggleField,
  }
}
