import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useAuth } from './auth.jsx'
import api from './api.js'

// État partagé des préférences d'affichage du menu de gauche.
// `hidden` = liste de clés cachées (blacklist). Chargée au login, mutée par la
// page Paramètres, lue par la sidebar (Layout) → toggle instantané + autosave DB.
const NavPrefsContext = createContext(null)

export function NavPrefsProvider({ children }) {
  const { user } = useAuth()
  const [hidden, setHiddenState] = useState([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!user) {
      setHiddenState([])
      setLoaded(false)
      return
    }
    api.auth.getPreferences()
      .then((d) => {
        if (cancelled) return
        setHiddenState(Array.isArray(d?.nav_hidden) ? d.nav_hidden : [])
        setLoaded(true)
      })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [user])

  const persist = useCallback((next) => {
    setHiddenState(next)
    api.auth.updatePreferences({ nav_hidden: next })
      .catch((err) => console.error('[navPrefs] échec sauvegarde:', err))
  }, [])

  const isHidden = useCallback((key) => hidden.includes(key), [hidden])

  const toggle = useCallback((key) => {
    const next = hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key]
    persist(next)
  }, [hidden, persist])

  return (
    <NavPrefsContext.Provider value={{ hidden, isHidden, toggle, setHidden: persist, loaded }}>
      {children}
    </NavPrefsContext.Provider>
  )
}

export function useNavPrefs() {
  const ctx = useContext(NavPrefsContext)
  // Hors provider (ex. pages publiques) : tout visible, no-op.
  if (!ctx) return { hidden: [], isHidden: () => false, toggle: () => {}, setHidden: () => {}, loaded: true }
  return ctx
}
