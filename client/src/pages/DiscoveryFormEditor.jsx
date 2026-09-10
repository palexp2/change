import { EQUIPMENT_PRODUCT_GROUPS, EQUIPMENT_OUTPUTS } from '../lib/discoveryEquipmentCatalog.js'
import { useState, useEffect, useMemo, useId, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Trash2, RotateCcw, Filter, Eye, EyeOff, ArrowUp, ArrowDown, Copy } from 'lucide-react'
import { api } from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import Spinner from '../components/Spinner.jsx'
import ErrorBanner from '../components/ErrorBanner.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { SaveStatus, useSaveStatus } from '../components/SaveStatus.jsx'
import { fmtDate } from '../lib/formatDate.js'
import {
  SCHEMA_GROUPS, DEFAULT_TEXTS, DEFAULT_CHOICES, DEFAULT_BRANDS,
  CUSTOM_SECTIONS, CUSTOM_TYPES, CONDITION_OPS, emptyOverrides, buildForm,
  conditionSources, conditionValueOptions, conditionIsNumeric, slugChoiceValue,
} from '../lib/discoveryFormSchema.js'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import GreenhouseIllustration from '../components/GreenhouseIllustration.jsx'
import { QUESTION_IMAGES } from '../lib/discoveryQuestionImages.js'
import { focusForSection, focusForSchemaItem, focusLabel } from '../lib/greenhouseFocus.js'

// Éditeur du formulaire de découverte technique (System builder).
//
// On n'édite pas le formulaire lui-même mais un calque de surcharges : un champ
// remis à sa valeur d'origine sort du calque, si bien qu'une reformulation faite
// plus tard dans le code continue de le suivre. Le texte d'origine est rappelé
// sous le champ modifié (pas en placeholder — cf. règle : aucun placeholder).
//
// Navigation par catégories et édition d’une section à la fois. Les scènes du
// formulaire client ne sont pas répétées dans les contrôles de l’éditeur.

const BRANDS_HELP = 'Une marque par ligne : Marque: modèle1, modèle2'
// Pause de frappe avant l'envoi automatique (règle de design : autosave partout).
const AUTOSAVE_MS = 700
const ROW_GRID = 'form-editor-fields grid gap-x-3 gap-y-2'
const CELL = 'w-full min-w-0 bg-transparent px-2 py-1.5 text-sm text-slate-900 focus:outline-none focus:bg-brand-50/60'
function brandsToText(brands) {
  return (brands || DEFAULT_BRANDS).map(b => `${b.brand}: ${b.models.join(', ')}`).join('\n')
}
function textToBrands(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const i = trimmed.indexOf(':')
    const brand = (i === -1 ? trimmed : trimmed.slice(0, i)).trim()
    if (!brand) continue
    const models = i === -1 ? [] : trimmed.slice(i + 1).split(',').map(m => m.trim()).filter(Boolean)
    out.push({ brand, models })
  }
  return out
}

// Une ligne de la grille : libellé (pastille quand la valeur diffère de
// l'origine) puis la zone de saisie.
function Row({ label, changed, children, htmlFor }) {
  return (
    <>
      <div className="flex items-start gap-1.5 pt-2 text-xs text-slate-500 leading-tight">
        <span className={`mt-1 h-1.5 w-1.5 rounded-full shrink-0 ${changed ? 'bg-brand-500' : 'bg-transparent'}`} />
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
      </div>
      <div className="min-w-0">{children}</div>
    </>
  )
}

function ResetLine({ original, onReset }) {
  return (
    <div className="flex items-center gap-2 mt-1 text-xs text-slate-400">
      {original != null && <span className="flex-1 truncate" title={original}>D’origine : {original}</span>}
      <button onClick={onReset} className="ml-auto shrink-0 hover:text-slate-700">Rétablir</button>
    </div>
  )
}

function TextItem({ item, value, onChange }) {
  const inputId = useId()
  const original = DEFAULT_TEXTS[item.id]
  const changed = value != null && value !== ''
  const Tag = item.kind === 'textarea' ? 'textarea' : 'input'
  return (
    <Row label={item.label} changed={changed} htmlFor={inputId}>
      <Tag
        id={inputId}
        className="input py-1.5"
        rows={item.kind === 'textarea' ? 2 : undefined}
        value={changed ? value : original}
        onChange={e => onChange(e.target.value === original ? '' : e.target.value)}
      />
      {changed && <ResetLine original={original} onReset={() => onChange('')} />}
    </Row>
  )
}

// Un choix livré par le code garde sa `value` (le code s'y fie, les réponses
// déjà enregistrées la portent) : on peut le renommer ou le retirer, jamais le
// renuméroter. Retirer = marqueur `{ value, removed }` dans le calque, donc
// réversible ; un choix ajouté par l'utilisateur, lui, disparaît pour de bon.
function choiceRows(defaults, value) {
  const ov = (Array.isArray(value) ? value : []).filter(o => o && o.value != null)
  const byValue = new Map(ov.map(o => [String(o.value), o]))
  const known = new Set(defaults.map(d => d.value))
  const rows = defaults.map(d => {
    const o = byValue.get(d.value)
    return { value: d.value, label: o?.label ?? d.label, help: o?.help ?? d.help ?? '', removed: !!o?.removed, def: d }
  })
  for (const o of ov) {
    if (o.removed || known.has(String(o.value))) continue
    rows.push({ value: String(o.value), label: o.label || '', help: o.help || '', removed: false, def: null, fresh: !!o.fresh })
  }
  return rows
}

function serializeChoices(rows) {
  const out = []
  for (const r of rows) {
    if (!r.def) out.push({ value: r.value, label: r.label, ...(r.help ? { help: r.help } : {}), ...(r.fresh ? { fresh: true } : {}) })
    else if (r.removed) out.push({ value: r.value, removed: true })
    else if (r.label !== r.def.label || (r.help || '') !== (r.def.help || '')) {
      out.push({ value: r.value, label: r.label, ...(r.help ? { help: r.help } : {}) })
    }
  }
  return out.length ? out : null
}

function ChoicesItem({ item, value, onChange }) {
  const defaults = DEFAULT_CHOICES[item.id] || []
  const rows = choiceRows(defaults, value)
  const live = rows.filter(r => !r.removed)
  const commit = next => onChange(serializeChoices(next))
  // Tant qu'un choix ajouté n'est pas enregistré (`fresh`), sa valeur suit le
  // libellé — elle se fige au premier enregistrement, où le serveur perd le
  // marqueur : renommer ensuite ne peut plus orpheliner une réponse.
  function set(idx, patch) {
    const next = rows.map((r, i) => (i === idx ? { ...r, ...patch } : r))
    const r = next[idx]
    if (r.fresh && patch.label != null) {
      r.value = slugChoiceValue(patch.label, next.filter((_, i) => i !== idx).map(x => x.value))
    }
    commit(next)
  }
  const drop = (idx) => {
    const r = rows[idx]
    commit(r.def ? rows.map((x, i) => (i === idx ? { ...x, removed: true } : x)) : rows.filter((_, i) => i !== idx))
  }
  const add = () => commit([
    ...rows,
    { value: slugChoiceValue('', rows.map(r => r.value)), label: '', help: '', removed: false, def: null, fresh: true },
  ])
  const changed = value != null

  return (
    <Row label={item.label} changed={changed}>
      <div className="rounded-lg border border-slate-200 overflow-hidden">
        <div className="grid grid-cols-[3fr_2fr_1.75rem] bg-slate-50 border-b border-slate-200 text-[11px] text-slate-400">
          <div className="px-2 py-1">Libellé</div>
          <div className="px-2 py-1">Aide</div>
        </div>
        <div className="divide-y divide-slate-100">
          {rows.map((r, i) => (r.removed ? (
            <div key={i} className="flex items-center gap-2 px-2 py-1 bg-slate-50 text-xs text-slate-400">
              <span className="flex-1 line-through truncate">{r.label}</span>
              <button onClick={() => set(i, { removed: false })} className="p-1 hover:text-slate-700" title="Remettre">
                <RotateCcw size={12} />
              </button>
            </div>
          ) : (
            <div key={i} className="grid grid-cols-[3fr_2fr_1.75rem] items-center">
              <input aria-label={`${item.label} — libellé du choix ${i + 1}`} className={CELL} value={r.label} onChange={e => set(i, { label: e.target.value })} />
              <input aria-label={`${item.label} — aide du choix ${i + 1}`} className={`${CELL} text-xs text-slate-600 border-l border-slate-100`} value={r.help} onChange={e => set(i, { help: e.target.value })} />
              <button
                onClick={() => drop(i)}
                disabled={live.length < 2}
                className="p-1 justify-self-center text-slate-400 hover:text-red-600 disabled:opacity-30 disabled:hover:text-slate-400"
                title="Retirer ce choix"
              >
                <Trash2 size={13} />
              </button>
            </div>
          )))}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-1">
        <button onClick={add} className="btn-ghost btn-sm"><Plus size={12} /> Choix</button>
        {changed && <ResetLine onReset={() => onChange(null)} />}
      </div>
    </Row>
  )
}

function BrandsItem({ item, value, onChange }) {
  const inputId = useId()
  return (
    <Row label={item.label} changed={value != null} htmlFor={inputId}>
      <textarea
        id={inputId}
        className="input font-mono text-xs py-1.5"
        rows={7}
        value={brandsToText(value)}
        onChange={e => {
          const parsed = textToBrands(e.target.value)
          const same = JSON.stringify(parsed) === JSON.stringify(DEFAULT_BRANDS)
          onChange(same ? null : parsed)
        }}
      />
      <div className="flex items-center gap-2 mt-1 text-xs text-slate-400">
        <span className="flex-1">{BRANDS_HELP}</span>
        {value != null && <button onClick={() => onChange(null)} className="hover:text-slate-700">Rétablir</button>}
      </div>
    </Row>
  )
}

// Affichage conditionnel : la question ne paraît sur le formulaire que si les
// réponses pilotes remplissent la condition. Les champs pilotes proposés
// dépendent de la section (une question de serre peut viser les réponses de la
// serre ; une question du formulaire, non).
function ConditionRules({ q, allCustom, form, onChange }) {
  const rules = q.visibleIf?.rules || []
  const match = q.visibleIf?.match === 'any' ? 'any' : 'all'
  const sources = conditionSources(q.section, allCustom, q.id)
  const commit = (next, m = match) => onChange({ visibleIf: next.length ? { match: m, rules: next } : null })
  const setRule = (i, patch) => commit(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const add = () => commit([...rules, { field: sources[0]?.field || '', op: 'eq', value: '' }])

  if (!rules.length) {
    return (
      <button onClick={add} className="btn-ghost btn-sm" disabled={!sources.length}>
        <Filter size={12} /> Afficher si…
      </button>
    )
  }
  return (
    <div className="space-y-1">
      {rules.map((r, i) => {
        const src = sources.find(s => s.field === r.field)
        const opts = conditionValueOptions(src, form)
        const numeric = conditionIsNumeric(src)
        const op = CONDITION_OPS.find(o => o.value === r.op)
        return (
          <div key={i} className="form-editor-condition grid items-center gap-2">
            <span className="text-[11px] text-slate-500 w-12 shrink-0 text-right">
              {i === 0 ? 'si' : (match === 'any' ? 'ou' : 'et')}
            </span>
            <select
              aria-label={`Champ de la condition ${i + 1}`} className="input text-xs py-1 min-w-0"
              value={r.field}
              onChange={e => {
                const next = sources.find(s => s.field === e.target.value)
                const keepOp = conditionIsNumeric(next) || !op?.numeric
                setRule(i, { field: e.target.value, value: '', op: keepOp ? r.op : 'eq' })
              }}
            >
              {!src && <option value={r.field}>{r.field}</option>}
              {sources.map(s => <option key={s.field} value={s.field}>{s.label}</option>)}
            </select>
            <select aria-label={`Opérateur de la condition ${i + 1}`} className="input text-xs py-1 min-w-0" value={r.op} onChange={e => setRule(i, { op: e.target.value })}>
              {CONDITION_OPS.filter(o => numeric || !o.numeric).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {!op?.noValue && (opts
              ? (
                <select aria-label={`Valeur de la condition ${i + 1}`} className="input text-xs py-1 min-w-0" value={r.value} onChange={e => setRule(i, { value: e.target.value })}>
                  <option value="">—</option>
                  {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <input
                  aria-label={`Valeur de la condition ${i + 1}`} className="input text-xs py-1 min-w-0"
                  type={numeric ? 'number' : 'text'}
                  value={r.value}
                  onChange={e => setRule(i, { value: e.target.value })}
                />
              ))}
            <button
              onClick={() => commit(rules.filter((_, j) => j !== i))}
              className="p-1 text-slate-400 hover:text-red-600 shrink-0"
              title="Retirer la condition"
            >
              <Trash2 size={12} />
            </button>
          </div>
        )
      })}
      <div className="flex items-center gap-2 pl-[3.25rem]">
        <button onClick={add} className="btn-ghost btn-sm"><Plus size={12} /> Condition</button>
        {rules.length > 1 && (
          <select aria-label="Combinaison des conditions" className="input text-xs py-1 w-32" value={match} onChange={e => commit(rules, e.target.value)}>
            <option value="all">toutes</option>
            <option value="any">au moins une</option>
          </select>
        )}
      </div>
    </div>
  )
}

// Choix de réponse d'une question ajoutée : une ligne par choix, ajout et
// retrait à l'unité. Même règle de valeur que les listes livrées par le code —
// la valeur suit le libellé tant que le choix n'est pas enregistré, puis se
// fige, de sorte qu'un renommage ne perde pas les réponses déjà données.
function CustomOptions({ options, onChange }) {
  const rows = Array.isArray(options) ? options : []
  const others = i => rows.filter((_, j) => j !== i).map(o => o.value)
  const set = (i, label) => onChange(rows.map((o, j) => (j === i
    ? { ...o, label, ...(o.fresh ? { value: slugChoiceValue(label, others(i)) } : {}) }
    : o)))
  const add = () => onChange([...rows, { value: slugChoiceValue('', rows.map(o => o.value)), label: '', fresh: true }])
  const drop = i => onChange(rows.filter((_, j) => j !== i))
  return (
    <div>
      {rows.length > 0 && (
        <div className="rounded-lg border border-slate-200 divide-y divide-slate-100 overflow-hidden">
          {rows.map((o, i) => (
            <div key={i} className="grid grid-cols-[1fr_1.75rem] items-center">
              <input aria-label={`Libellé du choix ${i + 1}`} className={CELL} value={o.label || ''} onChange={e => set(i, e.target.value)} />
              <button onClick={() => drop(i)} className="p-1 justify-self-center text-slate-400 hover:text-red-600" title="Retirer ce choix">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <button onClick={add} className="btn-ghost btn-sm mt-1"><Plus size={12} /> Choix</button>
    </div>
  )
}

function QuestionImagePicker({ value, focus, label, onChange }) {
  const id = useId()
  const input = useRef(null)
  const busy = useRef(false)
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')

  async function upload(files) {
    if (busy.current || !files?.length) return
    setError('')
    if (files.length !== 1) { setError('Déposez une seule image à la fois.'); return }
    const file = files[0]
    if (!/\.(jpe?g|png|webp|gif)$/i.test(file.name)) { setError('Utilisez une image JPG, PNG, WebP ou GIF.'); return }
    if (file.size > 10 * 1024 * 1024) { setError('L’image dépasse la limite de 10 Mo.'); return }
    busy.current = true
    setUploading(true)
    try {
      const result = await api.discoveryFormSchema.uploadImage(file)
      onChange(result.image)
    } catch (err) { setError(err.message || 'Impossible de charger l’image. Réessayez.') }
    finally { busy.current = false; setUploading(false) }
  }

  return (
    <div className="py-3" data-image-question={label}>
      <div id={id} className="text-sm text-slate-700 mb-2">{label}</div>
      <div
        className={`flex flex-col sm:flex-row items-center gap-3 rounded-lg border-2 border-dashed p-4 ${dragging ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-slate-50/50'}`}
        onDragOver={e => { e.preventDefault(); if (!busy.current) setDragging(true) }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false) }}
        onDrop={e => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files) }}
        aria-busy={uploading}
      >
        {value !== 'none' && <GreenhouseIllustration image={value} focus={focus} height={80} label={label} />}
        <div className="flex-1 min-w-0 w-full space-y-2">
          <p className="text-sm text-slate-600" role="status">{uploading ? 'Chargement de l’image…' : 'Glissez une image ici'}</p>
          <input ref={input} type="file" className="sr-only" tabIndex={-1} accept=".jpg,.jpeg,.png,.webp,.gif" aria-labelledby={id} disabled={uploading} onChange={e => { upload(e.target.files); e.target.value = '' }} />
          <button type="button" className="btn-secondary btn-sm" disabled={uploading} onClick={() => input.current?.click()}>{value === 'none' ? 'Choisir une image' : 'Charger une image'}</button>
          <p className="text-xs text-slate-500">JPG, PNG, WebP ou GIF · 10 Mo maximum</p>
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-red-600 mt-2">{error}</p>}
      <div className="flex flex-wrap gap-3 mt-2">
        {value !== 'none' && <button type="button" disabled={uploading} className="text-xs text-red-600 hover:underline disabled:opacity-50" onClick={() => { setError(''); onChange('none') }}>Retirer l’image</button>}
        {!!value && <button type="button" disabled={uploading} className="text-xs text-slate-500 hover:underline disabled:opacity-50" onClick={() => { setError(''); onChange('') }}>Rétablir l’image d’origine</button>}
      </div>
    </div>
  )
}

function CustomQuestionRow({ q, allCustom, form, onChange, onRemove, onMove, onDuplicate, first, last }) {
  const needsOptions = q.type === 'select' || q.type === 'radio'
  return (
    <div data-question-id={q.id} className="form-editor-question rounded-lg bg-slate-50 border border-slate-200 p-3 flex items-start gap-4">
      <div className={`${ROW_GRID} flex-1 min-w-0`}>
        <div className="form-editor-question-actions flex flex-wrap items-center gap-1 pb-1">
          <span className="text-xs font-medium text-slate-500 mr-auto">Question ajoutée</span>
          <button onClick={() => onMove(-1)} disabled={first} className="btn-ghost btn-sm" aria-label="Monter la question" title="Monter"><ArrowUp size={14} /></button>
          <button onClick={() => onMove(1)} disabled={last} className="btn-ghost btn-sm" aria-label="Descendre la question" title="Descendre"><ArrowDown size={14} /></button>
          <button onClick={onDuplicate} className="btn-ghost btn-sm" aria-label="Dupliquer la question" title="Dupliquer"><Copy size={14} /></button>
        </div>
        <Row label="Question">
          <div className="flex items-center gap-2">
            <input aria-label="Question" className="input py-1.5 flex-1 min-w-0" value={q.label} onChange={e => onChange({ label: e.target.value })} />
            <button onClick={onRemove} className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg shrink-0" title="Retirer la question">
              <Trash2 size={14} />
            </button>
          </div>
        </Row>
        <Row label="Aide">
          <input aria-label="Aide de la question" className="input py-1.5 text-xs" value={q.help || ''} onChange={e => onChange({ help: e.target.value })} />
        </Row>
        <Row label="Réponse">
          <div className="flex flex-wrap items-center gap-3">
            <select aria-label="Type de réponse" className="input py-1.5 w-44 max-w-full" value={q.type} onChange={e => onChange({ type: e.target.value })}>
              {CUSTOM_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-600">
              <input type="checkbox" checked={!!q.required} onChange={e => onChange({ required: e.target.checked })} />
              Obligatoire
            </label>
          </div>
        </Row>
        {needsOptions && (
          <Row label="Choix">
            <CustomOptions options={q.options} onChange={options => onChange({ options })} />
          </Row>
        )}
        <Row label="Section">
          <select aria-label="Section de la question" className="input py-1.5 w-56 max-w-full" value={q.section} onChange={e => onChange({ section: e.target.value })}>
            {CUSTOM_SECTIONS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </Row>
        <Row label="Image">
          <QuestionImagePicker value={q.image} focus={focusForSection(q.section)} label="Image à côté de la question" onChange={image => onChange({ image })} />
        </Row>
        <Row label="Condition">
          <ConditionRules q={q} allCustom={allCustom} form={form} onChange={onChange} />
        </Row>
      </div>
    </div>
  )
}

// Découpe les items d'un groupe en blocs : un bloc = un sujet (même illustration),
// ou un bloc masquable (`kind: 'group'`) et les libellés qui le suivent.
// `toggle` : l'item masquable qui porte l'interrupteur ; `hiddenBy` : l'id du
// bloc masquable dont dépend l'affichage (le sien, ou celui donné par `under`).
function blocksOf(group) {
  const blocks = []
  for (const item of group.items) {
    const focus = focusForSchemaItem(item.id)
    const last = blocks[blocks.length - 1]
    if (item.kind === 'group' || !last || last.focus !== focus) {
      blocks.push({ focus, toggle: null, hiddenBy: null, items: [] })
    }
    const block = blocks[blocks.length - 1]
    if (item.kind === 'group') {
      block.toggle = item
      block.hiddenBy = item.id
    } else {
      if (!block.hiddenBy && item.under) block.hiddenBy = item.under
      block.items.push(item)
    }
  }
  return blocks
}

function Block({ block, schema, setText, setChoices, setBrands, setHidden }) {
  const hidden = !!(block.hiddenBy && schema.hidden[block.hiddenBy])
  const showScene = block.focus !== 'overview'
  const title = block.toggle ? block.toggle.label : (showScene ? focusLabel(block.focus) : null)
  return (
    <div className="form-editor-block flex items-start gap-4 px-4 py-3">
      <div className="flex-1 min-w-0">
        {(title || block.toggle) && (
          <div className="flex items-center gap-2 mb-2">
            <span className={`text-xs font-medium ${hidden ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{title}</span>
            {block.toggle && (
              <button
                onClick={() => setHidden(block.toggle.id, !hidden)}
                className={`ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] ${hidden ? 'bg-slate-100 text-slate-500' : 'bg-brand-50 text-brand-700'}`}
                title={hidden ? 'Afficher ce bloc sur le formulaire' : 'Masquer ce bloc du formulaire'}
              >
                {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                {hidden ? 'Masqué' : 'Affiché'}
              </button>
            )}
          </div>
        )}
        <div className={`${ROW_GRID} ${hidden ? 'opacity-50' : ''}`}>
          {block.items.map(item => (
            item.kind === 'choices'
              ? <ChoicesItem key={item.id} item={item} value={schema.choices[item.id]} onChange={v => setChoices(item.id, v)} />
              : item.kind === 'brands'
                ? <BrandsItem key={item.id} item={item} value={schema.brands} onChange={setBrands} />
                : <TextItem key={item.id} item={item} value={schema.texts[item.id]} onChange={v => setText(item.id, v)} />
          ))}
        </div>
      </div>
    </div>
  )
}

// Nombre de surcharges d'un groupe : ce que la barre de sections affiche.
function groupChanges(group, schema, questions) {
  let n = questions.length + QUESTION_IMAGES.filter(([groupId, id]) => groupId === group.id && schema.images?.[id]).length
  for (const item of group.items) {
    if (item.kind === 'group') { if (schema.hidden[item.id]) n++ }
    else if (item.kind === 'choices') { if (schema.choices[item.id] != null) n++ }
    else if (item.kind === 'brands') { if (schema.brands != null) n++ }
    else if (schema.texts[item.id]) n++
  }
  return n
}

const OTHER = 'other'
const EDITOR_CATEGORIES = [
  { title: 'Accueil et coordonnées', sections: ['header', 'order_type', 'farm', 'shipping'] },
  { title: 'Installation', sections: ['network', 'greenhouses', 'louvers', 'chief', 'furnace', 'humidity'] },
  { title: 'Finalisation', sections: ['submit', OTHER] },
  { title: 'Configuration interne', sections: ['equipment'] },
]
const SECTION_DESCRIPTIONS = {
  header: 'La première chose que le client lit.',
  order_type: 'Distinguer un nouveau site d’un agrandissement.',
  farm: 'Les coordonnées du site de production.',
  shipping: 'Le lieu de livraison des équipements.',
  network: 'La connexion Internet et les identifiants Wi-Fi.',
  greenhouses: 'Questions répétées pour chaque serre.',
  louvers: 'Le voltage, le type de commande et le ventilateur associé à chaque louvre.',
  humidity: 'Questions affichées uniquement avec l’option conservation de l’humidité.',
  chief: 'Chauffage et irrigation des serres Chef de culture.',
  furnace: 'Questions répétées pour chaque fournaise.',
  submit: 'Le bouton d’envoi et la confirmation.',
  equipment: 'Les produits utilisés pour préparer la commande.',
}
function EditorSection({ id, title, children }) {
  return <section aria-labelledby={`editor-heading-${id}`}>
    <div className="mb-5">
      <h2 id={`editor-heading-${id}`} className="text-xl font-semibold text-slate-900">{title}</h2>
      {SECTION_DESCRIPTIONS[id] && <p className="mt-1 text-sm text-slate-500">{SECTION_DESCRIPTIONS[id]}</p>}
    </div>
    {children}
  </section>
}

export default function DiscoveryFormEditor() {
  const confirm = useConfirm()
  const { addToast } = useToast()
  const [activeSection, setActiveSection] = useState('header')
  const [schema, setSchema] = useState(null)
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [resetting, setResetting] = useState(false)
  const pendingFocus = useRef(null)
  const [meta, setMeta] = useState({ updated_at: null, updated_by: null })
  const { status: saveState, save: runSave } = useSaveStatus()
  // Dernier calque connu du serveur, et l'envoi encore en attente de sa pause
  // de frappe : ensemble ils disent s'il reste quelque chose à enregistrer.
  const savedJson = useRef(null)
  const flush = useRef(null)
  const inFlight = useRef(false)

  useEffect(() => {
    api.discoveryFormSchema.get()
      .then(d => {
        const loaded = { ...emptyOverrides(), ...(d.schema || {}) }
        savedJson.current = JSON.stringify(loaded)
        setSchema(loaded)
        setMeta({ updated_at: d.updated_at, updated_by: d.updated_by })
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const schemaJson = useMemo(() => (schema ? JSON.stringify(schema) : null), [schema])

  // Autosave : chaque changement part tout seul après une courte pause. La
  // réponse du serveur n'est pas adoptée dans l'état local — elle a été
  // normalisée (un libellé vidé pour être réécrit y est absent) et l'écraser
  // ferait disparaître la question sous les doigts de l'utilisateur. Le
  // marqueur `fresh` d'un choix ajouté survit donc tant qu'on reste sur la
  // page : sa valeur suit son libellé pendant toute la séance d'édition et ne
  // se fige qu'au rechargement, ce qui est bien ce qu'on veut ici.
  useEffect(() => {
    if (schemaJson == null || schemaJson === savedJson.current) {
      flush.current = null
      return
    }
    const send = async () => {
      flush.current = null
      savedJson.current = schemaJson
      inFlight.current = true
      const ok = await runSave(async () => {
        const res = await api.discoveryFormSchema.save(JSON.parse(schemaJson))
        setMeta({ updated_at: res.updated_at || null, updated_by: res.updated_by || null })
      })
      inFlight.current = false
      // Échec : on oublie le repère pour que la prochaine retouche renvoie tout.
      if (!ok) savedJson.current = null
    }
    flush.current = send
    const timer = setTimeout(send, AUTOSAVE_MS)
    return () => clearTimeout(timer)
  }, [schemaJson, runSave])

  // Quitter la page n'attend pas la pause de frappe : l'envoi part tout de suite.
  useEffect(() => () => { flush.current?.() }, [])
  useEffect(() => { api.products.list({ limit: 500 }).then(r => setProducts(r.data || [])).catch(() => {}) }, [])

  useEffect(() => {
    const id = pendingFocus.current
    if (!id) return
    const input = document.querySelector(`[data-question-id="${id}"] input[aria-label="Question"]`)
    if (input) {
      input.focus()
      input.select()
      pendingFocus.current = null
    }
  }, [schema])

  // Fermer l'onglet pendant qu'un envoi reste en attente demande confirmation.
  useEffect(() => {
    const onUnload = (e) => {
      if (!flush.current && !inFlight.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  const customBySection = useMemo(() => {
    const map = {}
    for (const q of schema?.custom || []) (map[q.section] ||= []).push(q)
    return map
  }, [schema])

  // Questions déposées dans une section sans groupe de textes propre.
  const orphans = useMemo(() => {
    const grouped = SCHEMA_GROUPS.map(g => g.section).filter(Boolean)
    return (schema?.custom || []).filter(q => !grouped.includes(q.section))
  }, [schema])

  // Formulaire fusionné : sert à proposer les libellés de choix réels comme
  // valeurs de comparaison dans les conditions d'affichage.
  const mergedForm = useMemo(() => buildForm(schema || {}), [schema])

  const counts = useMemo(() => {
    if (!schema) return {}
    const m = { [OTHER]: orphans.length, equipment: Object.values(schema.equipment?.products || {}).filter(Boolean).length + Object.keys(schema.equipment?.outputs || {}).length }
    for (const g of SCHEMA_GROUPS) m[g.id] = groupChanges(g, schema, g.section ? (customBySection[g.section] || []) : [])
    return m
  }, [schema, customBySection, orphans.length])

  function patch(fn) {
    setSchema(s => fn(structuredClone(s)))
  }
  const setImage = (id, value) => patch(s => {
    s.images ||= {}
    if (value) s.images[id] = value
    else delete s.images[id]
    return s
  })
  const setText = (id, v) => patch(s => { if (v) s.texts[id] = v; else delete s.texts[id]; return s })
  const setChoices = (id, v) => patch(s => { if (v) s.choices[id] = v; else delete s.choices[id]; return s })
  const setHidden = (id, v) => patch(s => { if (v) s.hidden[id] = true; else delete s.hidden[id]; return s })
  const setBrands = (v) => patch(s => { s.brands = v; return s })
  const setEquipmentProduct = (role, productId) => patch(s => {
    s.equipment ||= { products: {} }; s.equipment.products ||= {}
    if (productId) s.equipment.products[role] = productId
    else delete s.equipment.products[role]
    return s
  })

  const setEquipmentOutput = (role, value) => patch(s => {
    s.equipment ||= { products: {} }
    s.equipment.outputs ||= {}
    if (value === '') delete s.equipment.outputs[role]
    else s.equipment.outputs[role] = Number(value)
    return s
  })

  function addQuestion(section) {
    const id = `q_${crypto.randomUUID()}`
    pendingFocus.current = id
    patch(s => {
      s.custom.push({
        id,
        section, type: 'text', label: 'Nouvelle question', help: '', required: false, options: [],
      })
      return s
    })
  }
  // Changer de section change les champs pilotes disponibles : les conditions
  // devenues hors de portée sont retirées plutôt que laissées inertes.
  const updateQuestion = (id, p) => {
    if (p.section) {
      setActiveSection(SCHEMA_GROUPS.find(g => g.section === p.section)?.id || OTHER)
      pendingFocus.current = id
    }
    patch(s => {
      s.custom = s.custom.map(q => {
        if (q.id !== id) return q
        const next = { ...q, ...p }
        if (p.section && p.section !== q.section && next.visibleIf?.rules?.length) {
          const allowed = new Set(conditionSources(next.section, s.custom, id).map(x => x.field))
          const rules = next.visibleIf.rules.filter(r => allowed.has(r.field))
          next.visibleIf = rules.length ? { ...next.visibleIf, rules } : null
        }
        return next
      })
      return s
  })
  }
  function moveQuestion(id, direction) {
    patch(s => {
      const index = s.custom.findIndex(q => q.id === id)
      const peers = s.custom.map((q, i) => q.section === s.custom[index].section ? i : -1).filter(i => i >= 0)
      const target = peers[peers.indexOf(index) + direction]
      if (target != null) [s.custom[index], s.custom[target]] = [s.custom[target], s.custom[index]]
      return s
    })
  }
  function duplicateQuestion(id) {
    const copyId = `q_${crypto.randomUUID()}`
    pendingFocus.current = copyId
    patch(s => {
      const index = s.custom.findIndex(q => q.id === id)
      const copy = { ...structuredClone(s.custom[index]), id: copyId, label: `${s.custom[index].label} (copie)` }
      s.custom.splice(index + 1, 0, copy)
      return s
    })
  }
  async function removeQuestion(id) {
    const question = schema.custom.find(q => q.id === id)
    if (!(await confirm(`Retirer « ${question.label} » du formulaire ?`))) return
    patch(s => { s.custom = s.custom.filter(q => q.id !== id); return s })
  }

  async function reset() {
    if (!(await confirm('Rétablir le formulaire d’origine ? Vos textes et questions ajoutées seront perdus.'))) return
    setResetting(true)
    try {
      await api.discoveryFormSchema.reset()
      const empty = emptyOverrides()
      // Le repère suit le retour à vide, sinon l'autosave rewriterait aussitôt
      // un calque (et la page afficherait « Modifié le … »).
      savedJson.current = JSON.stringify(empty)
      setSchema(empty)
      setMeta({ updated_at: null, updated_by: null })
      addToast({ message: 'Formulaire d’origine rétabli', type: 'success' })
    } catch (e) {
      addToast({ message: e.message || 'Erreur', type: 'error' })
    } finally { setResetting(false) }
  }

  if (loading) return <Layout><Spinner label="Chargement…" /></Layout>
  if (error) return <Layout><div className="p-6"><ErrorBanner>{error}</ErrorBanner></div></Layout>

  const totalChanges = Object.values(counts).reduce((a, b) => a + b, 0)

  function renderQuestions(list, section) {
    return (
      <div className="px-4 py-3 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-slate-700">Questions ajoutées</span>
          {section && (
            <button onClick={() => addQuestion(section)} className="btn-ghost btn-sm ml-auto">
              <Plus size={12} /> Question
            </button>
          )}
        </div>
        {list.map(q => (
          <CustomQuestionRow
            key={q.id}
            q={q}
            allCustom={schema.custom}
            form={mergedForm}
            onChange={p => updateQuestion(q.id, p)}
            onRemove={() => removeQuestion(q.id)}
            onMove={direction => moveQuestion(q.id, direction)}
            onDuplicate={() => duplicateQuestion(q.id)}
            first={customBySection[q.section]?.[0]?.id === q.id}
            last={customBySection[q.section]?.at(-1)?.id === q.id}
          />
        ))}
      </div>
    )
  }

  return (
    <Layout>
      <div className="form-editor p-6 lg:p-8 max-w-[1500px] mx-auto">
        <div className="form-editor-header flex flex-wrap items-start justify-between gap-4 mb-7 py-5 border-b border-slate-200">
          <div>
            <PageTitle className="mb-1">Form builder</PageTitle>
            <p className="text-xs text-slate-500">
              {meta.updated_at
                ? `Modifié le ${fmtDate(meta.updated_at)}${meta.updated_by ? ` par ${meta.updated_by}` : ''}`
                : 'Textes d’origine'}
              {' · '}
              <Link to="/discovery-forms" className="link-record">System builder</Link>
              {' · '}
              S’applique aux liens déjà envoyés
            </p>
          </div>
          <div className="flex items-center gap-3">
            <SaveStatus status={saveState} />
            <button onClick={reset} disabled={resetting || !totalChanges} className="btn-ghost" title="Rétablir le formulaire d’origine" aria-label="Rétablir le formulaire d’origine"><RotateCcw size={16} /></button>
          </div>
        </div>

        <div className="form-editor-workspace">
        <nav aria-label="Sections du formulaire" className="form-editor-sidebar space-y-6">
          {EDITOR_CATEGORIES.map(category => <div key={category.title}>
            <h2 className="px-3 mb-2 text-xs font-semibold text-slate-500">{category.title}</h2>
            <div className="space-y-1">
              {category.sections.filter(id => id !== OTHER || orphans.length).map(id => {
                const label = id === 'equipment' ? 'Produits associés' : id === OTHER ? 'Autres questions' : SCHEMA_GROUPS.find(g => g.id === id).title
                return <button key={id} aria-current={activeSection === id ? 'page' : undefined} onClick={() => setActiveSection(id)} className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm text-left ${activeSection === id ? 'bg-brand-50 text-brand-800 font-semibold' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}>
                  <span className="flex-1">{label}</span>
                  {!!counts[id] && <span className="text-xs tabular-nums opacity-70" title="Personnalisations">{counts[id]}</span>}
                </button>
              })}
            </div>
          </div>)}
        </nav>
        <fieldset disabled={resetting} aria-busy={resetting} className="min-w-0">
        <legend className="sr-only">Contenu du formulaire</legend>
        {SCHEMA_GROUPS.filter(group => group.id === activeSection).map(group => {
          const questions = group.section ? (customBySection[group.section] || []) : []
          const blocks = blocksOf(group)
          return (
            <EditorSection key={group.id} id={group.id} title={group.title}>
              <div className="card divide-y divide-slate-100">
                {blocks.map((b, i) => (
                  <Block
                    key={i}
                    block={b}
                    schema={schema}
                    setText={setText}
                    setChoices={setChoices}
                    setBrands={setBrands}
                    setHidden={setHidden}
                  />
                ))}
                {QUESTION_IMAGES.some(([groupId]) => groupId === group.id) && (
                  <div className="px-4 py-3">
                    <h3 className="text-sm font-medium text-slate-800">Images des questions</h3>
                    <p className="text-xs text-slate-500 mt-1">Chargez une image depuis votre ordinateur pour chaque question, ou retirez son illustration.</p>
                    <div className="divide-y divide-slate-100">
                      {QUESTION_IMAGES.filter(([groupId]) => groupId === group.id).map(([, id, focus, label]) => (
                        <QuestionImagePicker key={id} label={label || mergedForm.t(id)} focus={focus} value={schema.images?.[id]} onChange={value => setImage(id, value)} />
                      ))}
                    </div>
                  </div>
                )}
                {group.section && (questions.length > 0
                  ? renderQuestions(questions, group.section)
                  : (
                    <div className="px-4 py-2 flex">
                      <button onClick={() => addQuestion(group.section)} className="btn-ghost btn-sm ml-auto">
                        <Plus size={12} /> Question
                      </button>
                    </div>
                  ))}
              </div>
            </EditorSection>
          )
        })}

        {activeSection === OTHER && orphans.length > 0 && (
          <EditorSection id={OTHER} title="Autres questions">
            <div className="card">{renderQuestions(orphans, null)}</div>
          </EditorSection>
        )}

        {activeSection === 'equipment' && <EditorSection id="equipment" title="Produits associés">
          <div className="card p-4">
            <p className="text-xs text-slate-500 mb-3">Associez un produit du catalogue à chaque équipement.</p>
            <fieldset className="border-b border-slate-200 pb-5 mb-5 space-y-3"><legend className="text-sm font-semibold mb-2">Sorties V2 par appareil</legend>
              {EQUIPMENT_OUTPUTS.map(([role, label]) => <label key={role} className="flex items-center justify-between gap-3 text-sm text-slate-700"><span>{label}</span><select className="input w-28" value={schema.equipment?.outputs?.[role] ?? ''} onChange={e => setEquipmentOutput(role, e.target.value)}><option value="">À définir</option>{Array.from({ length: 9 }, (_, i) => <option key={i} value={i}>{i}</option>)}</select></label>)}
            </fieldset>
            <div className="grid grid-cols-1 gap-3">
              {EQUIPMENT_PRODUCT_GROUPS.map(group => <div key={group.label} className="space-y-3 border-t border-slate-100 pt-4 first:border-0 first:pt-0"><h3 className="text-sm font-semibold text-slate-900">{group.label}</h3>{group.products.map(([role, label]) => {
                const selected = schema.equipment?.products?.[role] || ''
                return <div key={role} className="grid grid-cols-1 sm:grid-cols-[11rem_minmax(0,1fr)] gap-2 sm:gap-3 items-center"><span className="text-sm text-slate-600">{label}</span><div className="flex items-center gap-2"><SearchableSelect value={selected} options={products} onChange={v => setEquipmentProduct(role, v)} emptyOption="Aucun produit" placeholder="Choisir un produit" size="sm" getOptionValue={p => p.id} getOptionLabel={p => `${p.name_fr}${p.sku ? ` · ${p.sku}` : ''}`} /><>{selected && <Link to={`/products/${selected}`} className="link-record text-xs shrink-0">Fiche</Link>}</></div></div>
              })}</div>)}
            </div>
          </div>
        </EditorSection>}
        </fieldset>
        </div>
      </div>
    </Layout>
  )
}
