import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Search, Check, X } from 'lucide-react'
import { Badge } from './Badge.jsx'
import { parseMultiSelectItems } from '../lib/customFieldDisplay.jsx'

// Champ de sélection multiple (façon Airtable) pour une fiche détail : les
// valeurs retenues s'affichent en pastilles retirables, un « + » ouvre un menu
// recherchable où l'on coche/décoche les options — et où l'on peut créer une
// valeur absente de la liste (`allowCreate`).
//
// Le menu est rendu en portail : ce champ vit souvent dans un panneau à
// `overflow-auto` (side-peek), qui rognerait un menu positionné en absolu.
//
// Props :
//  - value      : tableau, ou chaîne JSON (`["a","b"]`), ou texte à virgules.
//  - options    : string[] — choix proposés (ordre conservé).
//  - onChange   : (nextArray) => void, appelé à chaque ajout/retrait (autosave).
//  - saving     : désactive les interactions pendant l'enregistrement.
//  - allowCreate: autorise la création d'une valeur libre depuis la recherche.
export function MultiSelectField({
  value,
  options = [],
  onChange,
  saving = false,
  allowCreate = true,
  testId,
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0, openUp: false })
  const btnRef = useRef(null)
  const inputRef = useRef(null)

  const selected = useMemo(() => parseMultiSelectItems(value), [value])

  // Les valeurs déjà posées sur le record mais absentes de la liste (ex. mot-clé
  // créé ailleurs) restent proposables : on les fusionne aux options.
  const allOptions = useMemo(() => {
    const seen = new Set()
    const out = []
    for (const o of [...selected, ...options]) {
      const label = String(o ?? '').trim()
      if (!label || seen.has(label)) continue
      seen.add(label)
      out.push(label)
    }
    return out
  }, [options, selected])

  const query = search.trim()
  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    return q ? allOptions.filter(o => o.toLowerCase().includes(q)) : allOptions
  }, [allOptions, query])

  const canCreate = allowCreate && !!query && !allOptions.some(o => o.toLowerCase() === query.toLowerCase())

  const computePos = useCallback(() => {
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return
    const spaceBelow = window.innerHeight - rect.bottom
    const openUp = spaceBelow < 280 && rect.top > spaceBelow
    setPos({
      top: openUp ? rect.top - 4 : rect.bottom + 4,
      left: rect.left,
      width: Math.max(rect.width, 240),
      openUp,
    })
  }, [])

  useEffect(() => {
    if (!open) return
    computePos()
    setActiveIdx(0)
    setTimeout(() => inputRef.current?.focus(), 0)
    function onDown(e) {
      if (!btnRef.current?.contains(e.target) && !document.getElementById(`${testId || 'multiselect'}-portal`)?.contains(e.target)) {
        setOpen(false)
        setSearch('')
      }
    }
    function onReflow() { computePos() }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onReflow, true)
    window.addEventListener('resize', onReflow)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onReflow, true)
      window.removeEventListener('resize', onReflow)
    }
  }, [open, computePos, testId])

  function toggle(label) {
    const next = selected.includes(label)
      ? selected.filter(v => v !== label)
      : [...selected, label]
    onChange(next)
  }

  function create() {
    if (!canCreate) return
    onChange([...selected, query])
    setSearch('')
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setSearch('') }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[activeIdx]) toggle(filtered[activeIdx])
      else create()
    }
  }

  return (
    <div className="relative w-full" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-1.5 min-h-[38px] rounded-lg border border-slate-200 bg-white px-2 py-1.5">
        {selected.map(v => (
          <Badge key={v} className="gap-1">
            <span data-testid={testId ? `${testId}-chip` : undefined} className="truncate max-w-[220px]">{v}</span>
            <button
              type="button"
              disabled={saving}
              onClick={() => toggle(v)}
              title={`Retirer « ${v} »`}
              data-testid={`${testId}-remove-${v}`}
              className="rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-50"
            >
              <X size={11} />
            </button>
          </Badge>
        ))}
        <button
          ref={btnRef}
          type="button"
          disabled={saving}
          onClick={() => setOpen(o => !o)}
          data-testid={testId ? `${testId}-add` : undefined}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
        >
          <Plus size={12} />
        </button>
      </div>

      {open && createPortal(
        <div
          id={`${testId || 'multiselect'}-portal`}
          data-testid={testId ? `${testId}-menu` : undefined}
          style={{
            position: 'fixed',
            top: pos.openUp ? undefined : pos.top,
            bottom: pos.openUp ? window.innerHeight - pos.top : undefined,
            left: pos.left,
            width: pos.width,
            zIndex: 9999,
          }}
          className="bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden flex flex-col"
        >
          <div className="p-2 border-b border-slate-100">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                ref={inputRef}
                value={search}
                onChange={e => { setSearch(e.target.value); setActiveIdx(0) }}
                onKeyDown={onKeyDown}
                data-testid={testId ? `${testId}-search` : undefined}
                className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400"
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {filtered.length === 0 && !canCreate && (
              <p className="text-xs text-slate-400 text-center py-3">Aucun résultat</p>
            )}
            {filtered.map((o, idx) => {
              const isSel = selected.includes(o)
              return (
                <button
                  key={o}
                  type="button"
                  onClick={() => toggle(o)}
                  onMouseEnter={() => setActiveIdx(idx)}
                  title={o}
                  data-testid={`${testId}-opt-${o}`}
                  className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors ${idx === activeIdx ? 'bg-slate-50' : ''} ${isSel ? 'text-brand-600 font-medium' : 'text-slate-700'}`}
                >
                  <Check size={13} className={`flex-shrink-0 ${isSel ? 'text-brand-600' : 'text-transparent'}`} />
                  <span className="flex-1 min-w-0 truncate">{o}</span>
                </button>
              )
            })}
            {canCreate && (
              <button
                type="button"
                onClick={create}
                data-testid={testId ? `${testId}-create` : undefined}
                className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 text-brand-600 hover:bg-brand-50 border-t border-slate-100"
              >
                <Plus size={13} className="flex-shrink-0" />
                <span className="flex-1 min-w-0 truncate">Créer « {query} »</span>
              </button>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

export default MultiSelectField
