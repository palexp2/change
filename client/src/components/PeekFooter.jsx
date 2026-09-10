import { createContext, useContext, useMemo } from 'react'
import { createPortal } from 'react-dom'

// Barre d'action épinglée au bas du panneau latéral.
//
// Variante d'agencement de `RecordPeekDrawer` : le drawer réserve une bande
// sous son corps scrollable et l'expose par contexte ; n'importe quel
// descendant de la fiche embarquée peut y déposer son action avec
// <PeekFooter>…</PeekFooter>, sans plomberie de props sur 4 niveaux.
// L'action reste donc visible où qu'on soit dans le défilement de la fiche.
//
// Hors panneau (fiche rendue ailleurs), le contenu est rendu en place.
const PeekFooterContext = createContext(null)

export function PeekFooterProvider({ node, children }) {
  const value = useMemo(() => ({ node }), [node])
  return <PeekFooterContext.Provider value={value}>{children}</PeekFooterContext.Provider>
}

export function PeekFooter({ children }) {
  const slot = useContext(PeekFooterContext)
  if (!slot) return children
  // Dans un panneau mais la bande n'est pas encore montée (1er rendu) : on
  // attend, plutôt que d'afficher l'action au milieu de la fiche une frame.
  if (!slot.node) return null
  return createPortal(children, slot.node)
}

export default PeekFooter
