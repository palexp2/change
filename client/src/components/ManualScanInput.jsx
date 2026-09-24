import { useState } from 'react'
import { ScanBarcode, CornerDownLeft } from 'lucide-react'

// ── Saisie manuelle d'un numéro de série ──────────────────────────────────────
//
// Même chemin que le pistolet : étiquette illisible, série lue à l'œil ou pas de
// scanner sous la main, l'opérateur tape le numéro et Entrée.
// `useBarcodeScanner` ignore les frappes faites dans un INPUT — pas de double
// déclenchement, et un vrai scan tapé dans le champ finit par son Enter.
export default function ManualScanInput({ onSubmit, className = '' }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const code = value.trim()

  async function submit(e) {
    e.preventDefault()
    if (!code || busy) return
    setBusy(true)
    try { await onSubmit(code) } finally { setBusy(false); setValue('') }
  }

  return (
    <form onSubmit={submit} className={`flex items-center gap-1.5 ${className}`} data-testid="manual-scan-form">
      <ScanBarcode size={13} className="text-slate-400 flex-shrink-0" />
      <input
        value={value}
        onChange={e => setValue(e.target.value)}
        aria-label="Numéro de série ou code"
        title="Scanner, ou saisir le numéro de série à la main puis Entrée"
        className="input py-1 text-xs font-mono w-36"
        data-testid="manual-scan-input"
      />
      <button
        type="submit"
        disabled={!code || busy}
        title="Valider"
        className="p-1.5 rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <CornerDownLeft size={13} />
      </button>
    </form>
  )
}
