import { useEffect, useRef, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { isCheckboxTruthy } from '../lib/customFieldDisplay.jsx'
import { toDateTimeLocalInput, fromDateTimeLocalInput } from '../lib/formatDate.js'
import { useFieldFormat } from '../lib/fieldFormat.js'
import { parseDurationToSeconds, formatDurationSeconds } from '../lib/duration.js'
import { isValidIsoDate } from './DateInput.jsx'

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

// Texte long : la zone est TOUJOURS un rectangle blanc encadré, même vide et
// même quand le champ n'a jamais été rempli — c'est ce cadre qui dit à
// l'utilisateur que le champ se modifie sur place. Elle grandit avec le
// contenu, sans jamais descendre sous `minRows` lignes.
export function InlineTextarea({ value, saving, onSave, testId, minRows = 2 }) {
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
      // `min-height` l'emporte sur la hauteur calculée par l'auto-agrandissement :
      // le cadre garde sa taille de rectangle quel que soit le contenu.
      // (interligne text-sm 20 px + padding vertical de .input)
      style={{ minHeight: `${18 + minRows * 20}px` }}
      rows={minRows}
      disabled={saving}
      data-testid={testId}
    />
  )
}

// Nombre : borné côté client quand `min`/`max` sont fournis, pour ne pas envoyer
// une valeur que la route rejetterait (ex. probabilité hors 0–100).
// `compact` : affiche « 6 » plutôt que « 6.0 » (zéros décimaux inutiles retirés).
export function InlineNumber({
  value, saving, onSave, min, max, step = 'any',
  suffix, className = 'input text-sm w-28', testId, compact = false,
  // Précision réglée du champ (nombre de décimales) : la valeur s'affiche
  // arrondie à cette précision (« 25 », pas « 25.0 » pour 0 décimale).
  decimals: decimalsProp = null,
}) {
  const fmt = useFieldFormat()
  const decimals = decimalsProp ?? (Number.isInteger(fmt?.decimals) ? fmt.decimals : (fmt?.type === 'currency' ? 2 : null))
  if (suffix == null && fmt?.type === 'currency') suffix = '$'
  if (suffix == null && fmt?.type === 'percent') suffix = '%'
  const shown = v => {
    if (v == null) return ''
    if (v === '') return v
    const n = Number(v)
    if (!Number.isFinite(n)) return v
    if (Number.isInteger(decimals)) return n.toFixed(decimals)
    return compact ? n : v
  }
  const [local, setLocal] = useState(shown(value))
  useEffect(() => { setLocal(shown(value)) }, [value, compact, decimals]) // eslint-disable-line react-hooks/exhaustive-deps

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
    setLocal(shown(n))
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

// Durée : la valeur est en SECONDES, l'écran en h:mm (ou h:mm:ss). On tape
// « 1:30 », « 1h30 », « 90 » (minutes)… ; une saisie illisible remet l'ancienne.
export function InlineDuration({ value, saving, onSave, format = 'h:mm', className = 'input text-sm w-full', testId }) {
  const shown = v => (v == null || v === '' ? '' : formatDurationSeconds(Number(v), format))
  const [local, setLocal] = useState(shown(value))
  useEffect(() => { setLocal(shown(value)) }, [value, format]) // eslint-disable-line react-hooks/exhaustive-deps

  const commit = raw => {
    const str = String(raw ?? '').trim()
    if (str === '') { if ((value ?? '') !== '') onSave(''); return }
    const sec = parseDurationToSeconds(str)
    if (sec == null) { setLocal(shown(value)); return }
    setLocal(shown(sec))
    if (value == null || value === '' || Number(value) !== sec) onSave(sec)
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      value={local}
      onChange={e => setLocal(e.target.value)}
      onBlur={e => commit(e.target.value)}
      className={`${className} tabular-nums`}
      disabled={saving}
      data-testid={testId}
    />
  )
}

// Date en texte AAAA-MM-JJ, affichée telle quelle quelle que soit la langue du
// navigateur (le sélecteur natif suit la locale) ; commit au blur. Un clic ouvre
// le calendrier de l'app (DatePickerHost). `withTime` : date + heure.
export function InlineDate({ value, saving, onSave, withTime = false, className = 'input text-sm w-full', testId }) {
  if (withTime) return <InlineDateTime value={value} saving={saving} onSave={onSave} className={className} testId={testId} />
  return <InlineIsoDate value={value} saving={saving} onSave={onSave} className={className} testId={testId} />
}

// Saisie texte validée au blur (Entrée = blur) — socle des dates et date-heure.
function CommitTextInput({ local, setLocal, commit, className, saving, testId, ...rest }) {
  return (
    <input
      type="text"
      inputMode="numeric"
      value={local}
      onChange={e => setLocal(e.target.value)}
      onBlur={e => commit(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
      className={`${className} tabular-nums`}
      disabled={saving}
      data-testid={testId}
      {...rest}
    />
  )
}

// Date en texte AAAA-MM-JJ (le type="date" natif suit la langue du navigateur).
// Calendrier via data-date-picker ; saisie invalide → revient. Aussi utilisé
// hors fiche (bon de commande, achat) avec `className="input"`.
export function InlineIsoDate({ value, saving, onSave, className = 'input text-sm w-full', testId, ...rest }) {
  const current = value == null ? '' : String(value).slice(0, 10)
  const [local, setLocal] = useState(current)
  useEffect(() => { setLocal(current) }, [current])
  const commit = raw => {
    const str = String(raw ?? '').trim()
    if (str === current) return
    if (str !== '' && !isValidIsoDate(str)) { setLocal(current); return }
    onSave(str)
  }
  return <CommitTextInput data-date-picker local={local} setLocal={setLocal} commit={commit} className={className} saving={saving} testId={testId} {...rest} />
}

// Date + heure en texte « AAAA-MM-JJ HH:MM » : le datetime-local natif suit la
// langue du navigateur (« 10/16/2026, 02:05 PM » en anglais). Saisie invalide → revient.
const ISO_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/
function InlineDateTime({ value, saving, onSave, className, testId }) {
  const current = toDateTimeLocalInput(value).replace('T', ' ')
  const [local, setLocal] = useState(current)
  useEffect(() => { setLocal(current) }, [current])
  const commit = raw => {
    const str = String(raw ?? '').trim()
    if (str === current) return
    if (str === '') { onSave(''); return }
    const m = str.match(ISO_DATETIME)
    if (!m || !isValidIsoDate(m[1]) || Number(m[2]) > 23 || Number(m[3]) > 59) { setLocal(current); return }
    onSave(fromDateTimeLocalInput(`${m[1]}T${m[2].padStart(2, '0')}:${m[3]}`))
  }
  return <CommitTextInput local={local} setLocal={setLocal} commit={commit} className={className} saving={saving} testId={testId} />
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
