import { useSyncExternalStore } from 'react'

// Ordre des fiches de la liste de fond, pour les chevrons ↑/↓ du panneau
// ouvert par l'URL (RecordRoutePanel). Une DataTable qui l'accepte
// (`peek.routeNav`) publie ici les URLs de ses lignes, dans l'ordre affiché
// (tri, filtres, groupes dépliés) ; le panneau y cherche sa propre URL.
let current = null // { owner, hrefs } | null
const listeners = new Set()
const emit = () => listeners.forEach(l => l())

export function publishPeekSiblings(owner, hrefs) {
  if (current?.owner === owner && current.hrefs.length === hrefs.length
    && current.hrefs.every((h, i) => h === hrefs[i])) return
  current = { owner, hrefs }
  emit()
}

export function clearPeekSiblings(owner) {
  if (current?.owner !== owner) return
  current = null
  emit()
}

function subscribe(l) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function usePeekSiblings() {
  return useSyncExternalStore(subscribe, () => current)
}
