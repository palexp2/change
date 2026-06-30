import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'

// Délai d'annulation avant l'exécution réelle d'un envoi (email client-facing).
// Pendant ce délai, un toast avec barre de progression laisse l'utilisateur annuler.
const COUNTDOWN_MS = 10000

const UndoSendContext = createContext(null)

export function UndoSendProvider({ children }) {
  const [pending, setPending] = useState(null) // { id, message, onRun, onCancel }
  const timerRef = useRef(null)
  const pendingRef = useRef(null)
  const seqRef = useRef(0)

  const finish = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    pendingRef.current = null
    setPending(null)
  }, [])

  // Planifie un envoi qui s'exécutera après COUNTDOWN_MS sauf annulation.
  // onRun: l'action réelle (appel API + toast de résultat). onCancel: feedback d'annulation.
  const scheduleSend = useCallback(({ message, onRun, onCancel }) => {
    // Si un envoi est déjà en attente, on le déclenche immédiatement avant d'en planifier un nouveau.
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
      const prev = pendingRef.current
      prev?.onRun?.()
    }
    const entry = { id: ++seqRef.current, message, onRun, onCancel }
    pendingRef.current = entry
    setPending(entry)
    timerRef.current = setTimeout(() => {
      const e = pendingRef.current
      finish()
      e?.onRun?.()
    }, COUNTDOWN_MS)
  }, [finish])

  const cancel = useCallback(() => {
    const e = pendingRef.current
    finish()
    e?.onCancel?.()
  }, [finish])

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  return (
    <UndoSendContext.Provider value={scheduleSend}>
      {children}
      {pending && (
        <UndoSendToast
          key={pending.id}
          message={pending.message}
          durationMs={COUNTDOWN_MS}
          onCancel={cancel}
        />
      )}
    </UndoSendContext.Provider>
  )
}

function UndoSendToast({ message, durationMs, onCancel }) {
  const [width, setWidth] = useState(100)
  useEffect(() => {
    // rAF pour laisser le navigateur peindre 100% avant de lancer la transition vers 0%.
    const raf = requestAnimationFrame(() => setWidth(0))
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div
      data-testid="undo-send-toast"
      className="fixed bottom-4 left-4 z-[110] w-80 max-w-[calc(100vw-2rem)] bg-gray-800 text-white rounded-lg shadow-lg overflow-hidden animate-slide-in-up"
    >
      <div className="flex items-center gap-3 px-4 py-3 text-sm">
        <span className="flex-1">{message}</span>
        <button
          type="button"
          onClick={onCancel}
          data-testid="undo-send-cancel"
          className="text-xs font-medium underline hover:no-underline shrink-0"
        >
          Annuler
        </button>
      </div>
      <div className="h-1 bg-white/20">
        <div
          className="h-full bg-white/70"
          style={{ width: `${width}%`, transition: `width ${durationMs}ms linear` }}
        />
      </div>
    </div>
  )
}

export function useUndoSend() {
  const ctx = useContext(UndoSendContext)
  if (!ctx) throw new Error('useUndoSend must be used within UndoSendProvider')
  return ctx
}
