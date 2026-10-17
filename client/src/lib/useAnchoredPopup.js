// Popup ancrée sous (ou au-dessus d') un bouton, rendue en portail : position
// fixe calculée à l'ouverture, fermeture au clic hors bouton/popup. Partagée par
// les pickers maison (codes d'activité, feuille de temps).
import { useEffect, useRef, useState } from 'react'

const POPUP_H = 280

function anchoredPos(rect) {
  const spaceBelow = window.innerHeight - rect.bottom
  const openUp = spaceBelow < POPUP_H && rect.top > POPUP_H
  return {
    top: openUp ? rect.top - POPUP_H - 4 : rect.bottom + 4,
    left: rect.left,
    width: Math.max(rect.width, 240),
  }
}

// `onClose` : appelé au clic extérieur. `track` : suit le défilement / redimensionnement.
export function useAnchoredPopup({ open, btnRef, popupRef, onClose, track = false }) {
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 })
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return
    const reposition = () => {
      const rect = btnRef.current?.getBoundingClientRect()
      if (rect) setPos(anchoredPos(rect))
    }
    reposition()
    const onDown = (e) => {
      if (!btnRef.current?.contains(e.target) && !popupRef.current?.contains(e.target)) closeRef.current()
    }
    document.addEventListener('mousedown', onDown)
    if (track) {
      window.addEventListener('scroll', reposition, true)
      window.addEventListener('resize', reposition)
    }
    return () => {
      document.removeEventListener('mousedown', onDown)
      if (track) {
        window.removeEventListener('scroll', reposition, true)
        window.removeEventListener('resize', reposition)
      }
    }
  }, [open, track, btnRef, popupRef])
  return pos
}

// Menu déroulant (SearchableSelect, MultiSelectField) : recalcul de la position
// à l'ouverture et au reflow, fermeture au clic hors bouton / hors portail.
export function useMenuDismiss({ open, btnRef, portalId, computePos, onClose }) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return
    computePos()
    function onDown(e) {
      if (!btnRef.current?.contains(e.target) && !document.getElementById(portalId)?.contains(e.target)) closeRef.current()
    }
    function onReflow() { computePos() }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onReflow, true)
    window.addEventListener('resize', onReflow)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onReflow, true)
      window.removeEventListener('resize', onReflow)
    }
  }, [open, computePos, portalId, btnRef])
}
