import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from './auth.jsx'
import api from './api.js'
import { canonicalNavHidden, canonicalNavOrder } from './navItems.js'

// État partagé des préférences d'affichage du menu de gauche.
// `hidden` = liste de clés cachées (blacklist). Chargée au login, mutée par la
// page Paramètres, lue par la sidebar (Layout) → toggle instantané + autosave DB.
// `order` = ordre personnalisé { conteneur: [clés] }, muté par le glisser-déposer
// des sections/sous-sections dans la sidebar (même cycle : instantané + autosave).
const NavPrefsContext = createContext(null)

export function NavPrefsProvider({ children }) {
  const { user } = useAuth()
  const [hidden, setHiddenState] = useState([])
  const [order, setOrderState] = useState({})
  const [loaded, setLoaded] = useState(false)
  // Compteur d'écritures locales : le chargement initial peut résoudre APRÈS
  // une première modification (GET lent pendant le bootstrap) et écraserait
  // alors la valeur fraîche par l'état serveur d'avant. Toute réponse
  // antérieure à une écriture est ignorée.
  const writeSeq = useRef(0)

  useEffect(() => {
    let cancelled = false
    const seq = writeSeq.current
    if (!user) {
      setHiddenState([])
      setOrderState({})
      setLoaded(false)
      return
    }
    api.auth.getPreferences()
      .then((d) => {
        if (cancelled || writeSeq.current !== seq) return
        setHiddenState(Array.isArray(d?.nav_hidden) ? canonicalNavHidden(d.nav_hidden) : [])
        setOrderState(d?.nav_order && typeof d.nav_order === 'object' && !Array.isArray(d.nav_order) ? canonicalNavOrder(d.nav_order) : {})
        setLoaded(true)
      })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [user])

  const persist = useCallback((next) => {
    writeSeq.current += 1
    setHiddenState(next)
    api.auth.updatePreferences({ nav_hidden: next })
      .catch((err) => console.error('[navPrefs] échec sauvegarde:', err))
  }, [])

  const persistOrder = useCallback((next) => {
    writeSeq.current += 1
    setOrderState(next)
    api.auth.updatePreferences({ nav_order: next })
      .catch((err) => console.error('[navPrefs] échec sauvegarde ordre:', err))
  }, [])

  const isHidden = useCallback((key) => hidden.includes(key), [hidden])

  const toggle = useCallback((key) => {
    const next = hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key]
    persist(next)
  }, [hidden, persist])

  return (
    <NavPrefsContext.Provider value={{ hidden, isHidden, toggle, setHidden: persist, order, setOrder: persistOrder, loaded }}>
      {children}
    </NavPrefsContext.Provider>
  )
}

export function useNavPrefs() {
  const ctx = useContext(NavPrefsContext)
  // Hors provider (ex. pages publiques) : tout visible, no-op.
  if (!ctx) return { hidden: [], isHidden: () => false, toggle: () => {}, setHidden: () => {}, order: {}, setOrder: () => {}, loaded: true }
  return ctx
}
