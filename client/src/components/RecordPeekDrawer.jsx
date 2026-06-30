import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { X, Maximize2 } from 'lucide-react'

// Drawer latéral (side-peek à la Airtable) : ouvre l'aperçu/édition d'un
// enregistrement par-dessus la liste, sans quitter le contexte de la table.
// Le contenu (`children`) est typiquement une page *Detail.jsx rendue en mode
// `embedded` — l'autosave, le realtime et le chargement restent gérés par la
// fiche elle-même.
//
// Props :
//  - open        : bool — visibilité.
//  - onClose     : () => void — fermeture (overlay, bouton ×, Échap).
//  - title       : string — titre affiché dans l'en-tête du drawer.
//  - subtitle    : string | undefined — sous-titre discret (entreprise, courriel…).
//  - to          : string | undefined — route de la fiche complète ; affiche le
//                  bouton « ouvrir en grand » qui navigue et ferme le drawer.
//  - width       : number — largeur en px (défaut 560), bornée à la largeur écran.
//  - children    : contenu du corps (scrollable).
export default function RecordPeekDrawer({ open, onClose, title, subtitle, to, width = 560, children }) {
  const navigate = useNavigate()
  const panelRef = useRef(null)

  // Verrou du scroll du body tant que le drawer est ouvert.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  // Fermeture sur Échap. stopPropagation pour ne pas fermer aussi une modale
  // sous-jacente éventuelle.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  function openFull() {
    if (!to) return
    onClose?.()
    navigate(to)
  }

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" data-testid="record-peek-drawer">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div
        ref={panelRef}
        className="fixed top-0 right-0 bottom-0 bg-slate-50 shadow-2xl flex flex-col animate-slide-in-right"
        style={{ width: `min(${width}px, 100vw)` }}
      >
        <div className="flex items-center gap-1.5 px-4 py-3 border-b border-slate-200 bg-white flex-shrink-0">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-900 truncate" data-testid="record-peek-title">{title}</div>
            {subtitle && <div className="text-xs text-slate-400 truncate">{subtitle}</div>}
          </div>
          {to && (
            <button
              onClick={openFull}
              data-testid="record-peek-expand"
              title="Ouvrir la fiche complète"
              aria-label="Ouvrir la fiche complète"
              className="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <Maximize2 size={16} />
            </button>
          )}
          <button
            onClick={onClose}
            data-testid="record-peek-close"
            aria-label="Fermer"
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto flex-1" data-testid="record-peek-body">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}
