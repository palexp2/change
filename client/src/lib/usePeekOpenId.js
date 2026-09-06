import { useState, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'

// Ouverture programmée du side-peek depuis une fiche plein écran : le bouton
// « revenir au panneau latéral » navigue vers la liste avec
// `state: { peekId: id }`. La liste lit l'id une fois, l'ouvre dans le drawer
// puis nettoie l'entrée d'historique pour qu'un rafraîchissement ou un retour
// arrière ne le rouvre pas.
//
// Usage :
//   const { peekOpenId, consumePeekOpen } = usePeekOpenId()
//   <DataTable peek={{ …, openId: peekOpenId, onOpenConsumed: consumePeekOpen }} />
export function usePeekOpenId() {
  const navigate = useNavigate()
  const location = useLocation()
  const [peekOpenId, setPeekOpenId] = useState(() => location.state?.peekId ?? null)
  const consumePeekOpen = useCallback(() => {
    setPeekOpenId(null)
    navigate(location.pathname + location.search, { replace: true, state: null })
  }, [navigate, location.pathname, location.search])
  return { peekOpenId, consumePeekOpen }
}

export default usePeekOpenId
