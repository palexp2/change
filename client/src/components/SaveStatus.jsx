import { useState, useRef, useCallback } from 'react'
import { Check, AlertCircle } from 'lucide-react'
import { useToast } from '../contexts/ToastContext.jsx'

/**
 * Indicateur d'autosave unifié pour les fiches détail.
 *
 * États :
 *   - 'idle'   : rien affiché (aucune sauvegarde récente)
 *   - 'saving' : spinner discret + « Sauvegarde… »
 *   - 'saved'  : ✓ « Sauvegardé » (s'efface tout seul après un délai)
 *   - 'error'  : ⚠ « Échec » (en plus du toast d'erreur réseau)
 *
 * Usage recommandé via le hook `useSaveStatus()` qui gère le cycle de vie
 * complet (saving → saved/error) et remonte les échecs réseau en toast.
 */
export function SaveStatus({ status, className = '' }) {
  if (!status || status === 'idle') return null

  const base = `inline-flex items-center gap-1.5 text-xs font-medium transition-opacity ${className}`

  if (status === 'saving') {
    return (
      <span className={`${base} text-slate-400`} aria-live="polite">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-slate-500" />
        Sauvegarde…
      </span>
    )
  }
  if (status === 'saved') {
    return (
      <span className={`${base} text-green-600`} aria-live="polite">
        <Check size={13} /> Sauvegardé
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className={`${base} text-red-600`} aria-live="assertive">
        <AlertCircle size={13} /> Échec
      </span>
    )
  }
  return null
}

/**
 * Hook qui pilote un `SaveStatus` et remonte les échecs réseau en toast.
 *
 * Retourne `{ status, save }` :
 *   - `status` : à passer à `<SaveStatus status={status} />`
 *   - `save(fn)` : enveloppe une promesse de sauvegarde (ex. `() => api.x.update(...)`).
 *     Passe en 'saving', puis 'saved' (effacé après `savedMs`) en cas de succès,
 *     ou 'error' + toast en cas d'échec. Renvoie `true`/`false` selon le résultat.
 */
export function useSaveStatus({ savedMs = 1800 } = {}) {
  const [status, setStatus] = useState('idle')
  const { addToast } = useToast()
  const clearTimer = useRef(null)

  const save = useCallback(async (fn) => {
    clearTimeout(clearTimer.current)
    setStatus('saving')
    try {
      await fn()
      setStatus('saved')
      clearTimer.current = setTimeout(() => setStatus('idle'), savedMs)
      return true
    } catch (err) {
      setStatus('error')
      addToast({ message: `Échec de la sauvegarde : ${err?.message || 'erreur réseau'}`, type: 'error' })
      return false
    }
  }, [addToast, savedMs])

  return { status, save }
}
