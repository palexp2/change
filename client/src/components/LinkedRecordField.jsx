import { useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { Plus, X, Search } from 'lucide-react'

export default function LinkedRecordField({
  value,
  options,
  labelFn,
  getHref,
  placeholder,
  saving = false,
  disabled = false,
  onChange,
  allowClear = true,
  name,
}) {
  const fieldTestId = name ? `linked-record-field-${name}` : 'linked-record-field'
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 })
  const btnRef = useRef(null)
  const inputRef = useRef(null)

  const getLabel = labelFn || (o => o?.name ?? String(o?.id ?? ''))
  const hasValue = value != null && value !== ''
  const selected = hasValue ? options.find(o => String(o.id) === String(value)) : null

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return options.slice(0, 60)
    return options.filter(o => getLabel(o).toLowerCase().includes(q)).slice(0, 60)
  }, [options, search, getLabel])

  useEffect(() => {
    if (!open) { setSearch(''); return }
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) setPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 240) })
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 0)
    function handler(e) {
      const portal = document.getElementById('linked-record-portal')
      if (!btnRef.current?.contains(e.target) && !portal?.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => {
      clearTimeout(focusTimer)
      document.removeEventListener('mousedown', handler)
    }
  }, [open])

  const spinner = saving && (
    <span className="inline-block w-3 h-3 border border-slate-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
  )

  if (selected) {
    const href = getHref ? getHref(selected) : null
    const label = getLabel(selected)
    const bodyCls = 'text-sm text-slate-700 truncate'
    return (
      <div className="flex items-center gap-1.5 min-w-0" data-testid={fieldTestId} data-state="selected">
        <span className="inline-flex items-center gap-0.5 bg-slate-100 hover:bg-slate-200/70 rounded-md max-w-full transition-colors">
          {href ? (
            <Link
              to={href}
              className={`${bodyCls} pl-2.5 pr-1 py-1 hover:text-indigo-600 hover:underline`}
              data-testid="linked-record-link"
            >
              {label}
            </Link>
          ) : (
            <span className={`${bodyCls} pl-2.5 pr-1 py-1`}>{label}</span>
          )}
          {allowClear && (
            <button
              type="button"
              onClick={() => !saving && !disabled && onChange(null)}
              disabled={saving || disabled}
              className="p-1 mr-0.5 rounded text-slate-400 hover:text-red-500 hover:bg-slate-300/60 disabled:opacity-50"
              aria-label="Délier"
              data-testid="linked-record-clear"
            >
              <X size={12} />
            </button>
          )}
        </span>
        {spinner}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1.5 min-w-0" data-testid={fieldTestId} data-state="empty">
      <button
        ref={btnRef}
        type="button"
        onClick={() => !disabled && !saving && setOpen(o => !o)}
        disabled={disabled || saving}
        className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-slate-100 text-slate-400 hover:bg-slate-200 hover:text-slate-600 disabled:opacity-50 transition-colors"
        data-testid="linked-record-add"
      >
        <Plus size={12} />
        {placeholder && <span>{placeholder}</span>}
      </button>
      {spinner}
      {open && createPortal(
        <div
          id="linked-record-portal"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 }}
          className="bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden"
        >
          <div className="p-2 border-b border-slate-100">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                ref={inputRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-400"
                placeholder="Rechercher..."
              />
            </div>
          </div>
          <div className="max-h-52 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-3">Aucun résultat</p>
            ) : filtered.map(o => (
              <button
                key={o.id}
                type="button"
                onClick={() => { onChange(o.id); setOpen(false) }}
                className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                {getLabel(o)}
              </button>
            ))}
            {!search && options.length > 60 && (
              <div className="px-3 py-2 text-xs text-slate-400 border-t border-slate-100">
                {options.length - 60} autres — affinez la recherche
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
