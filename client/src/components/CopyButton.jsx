import { useState, useRef, useEffect } from 'react'
import { Check, Copy } from 'lucide-react'

// Bouton « copier » réutilisable : rend le texte d'un bloc (journal, message
// d'erreur, identifiant…) récupérable en un clic plutôt qu'à la sélection
// souris, qui rate régulièrement les blocs scrollables.
export default function CopyButton({ text, label, title = 'Copier', className = '', testId }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = async (e) => {
    e?.stopPropagation?.()
    const value = typeof text === 'function' ? text() : text
    if (!value) return
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
      } else {
        // Contexte non sécurisé / navigateur ancien : repli execCommand.
        const ta = document.createElement('textarea')
        ta.value = value
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 2000)
    } catch { /* copie best-effort */ }
  }

  return (
    <button type="button" onClick={copy} title={title} data-testid={testId}
      className={`inline-flex items-center gap-1 px-1.5 py-1 text-[11px] rounded-lg border border-slate-200 bg-white/80 text-slate-500 hover:text-slate-700 hover:bg-slate-50 ${className}`}>
      {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
      {(label || copied) && <span>{copied ? 'Copié' : label}</span>}
    </button>
  )
}
