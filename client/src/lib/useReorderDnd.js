import { useState, useRef, useCallback } from 'react'

/**
 * Réordonnancement d'une liste : glisser-déposer + flèches d'un cran, partagés
 * par la file de prompts, le carnet d'idées (page Travaux) et l'éditeur de
 * champs des fiches (DetailFieldGrid).
 *
 * `siblingsOf(id)` renvoie les ids entre lesquels l'item peut se déplacer (le
 * groupe pour la file, la liste entière pour les idées) — un drop hors de ces
 * voisins est ignoré. `applyOrder(nextIds, id)` persiste le nouvel ordre.
 * Les flèches restent indispensables : un drag seul rendrait la liste
 * inaccessible sans souris.
 */
export function useReorderDnd({ siblingsOf, applyOrder }) {
  const [dragId, setDragId] = useState(null)
  const [dragOver, setDragOver] = useState({ id: null, side: null })
  const dragIdRef = useRef(null)
  const sideOf = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    return (e.clientY - r.top) < r.height / 2 ? 'before' : 'after'
  }
  const resetDrag = useCallback(() => {
    dragIdRef.current = null
    setDragId(null)
    setDragOver({ id: null, side: null })
  }, [])
  const move = useCallback((id, delta) => {
    const list = siblingsOf(id) || []
    const i = list.indexOf(id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= list.length) return
    const next = [...list]
    ;[next[i], next[j]] = [next[j], next[i]]
    applyOrder(next, id)
  }, [siblingsOf, applyOrder])

  return {
    dragId,
    dragOverId: dragOver.id,
    dragOverSide: dragOver.side,
    // Rien à réordonner quand l'item est seul de son groupe : pas de poignée.
    canMove: (id) => (siblingsOf(id)?.length || 0) > 1,
    isFirst: (id) => siblingsOf(id)?.[0] === id,
    isLast: (id) => siblingsOf(id)?.slice(-1)[0] === id,
    move,
    dragStart: (e, id, card) => {
      dragIdRef.current = id
      setDragId(id)
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move'
        try { e.dataTransfer.setData('text/plain', id) } catch { /* Safari */ }
        // Fantôme = la carte entière, pas la poignée seule.
        if (card) { try { e.dataTransfer.setDragImage(card, 24, 24) } catch { /* vieux navigateurs */ } }
      }
    },
    dragOver: (e, id) => {
      const src = dragIdRef.current
      if (!src || src === id || !(siblingsOf(src) || []).includes(id)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      const side = sideOf(e)
      setDragOver(prev => (prev.id === id && prev.side === side ? prev : { id, side }))
    },
    drop: (e, targetId) => {
      e.preventDefault()
      const sourceId = dragIdRef.current
      // Le côté est recalculé ici : React groupe les setState du dragOver, donc
      // l'état peut être périmé au moment du drop (surtout en test synchrone).
      const side = sideOf(e)
      resetDrag()
      const siblings = siblingsOf(sourceId) || []
      if (!sourceId || sourceId === targetId || !siblings.includes(targetId)) return
      const next = siblings.filter(id => id !== sourceId)
      let idx = next.indexOf(targetId)
      if (idx === -1) return
      if (side === 'after') idx += 1
      next.splice(idx, 0, sourceId)
      applyOrder(next, sourceId)
    },
    dragEnd: resetDrag,
  }
}
