import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { getEmailSignature, saveEmailSignature } from '../lib/emailSignature.js'
import { useToast } from '../contexts/ToastContext.jsx'

// Signature de courriel (Paramètres › Ma boîte Gmail). Zone éditable riche :
// un copier-coller de la signature Gmail garde liens, gras et images.
// Enregistrée automatiquement à la sortie du champ.
export default function EmailSignatureEditor() {
  const ref = useRef(null)
  const lastRef = useRef('')
  const [ready, setReady] = useState(false)
  const [saved, setSaved] = useState(false)
  const { addToast } = useToast()

  useEffect(() => {
    let alive = true
    getEmailSignature().then(sig => {
      if (!alive || !ref.current) return
      ref.current.innerHTML = sig
      lastRef.current = ref.current.innerHTML
      setReady(true)
    })
    return () => { alive = false }
  }, [])

  const save = async () => {
    const el = ref.current
    if (!el) return
    const html = (el.textContent.trim() || el.querySelector('img')) ? el.innerHTML : ''
    if (html === lastRef.current) return
    try {
      const sig = await saveEmailSignature(html)
      lastRef.current = html
      if (!html) el.innerHTML = ''
      else if (sig !== html) { el.innerHTML = sig; lastRef.current = el.innerHTML }
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      addToast({ message: e.message || 'Signature non enregistrée', type: 'error' })
    }
  }

  return (
    <div data-testid="email-signature">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-sm font-medium text-slate-700">Signature</span>
        {saved && <Check size={14} className="text-green-500" />}
      </div>
      <div
        ref={ref}
        contentEditable={ready}
        suppressContentEditableWarning
        onBlur={save}
        aria-label="Signature de courriel"
        className="border border-slate-200 rounded-xl bg-white px-4 py-3 text-sm min-h-[96px] max-h-80 overflow-y-auto focus:outline-none focus:border-brand-400"
        data-testid="email-signature-editor"
      />
    </div>
  )
}
