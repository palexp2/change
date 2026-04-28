import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { ConfirmModal } from './Modal.jsx'

const ConfirmContext = createContext(null)

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null)
  const resolveRef = useRef(null)

  const confirm = useCallback((opts) => {
    const config = typeof opts === 'string' ? { message: opts } : (opts || {})
    return new Promise((resolve) => {
      resolveRef.current = resolve
      setState({
        title: config.title || 'Confirmer',
        message: config.message || '',
        confirmLabel: config.confirmLabel || 'Confirmer',
        danger: config.danger !== false,
      })
    })
  }, [])

  const handleClose = useCallback(() => {
    if (resolveRef.current) { resolveRef.current(false); resolveRef.current = null }
    setState(null)
  }, [])

  const handleConfirm = useCallback(() => {
    if (resolveRef.current) { resolveRef.current(true); resolveRef.current = null }
    setState(null)
  }, [])

  useEffect(() => {
    if (!state) return
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); handleConfirm() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, handleConfirm])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmModal
        isOpen={!!state}
        onClose={handleClose}
        onConfirm={handleConfirm}
        title={state?.title}
        message={state?.message}
        confirmLabel={state?.confirmLabel}
        danger={state?.danger}
      />
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider')
  return ctx
}
