import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { nextModalZ, registerOverlay } from '../lib/overlayLayers.js'

// Sélecteur des éléments réellement focusables à l'intérieur de la modale.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function getFocusable(container) {
  if (!container) return []
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el.getClientRects().length > 0,
  )
}

// Nombre de modales actuellement ouvertes. RecordPeekDrawer s'y réfère pour ne
// PAS se fermer sur Échap quand une modale est ouverte par-dessus : les deux
// écoutent `document` en phase bulle, donc le stopPropagation de la modale
// n'atteint pas le drawer et une seule touche fermait les deux d'un coup.
let openModals = 0
export function hasOpenModal() { return openModals > 0 }

// `zIndex` : plan d'empilement imposé. Par défaut la modale se place d'elle-même
// juste au-dessus de la couche flottante la plus haute déjà ouverte (registre
// `lib/overlayLayers.js`) : panneau latéral, pile de panneaux empilés, ou autre
// modale. C'est ce qui garantit qu'une confirmation reste visible même ouverte
// depuis le troisième panneau d'une pile.
export function Modal({ isOpen, onClose, title, children, size = 'md', zIndex }) {
  const contentRef = useRef(null)
  // Plan figé à l'ouverture : recalculer à chaque rendu ferait sauter la modale
  // d'un plan à l'autre au gré des couches qui s'ouvrent/se ferment ailleurs.
  const zRef = useRef(null)
  if (isOpen) {
    if (zRef.current == null) zRef.current = zIndex ?? nextModalZ()
  } else if (zRef.current != null) {
    zRef.current = null
  }
  const z = zRef.current ?? zIndex ?? 50

  useEffect(() => {
    if (!isOpen) return
    openModals += 1
    return () => { openModals -= 1 }
  }, [isOpen])

  // Inscription au registre d'empilement : une modale ouverte par-dessus
  // celle-ci (une confirmation dans un formulaire, typiquement) passera devant.
  useEffect(() => {
    if (!isOpen) return
    return registerOverlay(z)
  }, [isOpen, z])

  // Verrou du scroll du body quand la modale est ouverte
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [isOpen])

  // Autofocus du premier champ à l'ouverture : on privilégie le premier
  // input/textarea/select ; à défaut, le premier élément focusable (hors bouton X).
  useEffect(() => {
    if (!isOpen) return
    // rAF pour laisser le DOM se peindre avant de focus
    const raf = requestAnimationFrame(() => {
      const container = contentRef.current
      if (!container) return
      const focusables = getFocusable(container)
      const firstField = focusables.find((el) =>
        /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName),
      )
      const target = firstField || focusables.find((el) => el.dataset.modalClose === undefined)
      if (target) target.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [isOpen])

  // Fermeture sur Échap + focus-trap (Tab / Shift+Tab cyclent dans la modale)
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose?.()
        return
      }
      if (e.key === 'Tab') {
        const focusables = getFocusable(contentRef.current)
        if (focusables.length === 0) {
          e.preventDefault()
          return
        }
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement
        // Si le focus est hors de la modale, le ramener dedans
        if (!contentRef.current?.contains(active)) {
          e.preventDefault()
          first.focus()
          return
        }
        if (e.shiftKey && active === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && active === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const sizes = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  }

  // Portée via createPortal directement sous <body>, comme RecordPeekDrawer :
  // sinon, ouverte pendant qu'un drawer est déjà là, la modale reste imbriquée
  // sous #root alors que le drawer est un sibling ajouté après #root — à
  // z-index égal (50), le drawer gagnait l'empilement et recouvrait la modale.
  return createPortal(
    <div className="fixed inset-0 flex items-center justify-center p-4" style={{ zIndex: z }} role="dialog" aria-modal="true">
      <div
        className="fixed inset-0 bg-black/50"
        onClick={onClose}
      />
      <div ref={contentRef} className={`relative bg-white rounded-2xl shadow-2xl w-full ${sizes[size]} max-h-[90vh] flex flex-col`}>
        {title && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 flex-shrink-0">
            <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
            <button
              onClick={onClose}
              data-modal-close
              aria-label="Fermer"
              className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        )}
        <div className="overflow-y-auto flex-1 px-6 py-4">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function ConfirmModal({ isOpen, onClose, onConfirm, title, message, confirmLabel = 'Confirmer', danger = false }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="sm">
      <p className="text-slate-600 mb-6 whitespace-pre-line">{message}</p>
      <div className="flex justify-end gap-3">
        <button onClick={onClose} className="btn-secondary">Annuler</button>
        <button
          onClick={() => { onConfirm(); onClose(); }}
          className={danger ? 'btn-danger' : 'btn-primary'}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
