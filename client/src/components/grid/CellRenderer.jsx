import { useState, useRef, useEffect } from 'react'
import { ExternalLink, Check, X, Paperclip, Link } from 'lucide-react'

// ── Display (read-only) ──────────────────────────────────────────────────────

function TextDisplay({ value }) {
  if (value == null || value === '') return null
  return <span className="truncate">{String(value)}</span>
}

function NumberDisplay({ value }) {
  if (value == null || value === '') return null
  return <span className="font-mono">{Number(value).toLocaleString()}</span>
}

function BoolDisplay({ value }) {
  if (!value && value !== false) return null
  const on = value === true || value === 1 || value === 'true' || value === '1'
  return on
    ? <Check size={14} className="text-emerald-500" />
    : <X size={14} className="text-slate-400" />
}

function DateDisplay({ value, withTime }) {
  if (!value) return null
  try {
    const d = new Date(value)
    if (isNaN(d)) return <span className="truncate text-slate-400">{value}</span>
    const fmt = withTime
      ? d.toLocaleString('fr-CA', { dateStyle: 'short', timeStyle: 'short' })
      : d.toLocaleDateString('fr-CA')
    return <span className="truncate">{fmt}</span>
  } catch {
    return <span className="truncate text-slate-400">{value}</span>
  }
}

function UrlDisplay({ value }) {
  if (!value) return null
  return (
    <a
      href={value}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      className="flex items-center gap-1 text-indigo-600 hover:underline truncate"
    >
      <ExternalLink size={12} className="flex-shrink-0" />
      <span className="truncate">{value}</span>
    </a>
  )
}

function EmailDisplay({ value }) {
  if (!value) return null
  return (
    <a
      href={`mailto:${value}`}
      onClick={e => e.stopPropagation()}
      className="text-indigo-600 hover:underline truncate"
    >
      {value}
    </a>
  )
}

function SelectDisplay({ value, options = [] }) {
  if (!value) return null
  const opt = options.find(o => o.value === value || o.id === value)
  const label = opt?.label || opt?.name || value
  const color = opt?.color || 'slate'
  return (
    <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium bg-${color}-100 text-${color}-700 truncate max-w-full`}>
      {label}
    </span>
  )
}

function MultiSelectDisplay({ value, options = [] }) {
  const vals = Array.isArray(value) ? value : (value ? [value] : [])
  if (!vals.length) return null
  return (
    <div className="flex flex-wrap gap-1 overflow-hidden">
      {vals.slice(0, 3).map((v, i) => {
        const opt = options.find(o => o.value === v || o.id === v)
        const label = opt?.label || opt?.name || v
        const color = opt?.color || 'slate'
        return (
          <span key={i} className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium bg-${color}-100 text-${color}-700`}>
            {label}
          </span>
        )
      })}
      {vals.length > 3 && <span className="text-xs text-slate-400">+{vals.length - 3}</span>}
    </div>
  )
}

function AttachmentDisplay({ value }) {
  const files = Array.isArray(value) ? value : []
  if (!files.length) return null
  return (
    <div className="flex items-center gap-1">
      <Paperclip size={12} className="text-slate-400 flex-shrink-0" />
      <span className="text-xs text-slate-500">{files.length} fichier{files.length > 1 ? 's' : ''}</span>
    </div>
  )
}

function LinkDisplay({ value }) {
  const ids = Array.isArray(value) ? value : (value ? [value] : [])
  if (!ids.length) return null
  return (
    <div className="flex items-center gap-1">
      <Link size={12} className="text-slate-400 flex-shrink-0" />
      <span className="text-xs text-slate-500">{ids.length} lié{ids.length > 1 ? 's' : ''}</span>
    </div>
  )
}

// ── Edit inputs ──────────────────────────────────────────────────────────────

function TextEdit({ value, onCommit, onCancel, multiline }) {
  const [v, setV] = useState(value ?? '')
  const ref = useRef()

  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])

  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
    if (!multiline && e.key === 'Enter') { e.stopPropagation(); onCommit(v) }
    if (multiline && e.key === 'Enter' && !e.shiftKey) { e.stopPropagation(); onCommit(v) }
  }

  if (multiline) {
    return (
      <textarea
        ref={ref}
        value={v}
        onChange={e => setV(e.target.value)}
        onBlur={() => onCommit(v)}
        onKeyDown={onKey}
        rows={3}
        className="absolute inset-0 w-full h-auto min-h-full px-2 py-1 text-sm bg-white border-2 border-indigo-500 rounded resize-none outline-none z-10 shadow-lg"
      />
    )
  }
  return (
    <input
      ref={ref}
      type="text"
      value={v}
      onChange={e => setV(e.target.value)}
      onBlur={() => onCommit(v)}
      onKeyDown={onKey}
      className="absolute inset-0 w-full px-2 py-1 text-sm bg-white border-2 border-indigo-500 rounded outline-none z-10"
    />
  )
}

function NumberEdit({ value, onCommit, onCancel }) {
  const [v, setV] = useState(value ?? '')
  const ref = useRef()
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
    if (e.key === 'Enter') { e.stopPropagation(); onCommit(v === '' ? null : Number(v)) }
  }
  return (
    <input
      ref={ref}
      type="number"
      value={v}
      onChange={e => setV(e.target.value)}
      onBlur={() => onCommit(v === '' ? null : Number(v))}
      onKeyDown={onKey}
      className="absolute inset-0 w-full px-2 py-1 text-sm font-mono bg-white border-2 border-indigo-500 rounded outline-none z-10"
    />
  )
}

function SelectEdit({ value, options = [], onCommit, onCancel }) {
  const ref = useRef()
  useEffect(() => { ref.current?.focus() }, [])
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
  }
  return (
    <select
      ref={ref}
      defaultValue={value ?? ''}
      onChange={e => onCommit(e.target.value || null)}
      onBlur={onCancel}
      onKeyDown={onKey}
      className="absolute inset-0 w-full px-2 py-1 text-sm bg-white border-2 border-indigo-500 rounded outline-none z-10"
    >
      <option value="">— vide —</option>
      {options.map(o => (
        <option key={o.value || o.id} value={o.value || o.id}>{o.label || o.name}</option>
      ))}
    </select>
  )
}

function BoolEdit({ value, onCommit }) {
  const on = value === true || value === 1 || value === 'true' || value === '1'
  useEffect(() => { onCommit(!on) }, []) // toggle immediately
  return null
}

function DateEdit({ value, onCommit, onCancel, withTime }) {
  const [v, setV] = useState(() => {
    if (!value) return ''
    const d = new Date(value)
    if (isNaN(d)) return ''
    if (withTime) return d.toISOString().slice(0, 16)
    return d.toISOString().slice(0, 10)
  })
  const ref = useRef()
  useEffect(() => { ref.current?.focus() }, [])
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
    if (e.key === 'Enter') { e.stopPropagation(); onCommit(v || null) }
  }
  return (
    <input
      ref={ref}
      type={withTime ? 'datetime-local' : 'date'}
      value={v}
      onChange={e => setV(e.target.value)}
      onBlur={() => onCommit(v || null)}
      onKeyDown={onKey}
      className="absolute inset-0 w-full px-2 py-1 text-sm bg-white border-2 border-indigo-500 rounded outline-none z-10"
    />
  )
}

// ── Main CellRenderer ────────────────────────────────────────────────────────

export function CellRenderer({ field, value, editing, onCommit, onCancel }) {
  const type = field?.type || 'text'
  const options = field?.options?.choices || field?.options?.options || []
  const readonly = ['formula', 'lookup', 'rollup', 'created_at', 'updated_at', 'autonumber'].includes(type)

  // Edit mode
  if (editing && !readonly) {
    switch (type) {
      case 'number':
        return <NumberEdit value={value} onCommit={onCommit} onCancel={onCancel} />
      case 'select':
        return <SelectEdit value={value} options={options} onCommit={onCommit} onCancel={onCancel} />
      case 'boolean':
        return <BoolEdit value={value} onCommit={onCommit} onCancel={onCancel} />
      case 'date':
        return <DateEdit value={value} onCommit={onCommit} onCancel={onCancel} />
      case 'datetime':
        return <DateEdit value={value} onCommit={onCommit} onCancel={onCancel} withTime />
      case 'long_text':
        return <TextEdit value={value} onCommit={onCommit} onCancel={onCancel} multiline />
      default:
        return <TextEdit value={value} onCommit={onCommit} onCancel={onCancel} />
    }
  }

  // Display mode
  switch (type) {
    case 'number':      return <NumberDisplay value={value} />
    case 'boolean':     return <BoolDisplay value={value} />
    case 'date':        return <DateDisplay value={value} />
    case 'datetime':    return <DateDisplay value={value} withTime />
    case 'email':       return <EmailDisplay value={value} />
    case 'url':         return <UrlDisplay value={value} />
    case 'select':      return <SelectDisplay value={value} options={options} />
    case 'multi_select': return <MultiSelectDisplay value={value} options={options} />
    case 'attachment':  return <AttachmentDisplay value={value} />
    case 'link':        return <LinkDisplay value={value} />
    case 'rollup':
    case 'lookup':
    case 'formula':     return <TextDisplay value={value == null ? '' : String(value)} />
    case 'autonumber':  return <span className="font-mono text-slate-500 text-xs">{value}</span>
    default:            return <TextDisplay value={value} />
  }
}
