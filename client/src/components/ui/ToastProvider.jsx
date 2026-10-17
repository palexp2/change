import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { X } from 'lucide-react'
import { rememberUndo, forgetUndo, handleUndoKey } from '../../lib/globalUndo.js'

const ToastContext = createContext(null)

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  // `actions` (optionnel) : plusieurs boutons au lieu du seul `action`.
  const addToast = useCallback(({ message, type = 'info', action, actions, duration = 4000 }) => {
    const id = Date.now() + Math.random()
    setToasts(prev => [...prev, { id, message, type, action, actions, duration }])
    // Un toast « Annuler » est aussi annulable au Ctrl+Z (lib/globalUndo.js).
    if (type === 'undo' && action?.onClick) rememberUndo(id, action.onClick)
    if (duration > 0) {
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration)
    }
    return id
  }, [])

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  useEffect(() => {
    const h = e => handleUndoKey(e, { addToast, removeToast })
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [addToast, removeToast])

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}

function ToastContainer({ toasts, onDismiss }) {
  return (
    <div className="fixed bottom-4 left-4 z-[100] flex flex-col gap-2 max-w-sm">
      {toasts.map(toast => (
        <div key={toast.id}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg text-sm animate-slide-in-up ${
            toast.type === 'success' ? 'bg-green-600 text-white' :
            toast.type === 'error'   ? 'bg-red-600 text-white' :
            toast.type === 'warning' ? 'bg-amber-600 text-white' :
            toast.type === 'undo'    ? 'bg-gray-800 text-white' :
                                       'bg-gray-700 text-white'
          }`}>
          <span className="flex-1">{toast.message}</span>
          {toast.action && (
            <button onClick={() => { forgetUndo(toast.id); toast.action.onClick(); onDismiss(toast.id) }}
              className="text-xs font-medium underline hover:no-underline shrink-0">
              {toast.action.label}
            </button>
          )}
          {toast.actions?.map(a => (
            <button key={a.label} onClick={() => { a.onClick(); onDismiss(toast.id) }}
              className="text-xs font-medium px-1.5 py-0.5 rounded bg-white/15 hover:bg-white/25 shrink-0">
              {a.label}
            </button>
          ))}
          <button onClick={() => onDismiss(toast.id)}
            className="text-white/60 hover:text-white shrink-0">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
