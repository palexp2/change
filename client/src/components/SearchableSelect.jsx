import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Search, Check } from 'lucide-react'

// Id stable du menu en portail. Un seul menu est ouvert à la fois, donc un id
// fixe suffit — et il reste rétro-compatible avec les tests E2E historiques qui
// ciblent `#qb-select-portal`. Les nouveaux tests utilisent plutôt le data-testid
// `${testId}-menu`.
const PORTAL_ID = 'qb-select-portal'

// Select recherchable rendu via portail (évite le clipping par overflow des parents).
// Utilisé pour toute liste pouvant dépasser 10 options — voir règle de design
// « dropdowns avec recherche » (CLAUDE.md).
//
// Rétro-compatible avec l'API initiale `{ value, label }` :
//   <SearchableSelect value options={[{value,label}]} onChange placeholder testId />
//
// Props additionnelles pour les listes d'objets arbitraires :
//  - getOptionValue(opt)   : valeur retournée par onChange. Défaut: opt.value.
//  - getOptionLabel(opt)   : libellé affiché et recherché. Défaut: opt.label.
//  - getOptionKey(opt)     : clé React. Défaut: getOptionValue.
//  - renderOption(opt)     : JSX custom dans la liste (sinon getOptionLabel).
//  - filterOption(opt, q)  : filtre custom (q déjà en minuscules).
//  - emptyOption           : libellé d'une entrée « vide » (value '') ajoutée en tête.
//  - className             : classes du bouton déclencheur. Défaut: ancien look QB.
//  - size                  : 'xs' | 'sm' — taille typographique du menu. Défaut 'xs'.
//  - disabled              : bool.
export function SearchableSelect({
  value,
  options = [],
  onChange,
  placeholder = 'Sélectionner…',
  searchPlaceholder = 'Rechercher…',
  getOptionValue = o => o.value,
  getOptionLabel = o => o.label,
  getOptionKey,
  renderOption,
  filterOption,
  emptyOption,
  className = 'input-field text-xs w-full',
  size = 'xs',
  disabled = false,
  testId,
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0, openUp: false })
  const btnRef = useRef(null)
  const inputRef = useRef(null)
  const keyOf = getOptionKey || getOptionValue
  const txt = size === 'sm' ? 'text-sm' : 'text-xs'

  const selected = useMemo(
    () => options.find(o => String(getOptionValue(o)) === String(value)),
    [options, value, getOptionValue]
  )

  // Tooltip natif avec le libellé complet quand il est tronqué (les libellés
  // peuvent être du JSX via getOptionLabel custom — on ne met un title que sur
  // les chaînes/nombres).
  const titleOf = o => {
    const l = getOptionLabel(o)
    return typeof l === 'string' || typeof l === 'number' ? String(l) : undefined
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return options
    const match = filterOption || ((o, query) => String(getOptionLabel(o) ?? '').toLowerCase().includes(query))
    return options.filter(o => match(o, q))
  }, [options, search, filterOption, getOptionLabel])

  const computePos = useCallback(() => {
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return
    const spaceBelow = window.innerHeight - rect.bottom
    const openUp = spaceBelow < 260 && rect.top > spaceBelow
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
      if (!btnRef.current?.contains(e.target) && !document.getElementById(PORTAL_ID)?.contains(e.target)) {
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
  }, [open, computePos])

  function commit(v) {
    onChange(v)
    setOpen(false)
    setSearch('')
  }

  function onKeyDown(e) {
    if (!open) {
      if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) }
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setSearch('') }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[activeIdx]) commit(getOptionValue(filtered[activeIdx])) }
  }

  const showEmpty = emptyOption !== undefined && !search.trim()

  return (
    <div className="relative w-full">
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        data-testid={testId}
        onClick={() => !disabled && setOpen(o => !o)}
        onKeyDown={onKeyDown}
        title={selected ? titleOf(selected) : undefined}
        className={`${className} flex items-center justify-between gap-1 text-left ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <span className={`truncate ${selected ? 'text-slate-700' : 'text-slate-400'}`}>
          {selected ? getOptionLabel(selected) : placeholder}
        </span>
        <ChevronDown size={12} className="flex-shrink-0 text-slate-400" />
      </button>
      {open && createPortal(
        <div
          id={PORTAL_ID}
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
                className={`w-full pl-7 pr-2 py-1.5 ${txt} border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400`}
                placeholder={searchPlaceholder}
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {showEmpty && (
              <button
                type="button"
                onClick={() => commit('')}
                className={`w-full text-left px-3 py-2 ${txt} hover:bg-slate-50 flex items-center gap-2 ${String(value) === '' ? 'text-brand-600 font-medium bg-brand-50' : 'text-slate-500'}`}
              >
                <Check size={13} className={`flex-shrink-0 ${String(value) === '' ? 'text-brand-600' : 'text-transparent'}`} />
                <span className="truncate">{emptyOption}</span>
              </button>
            )}
            {filtered.length === 0 ? (
              <p className={`${txt} text-slate-400 text-center py-3`}>Aucun résultat</p>
            ) : filtered.map((o, idx) => {
              const isSel = String(getOptionValue(o)) === String(value)
              return (
                <button
                  key={keyOf(o) ?? idx}
                  type="button"
                  onClick={() => commit(getOptionValue(o))}
                  onMouseEnter={() => setActiveIdx(idx)}
                  title={titleOf(o)}
                  className={`w-full text-left px-3 py-2 ${txt} flex items-center gap-2 transition-colors ${idx === activeIdx ? 'bg-slate-50' : ''} ${isSel ? 'text-brand-600 font-medium' : 'text-slate-700'}`}
                >
                  <Check size={13} className={`flex-shrink-0 ${isSel ? 'text-brand-600' : 'text-transparent'}`} />
                  <span className="flex-1 min-w-0 truncate">
                    {renderOption ? renderOption(o) : getOptionLabel(o)}
                  </span>
                </button>
              )
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

export default SearchableSelect
