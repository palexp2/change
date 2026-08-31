import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

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

export function Modal({ isOpen, onClose, title, children, size = 'md' }) {
  const contentRef = useRef(null)

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
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
