import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from './auth.jsx'
import api from './api.js'
import { canonicalNavHidden, canonicalNavOrder } from './navItems.js'

// État partagé des préférences d'affichage du menu de gauche.
// `hidden` = liste de clés cachées (blacklist). Chargée au login, mutée par la
// page Paramètres, lue par la sidebar (Layout) → toggle instantané + autosave DB.
// `order` = ordre personnalisé { conteneur: [clés] }, muté par le glisser-déposer
// des sections/sous-sections dans la sidebar (même cycle : instantané + autosave).
// `bookmarks` = pages épinglées [{ to, label }], montrées sous l'icône du
// tableau de bord (même cycle).
const NavPrefsContext = createContext(null)

const cleanBookmarks = (list) => (Array.isArray(list) ? list : [])
  .filter(b => b && typeof b.to === 'string')
  .map(b => ({ to: b.to, label: typeof b.label === 'string' && b.label ? b.label : b.to }))

export function NavPrefsProvider({ children }) {
  const { user } = useAuth()
  const [hidden, setHiddenState] = useState([])
  const [order, setOrderState] = useState({})
  const [bookmarks, setBookmarksState] = useState([])
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
      setBookmarksState([])
      setLoaded(false)
      return
    }
    api.auth.getPreferences()
      .then((d) => {
        if (cancelled || writeSeq.current !== seq) return
        setHiddenState(Array.isArray(d?.nav_hidden) ? canonicalNavHidden(d.nav_hidden) : [])
        setOrderState(d?.nav_order && typeof d.nav_order === 'object' && !Array.isArray(d.nav_order) ? canonicalNavOrder(d.nav_order) : {})
        setBookmarksState(cleanBookmarks(d?.nav_bookmarks))
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

  const persistBookmarks = useCallback((next) => {
    writeSeq.current += 1
    setBookmarksState(next)
    api.auth.updatePreferences({ nav_bookmarks: next })
      .catch((err) => console.error('[navPrefs] échec sauvegarde signets:', err))
  }, [])

  const isBookmarked = useCallback((to) => bookmarks.some(b => b.to === to), [bookmarks])

  // Épingle la page (ou la retire si elle l'est déjà). Nouveau signet en fin de
  // liste : l'ordre des signets est celui où on les a posés.
  const toggleBookmark = useCallback(({ to, label }) => {
    if (!to) return
    persistBookmarks(bookmarks.some(b => b.to === to)
      ? bookmarks.filter(b => b.to !== to)
      : [...bookmarks, { to, label: label || to }])
  }, [bookmarks, persistBookmarks])

  const isHidden = useCallback((key) => hidden.includes(key), [hidden])

  const toggle = useCallback((key) => {
    const next = hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key]
    persist(next)
  }, [hidden, persist])

  return (
    <NavPrefsContext.Provider value={{
      hidden, isHidden, toggle, setHidden: persist,
      order, setOrder: persistOrder,
      bookmarks, isBookmarked, toggleBookmark, setBookmarks: persistBookmarks,
      loaded,
    }}>
      {children}
    </NavPrefsContext.Provider>
  )
}

export function useNavPrefs() {
  const ctx = useContext(NavPrefsContext)
  // Hors provider (ex. pages publiques) : tout visible, no-op.
  if (!ctx) return {
    hidden: [], isHidden: () => false, toggle: () => {}, setHidden: () => {},
    order: {}, setOrder: () => {},
    bookmarks: [], isBookmarked: () => false, toggleBookmark: () => {}, setBookmarks: () => {},
    loaded: true,
  }
  return ctx
}
