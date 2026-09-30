import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

export const MOBILE_CAPTURE_HOME = '/sale-receipts?capture=camera'

export function isPhoneScreen() {
  return window.matchMedia('(pointer: coarse) and (max-width: 767px), (pointer: coarse) and (max-height: 500px)').matches
}

// Les anciens raccourcis peuvent viser l'accueil ordinateur. Ne traiter que
// l'entrée dans l'app : un clic dans le menu doit toujours ouvrir sa destination.
const HOME_PATHS = new Set(['/', '/dashboard', '/travaux'])

export function useMobileCaptureHome({ user, isLoading }) {
  const location = useLocation()
  const navigate = useNavigate()
  const entered = useRef(false)
  const wasHidden = useRef(document.visibilityState === 'hidden')

  useEffect(() => {
    if (isLoading) return
    const initialEntry = !entered.current
    entered.current = true
    if (!user || !isPhoneScreen()) return

    const plainHome = !location.search && !location.hash && HOME_PATHS.has(location.pathname)
    if (initialEntry && plainHome) navigate(MOBILE_CAPTURE_HOME, { replace: true })

    function resume() {
      if (document.visibilityState !== 'visible' || !wasHidden.current) return
      wasHidden.current = false
      // L'OS peut reprendre l'onglet sans remonter React ni repasser par /.
      const receiptsHome = location.pathname === '/sale-receipts' && !location.search && !location.hash
      if (!plainHome && !receiptsHome) return
      // Garder une photo, un téléversement ou une saisie en cours, notamment
      // lors d'un aller-retour vers les permissions ou le sélecteur de fichiers.
      const active = document.activeElement
      if (document.querySelector('[aria-modal="true"]') || active?.isContentEditable
        || active?.matches('input, textarea, select')) return
      navigate(MOBILE_CAPTURE_HOME, { replace: true })
    }
    function hide() { wasHidden.current = true }
    function visibility() {
      if (document.visibilityState === 'hidden') hide()
      else resume()
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', hide)
    window.addEventListener('pageshow', resume)
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', hide)
      window.removeEventListener('pageshow', resume)
    }
  }, [user, isLoading, location.pathname, location.search, location.hash, navigate])
}
