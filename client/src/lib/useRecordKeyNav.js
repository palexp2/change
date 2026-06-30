import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

// Navigation clavier entre enregistrements sur les fiches détail.
//   j / ↓ → enregistrement suivant
//   k / ↑ → enregistrement précédent
//
// `prev` et `next` sont des chemins (`/factures/123`) ou null quand il n'y a
// pas de voisin. On ne preventDefault que lorsqu'on navigue réellement : si le
// voisin est absent, la frappe (notamment ↑/↓) garde son comportement natif
// (scroll de la page).
//
// Même garde que les raccourcis globaux de Layout : on ignore les frappes
// pendant la saisie dans un champ, quand un modificateur est actif, ou quand un
// scanner code-barre est monté (window.__barcodeScannerActive).
export function useRecordKeyNav({ prev, next, enabled = true }) {
  const navigate = useNavigate()
  useEffect(() => {
    if (!enabled) return
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const ae = document.activeElement
      const tag = ae?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae?.isContentEditable) return
      if (window.__barcodeScannerActive) return
      const k = e.key
      if (k === 'k' || k === 'K' || k === 'ArrowUp') {
        if (prev) { e.preventDefault(); navigate(prev) }
      } else if (k === 'j' || k === 'J' || k === 'ArrowDown') {
        if (next) { e.preventDefault(); navigate(next) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next, enabled, navigate])
}
