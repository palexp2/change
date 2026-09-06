import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { fmtNumber } from '../utils/formatters.js'
import { useAuth } from './auth.jsx'
import api from './api.js'

// Préférences d'affichage des décimales par colonne numérique.
// Map { "<table>::<field>": <0-5> } chargée au login, lue par DataTable pour
// formater les cellules type:'number', mutée par la page Paramètres → Affichage.
const DecimalPrefsContext = createContext(null)

// Clé canonique d'une colonne. `table` peut être undefined (DataTable sans prop
// table) → on retombe sur le seul field, ce qui reste cohérent entre lecture et
// écriture tant que l'appelant passe les mêmes arguments.
export function decimalKey(table, field) {
  return `${table || ''}::${field}`
}

// Formate une valeur numérique avec un nombre fixe de décimales (fr-CA).
// Renvoie null si la valeur n'est pas un nombre fini → l'appelant garde le
// rendu brut. `decimals` null/undefined => pas de formatage.
export function formatDecimals(value, decimals) {
  if (decimals == null) return null
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return fmtNumber(n, { decimals })
}

export function DecimalPrefsProvider({ children }) {
  const { user } = useAuth()
  const [prefs, setPrefsState] = useState({})
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!user) {
      setPrefsState({})
      setLoaded(false)
      return
    }
    api.auth.getPreferences()
      .then((d) => {
        if (cancelled) return
        const p = d?.decimal_preferences
        setPrefsState(p && typeof p === 'object' && !Array.isArray(p) ? p : {})
        setLoaded(true)
      })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [user])

  const persist = useCallback((next) => {
    setPrefsState(next)
    api.auth.updatePreferences({ decimal_preferences: next })
      .catch((err) => console.error('[decimalPrefs] échec sauvegarde:', err))
  }, [])

  // Renvoie le nombre de décimales configuré pour (table, field), ou null si
  // aucune préférence (rendu brut conservé).
  const getDecimals = useCallback((table, field) => {
    if (!field) return null
    const v = prefs[decimalKey(table, field)]
    return Number.isInteger(v) ? v : null
  }, [prefs])

  // Définit (ou supprime si value == null) le nombre de décimales pour une colonne.
  const setDecimals = useCallback((table, field, value) => {
    const key = decimalKey(table, field)
    const next = { ...prefs }
    if (value == null) delete next[key]
    else next[key] = value
    persist(next)
  }, [prefs, persist])

  return (
    <DecimalPrefsContext.Provider value={{ prefs, getDecimals, setDecimals, loaded }}>
      {children}
    </DecimalPrefsContext.Provider>
  )
}

export function useDecimalPrefs() {
  const ctx = useContext(DecimalPrefsContext)
  // Hors provider (ex. pages publiques) : pas de formatage, no-op.
  if (!ctx) return { prefs: {}, getDecimals: () => null, setDecimals: () => {}, loaded: true }
  return ctx
}
