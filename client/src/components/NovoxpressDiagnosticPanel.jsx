import { useState } from 'react'
import { Stethoscope, ExternalLink, Clipboard, Check, CheckCircle, XCircle } from 'lucide-react'

// Panneau de résultat du diagnostic Novoxpress en environnement dev (système
// temporaire — voir server/src/services/novoxpressDiagnostic.js). Affiché dans
// les modales étiquette et ramassage quand un diagnostic a tourné (auto sur
// erreur opaque, ou via le bouton « Diagnostiquer en dev »).
const VERDICTS = {
  novo_prod: {
    title: 'Vos données sont valides — problème côté Novoxpress',
    cls: 'bg-amber-50 border-amber-200 text-amber-800',
  },
  novo_down: {
    title: 'Novoxpress est en panne (même un payload témoin échoue)',
    cls: 'bg-amber-50 border-amber-200 text-amber-800',
  },
  carrier_unavailable: {
    title: 'Diagnostic impossible pour ce transporteur',
    cls: 'bg-slate-50 border-slate-200 text-slate-700',
  },
  not_isolated: {
    title: 'Cause non isolée par le diagnostic',
    cls: 'bg-slate-50 border-slate-200 text-slate-700',
  },
  field_isolated: {
    title: 'Champ fautif isolé — correction de notre côté',
    cls: 'bg-red-50 border-red-200 text-red-800',
  },
}

export default function NovoxpressDiagnosticPanel({ diagnostic }) {
  const [copied, setCopied] = useState(false)
  if (!diagnostic?.available) return null
  const v = VERDICTS[diagnostic.verdict] || VERDICTS.not_isolated

  const copyPrompt = () => {
    navigator.clipboard.writeText(diagnostic.claudePrompt).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    }).catch(() => {})
  }

  return (
    <div className={`border rounded-xl px-4 py-3 space-y-2 text-sm ${v.cls}`}>
      <p className="font-semibold flex items-center gap-1.5">
        <Stethoscope size={15} /> Diagnostic (env. dev Novoxpress) — {v.title}
      </p>
      <p className="text-xs whitespace-pre-wrap break-words">{diagnostic.message}</p>

      {diagnostic.manualUrl && (
        <a
          href={diagnostic.manualUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-medium underline hover:opacity-80"
        >
          <ExternalLink size={13} /> Créer l'envoi à la main sur app.novoxpress.ca
        </a>
      )}

      {diagnostic.claudePrompt && (
        <button
          onClick={copyPrompt}
          type="button"
          className="flex items-center gap-1.5 text-xs font-medium border border-current rounded-lg px-2.5 py-1.5 hover:bg-white/50 transition-colors"
        >
          {copied ? <><Check size={13} /> Copié !</> : <><Clipboard size={13} /> Copier le prompt pour Claude</>}
        </button>
      )}

      {diagnostic.attempts?.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer select-none opacity-80">
            Détail des {diagnostic.attempts.length} tentatives
          </summary>
          <ul className="mt-1.5 space-y-1">
            {diagnostic.attempts.map((a, i) => (
              <li key={i} className="flex items-start gap-1.5">
                {a.outcome === 'success'
                  ? <CheckCircle size={13} className="text-green-600 mt-0.5 shrink-0" />
                  : <XCircle size={13} className="text-red-500 mt-0.5 shrink-0" />}
                <span>
                  {a.label} <span className="opacity-60">({(a.ms / 1000).toFixed(1)} s)</span>
                  {a.error && <span className="block opacity-70 break-all">{a.error}</span>}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
