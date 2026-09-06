import { useRef } from 'react'

// Poignée de redimensionnement de colonne (esprit Airtable) : bande de 1.5px
// collée au bord droit de l'en-tête, invisible au repos, teintée au survol.
// Le parent doit être positionné (`relative`) et porter `group/header` pour
// que la bande se révèle au survol de l'en-tête entier.
// `onResize(px)` est appelé en continu pendant le drag ; la largeur de départ
// est lue sur l'élément parent, donc aucune mesure n'est nécessaire côté appelant.
// `onResizeStart()` est appelé une fois, avant toute mesure, pour laisser
// l'appelant figer la mise en page (ex. largeurs fluides voisines).
export function ResizeHandle({ onResize, onResizeStart, minWidth = 50 }) {
  const startX = useRef(0)
  const startW = useRef(0)

  function onPointerDown(e) {
    e.preventDefault()
    e.stopPropagation()
    onResizeStart?.()
    startX.current = e.clientX
    startW.current = e.currentTarget.parentElement.offsetWidth
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e) {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const delta = e.clientX - startX.current
    const newW = Math.max(minWidth, startW.current + delta)
    onResize(newW)
  }

  function onPointerUp(e) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  return (
    <div
      className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 bg-transparent group-hover/header:bg-slate-200 hover:!bg-brand-400 active:!bg-brand-500"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

export default ResizeHandle
