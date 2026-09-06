import { useEffect, useRef, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { isCheckboxTruthy } from '../lib/customFieldDisplay.jsx'

// Éditeurs « inline » pour les champs d'une fiche détail : la valeur s'édite sur
// place et part toute seule au blur (règle de design CLAUDE.md — autosave
// partout, pas de bouton Enregistrer). Ils étaient recopiés fiche par fiche ;
// ils vivent ici pour qu'une fiche puisse rendre TOUS ses champs modifiables
// sans réécrire la même plomberie.
//
// Contrat commun :
//  - `value`  : la valeur du record — source de vérité. L'état local se
//               resynchronise dessus, donc un rollback après erreur serveur
//               remet bien l'ancienne valeur à l'écran.
//  - `onSave` : appelé UNIQUEMENT si la valeur a changé.
//  - `saving` : désactive le champ pendant l'aller-retour serveur.

export function InlineText({
  value, saving, onSave, required = false,
  type = 'text', className = 'input text-sm w-full', testId,
}) {
  const [local, setLocal] = useState(value ?? '')
  useEffect(() => { setLocal(value ?? '') }, [value])
  return (
    <input
      type={type}
      value={local}
      onChange={e => setLocal(e.target.value)}
      onBlur={e => {
        const next = e.target.value
        // Champ obligatoire vidé : on remet la valeur du record plutôt que
        // d'envoyer un vide que le serveur refuserait de toute façon.
        if (required && !next.trim()) { setLocal(value ?? ''); return }
        if (next !== (value ?? '')) onSave(next)
      }}
      className={className}
      disabled={saving}
      data-testid={testId}
    />
  )
}

export function InlineUrl({ value, saving, onSave, testId }) {
  const [local, setLocal] = useState(value ?? '')
  useEffect(() => { setLocal(value ?? '') }, [value])
  const isValidLink = value && /^https?:\/\//i.test(value)
  return (
    <div className="flex items-center gap-2">
      <input
        type="url"
        value={local}
        onChange={e => setLocal(e.target.value)}
        onBlur={e => { if (e.target.value !== (value ?? '')) onSave(e.target.value) }}
        className="input text-sm flex-1"
        disabled={saving}
        data-testid={testId}
      />
      {isValidLink && (
        <a href={value} target="_blank" rel="noopener noreferrer" title="Ouvrir le lien" className="p-1.5 text-slate-400 hover:text-brand-600">
          <ExternalLink size={14} />
        </a>
      )}
    </div>
  )
}

export function InlineTextarea({ value, saving, onSave, testId }) {
  const [local, setLocal] = useState(value ?? '')
  const ref = useRef(null)
  useEffect(() => { setLocal(value ?? '') }, [value])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [local])

  return (
    <textarea
      ref={ref}
      value={local}
      onChange={e => setLocal(e.target.value)}
      onBlur={e => { if (e.target.value !== (value ?? '')) onSave(e.target.value) }}
      className="input text-sm w-full resize-none overflow-hidden"
      rows={1}
      disabled={saving}
      data-testid={testId}
    />
  )
}

// Nombre : borné côté client quand `min`/`max` sont fournis, pour ne pas envoyer
// une valeur que la route rejetterait (ex. probabilité hors 0–100).
export function InlineNumber({
  value, saving, onSave, min, max, step = 'any',
  suffix, className = 'input text-sm w-28', testId,
}) {
  const [local, setLocal] = useState(value ?? '')
  useEffect(() => { setLocal(value ?? '') }, [value])

  const commit = (raw) => {
    const str = String(raw ?? '').trim()
    if (str === '') {
      if ((value ?? '') !== '') onSave('')
      return
    }
    let n = Number(str)
    if (!Number.isFinite(n)) { setLocal(value ?? ''); return }
    if (min != null) n = Math.max(Number(min), n)
    if (max != null) n = Math.min(Number(max), n)
    setLocal(n)
    if (value == null || Number(value) !== n) onSave(n)
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        value={local}
        min={min}
        max={max}
        step={step}
        onChange={e => setLocal(e.target.value)}
        onBlur={e => commit(e.target.value)}
        className={className}
        disabled={saving}
        data-testid={testId}
      />
      {suffix && <span className="text-xs text-slate-400">{suffix}</span>}
    </div>
  )
}

// Date : commit au changement (le sélecteur natif n'a pas de « blur » utile).
export function InlineDate({ value, saving, onSave, className = 'input text-sm w-full', testId }) {
  const current = value == null ? '' : String(value).slice(0, 10)
  return (
    <input
      type="date"
      value={current}
      onChange={e => { if (e.target.value !== current) onSave(e.target.value) }}
      className={className}
      disabled={saving}
      data-testid={testId}
    />
  )
}

// Case à cocher : stockée en 1/0 (même forme que le sync et l'éditeur de tableau).
export function InlineCheckbox({ value, saving, onSave, label, testId }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-slate-700">
      <input
        type="checkbox"
        checked={isCheckboxTruthy(value)}
        onChange={e => onSave(e.target.checked ? 1 : 0)}
        disabled={saving}
        className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
        data-testid={testId}
      />
      {label}
    </label>
  )
}
