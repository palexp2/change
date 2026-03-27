import { createContext, useContext, useRef, useCallback, useEffect } from 'react'
import { useToast } from '../components/ui/ToastProvider.jsx'

const UndoRedoContext = createContext(null)

const MAX_STACK = 30

export function UndoRedoProvider({ children }) {
  const undoStackRef = useRef([])
  const redoStackRef = useRef([])
  const { addToast } = useToast()

  const pushUndo = useCallback((undoAction, redoAction, label) => {
    undoStackRef.current.push({ label, undo: undoAction, redo: redoAction })
    if (undoStackRef.current.length > MAX_STACK) undoStackRef.current.shift()
    redoStackRef.current = []
  }, [])

  const pushFromAPIResponse = useCallback((apiResponse, originalAction, label) => {
    if (apiResponse?.undo) {
      pushUndo(apiResponse.undo, originalAction, label)
    }
  }, [pushUndo])

  const executeAction = useCallback(async (action) => {
    const token = localStorage.getItem('erp_token')
    const opts = { method: action.method, headers: { 'Content-Type': 'application/json' } }
    if (token) opts.headers['Authorization'] = `Bearer ${token}`
    if (action.body && action.method !== 'GET') opts.body = JSON.stringify(action.body)
    // Server-generated undo URLs use /api/... prefix; rewrite to /erp/api/...
    const url = action.url.startsWith('/api/') ? '/erp' + action.url : action.url
    const res = await fetch(url, opts)
    return res.json()
  }, [])

  const redo = useCallback(async () => {
    if (redoStackRef.current.length === 0) return
    const entry = redoStackRef.current.pop()
    try {
      await executeAction(entry.redo)
      undoStackRef.current.push(entry)
      window.dispatchEvent(new CustomEvent('undo-redo'))
    } catch {
      addToast({ message: 'Impossible de rétablir cette action', type: 'error' })
    }
  }, [executeAction, addToast])

  const undo = useCallback(async () => {
    if (undoStackRef.current.length === 0) return
    const entry = undoStackRef.current.pop()
    try {
      await executeAction(entry.undo)
      redoStackRef.current.push(entry)
      addToast({
        message: `Annulé : ${entry.label}`,
        type: 'undo',
        action: { label: 'Rétablir', onClick: () => redo() },
        duration: 5000,
      })
      window.dispatchEvent(new CustomEvent('undo-redo'))
    } catch {
      addToast({ message: 'Impossible d\'annuler cette action', type: 'error' })
    }
  }, [executeAction, addToast, redo])

  useEffect(() => {
    function handleKeyDown(e) {
      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      if (mod && e.key === 'z' && e.shiftKey)  { e.preventDefault(); redo() }
      if (!isMac && e.ctrlKey && e.key === 'y') { e.preventDefault(); redo() }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [undo, redo])

  return (
    <UndoRedoContext.Provider value={{ pushUndo, pushFromAPIResponse }}>
      {children}
    </UndoRedoContext.Provider>
  )
}

export function useUndoRedo() {
  return useContext(UndoRedoContext)
}
