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
//  - renderValue(opt)      : JSX custom sur le bouton fermé (sinon getOptionLabel).
//  - filterOption(opt, q)  : filtre custom (q déjà en minuscules).
//  - onSearchTerm(q)       : VARIANTE « liste servie » — le terme saisi est remonté
//                            (débounce 200 ms, plus à l'ouverture) et c'est à
//                            l'appelant de renvoyer les `options` correspondantes.
//                            Le filtrage local est alors désactivé : re-filtrer
//                            retirerait des résultats que la source a jugés bons
//                            (ex. une fiche trouvée par le nom de son entreprise).
//                            Pour les listes qu'on ne peut pas charger en entier.
//  - emptyOption           : libellé d'une entrée « vide » (value '') ajoutée en tête.
//  - footer                : JSX épinglé sous la liste, dans le menu ouvert (le
//                            clic n'y sélectionne rien et ne referme pas — ex. le
//                            « Rafraîchir » des champs Airtable).
//  - className             : classes du bouton déclencheur. Défaut: ancien look QB.
//  - size                  : 'xs' | 'sm' — taille typographique du menu. Défaut 'xs'.
//  VARIANTE « tableau » (menu d'achat LIA de la fiche reçu) — tout est optionnel :
//  - searchAside           : JSX à droite du champ de recherche (ex. un compte).
//  - listHeader            : JSX épinglé au-dessus de la liste (en-têtes de colonnes).
//  - getOptionGroup(opt)   : libellé de groupe ; un séparateur s'affiche à chaque changement.
//  - optionClassName(opt)  : classes ajoutées à la rangée (ex. fond de la suggestion).
//  - hideOption(opt)       : option absente de la liste mais affichable comme valeur.
//  - hideCheck             : pas de coche en tête de rangée.
//  - minMenuWidth          : largeur minimale du menu ouvert. Défaut 240.
//  - quietSelection        : le choix actuel n'a ni fond ni couleur, seulement une
//                            coche grise (quand une autre rangée porte déjà le vert).
//  - menuClassName         : classes ajoutées au menu ouvert.
//  - disabled              : bool.
export function SearchableSelect({
  value,
  options = [],
  onChange,
  placeholder = '—',
  getOptionValue = o => o.value,
  getOptionLabel = o => o.label,
  getOptionKey,
  renderOption,
  renderValue,
  filterOption,
  onSearchTerm,
  emptyOption,
  footer,
  className = 'input-field text-xs w-full',
  size = 'xs',
  disabled = false,
  testId,
  searchAside,
  listHeader,
  getOptionGroup,
  optionClassName,
  hideOption,
  hideCheck = false,
  minMenuWidth = 240,
  quietSelection = false,
  menuClassName = '',
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

  // Liste servie par l'appelant : la recherche part à la source, pas en local.
  const remoteSearch = typeof onSearchTerm === 'function'
  // Le callback est tenu dans une ref : passé en fonction inline (le cas normal),
  // son identité change à chaque rendu — dans les deps de l'effet, chaque
  // réponse relancerait une requête, en boucle.
  const searchCb = useRef(onSearchTerm)
  useEffect(() => { searchCb.current = onSearchTerm })
  useEffect(() => {
    if (!remoteSearch || !open) return
    const t = setTimeout(() => searchCb.current?.(search.trim()), 200)
    return () => clearTimeout(t)
  }, [search, open, remoteSearch])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const listed = hideOption ? options.filter(o => !hideOption(o)) : options
    if (!q || remoteSearch) return listed
    const match = filterOption || ((o, query) => String(getOptionLabel(o) ?? '').toLowerCase().includes(query))
    return listed.filter(o => match(o, q))
  }, [options, search, filterOption, getOptionLabel, remoteSearch, hideOption])

  const computePos = useCallback(() => {
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return
    const spaceBelow = window.innerHeight - rect.bottom
    const openUp = spaceBelow < 260 && rect.top > spaceBelow
    setPos({
      top: openUp ? rect.top - 4 : rect.bottom + 4,
      left: rect.left,
      width: Math.max(rect.width, minMenuWidth),
      openUp,
    })
  }, [minMenuWidth])

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
    <div className="relative min-w-0 max-w-full w-full">
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        data-testid={testId}
        onClick={() => !disabled && setOpen(o => !o)}
        onKeyDown={onKeyDown}
        title={selected ? titleOf(selected) : undefined}
        className={`${className} min-w-0 max-w-full flex items-center justify-between gap-1 text-left ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        {/* `renderValue` produit du JSX (icône + libellé) : il porte lui-même sa
            troncature, un `truncate` inline autour d'une rangée flex ne coupe
            rien. Le chemin texte, lui, garde exactement l'ancien rendu. */}
        {selected && renderValue ? (
          <span className="min-w-0 flex-1 flex items-center text-slate-700">{renderValue(selected)}</span>
        ) : (
          <span className={`min-w-0 truncate ${selected ? 'text-slate-700' : 'text-slate-400'}`}>
            {selected ? getOptionLabel(selected) : placeholder}
          </span>
        )}
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
          className={`bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden flex flex-col ${menuClassName}`}
        >
          <div className={`p-2 border-b border-slate-100 ${searchAside ? 'flex items-center gap-2' : ''}`}>
            <div className={`relative ${searchAside ? 'flex-1 min-w-0' : ''}`}>
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                ref={inputRef}
                value={search}
                onChange={e => { setSearch(e.target.value); setActiveIdx(0) }}
                onKeyDown={onKeyDown}
                className={`w-full pl-7 pr-2 py-1.5 ${txt} border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400`}
              />
            </div>
            {searchAside && <div className={`shrink-0 ${txt} text-slate-400`}>{searchAside}</div>}
          </div>
          {listHeader && <div className="flex-shrink-0 border-b border-slate-100">{listHeader}</div>}
          <div className="max-h-64 overflow-y-auto">
            {showEmpty && (
              <button
                type="button"
                onClick={() => commit('')}
                className={`w-full text-left px-3 py-2 ${txt} hover:bg-slate-50 flex items-center gap-2 ${String(value) === '' && !quietSelection ? 'text-brand-600 font-medium bg-brand-50' : 'text-slate-500'}`}
              >
                <Check size={13} className={`flex-shrink-0 ${String(value) !== '' ? 'text-transparent' : quietSelection ? 'text-slate-400' : 'text-brand-600'}`} />
                <span className="truncate">{emptyOption}</span>
              </button>
            )}
            {filtered.length === 0 ? (
              <p className={`${txt} text-slate-400 text-center py-3`}>Aucun résultat</p>
            ) : filtered.map((o, idx) => {
              const isSel = String(getOptionValue(o)) === String(value)
              const group = getOptionGroup ? getOptionGroup(o) : null
              const newGroup = group && (idx === 0 || group !== getOptionGroup(filtered[idx - 1]))
              const extra = optionClassName?.(o) || ''
              return (
                <div key={keyOf(o) ?? idx}>
                {newGroup && (
                  <div className="px-3 pt-2 pb-1 text-[10px] font-medium text-slate-400 border-t border-slate-100">{group}</div>
                )}
                <button
                  type="button"
                  onClick={() => commit(getOptionValue(o))}
                  onMouseEnter={() => setActiveIdx(idx)}
                  title={titleOf(o)}
                  className={`w-full text-left px-3 py-2 ${txt} flex items-center gap-2 transition-colors ${extra} ${idx === activeIdx && !extra ? 'bg-slate-50' : ''} ${isSel && !quietSelection ? 'text-brand-600 font-medium' : 'text-slate-700'}`}
                >
                  {!hideCheck && <Check size={13} className={`flex-shrink-0 ${isSel ? 'text-brand-600' : 'text-transparent'}`} />}
                  <span className="flex-1 min-w-0 truncate">
                    {renderOption ? renderOption(o) : getOptionLabel(o)}
                  </span>
                </button>
                </div>
              )
            })}
          </div>
          {footer && (
            <div className="border-t border-slate-100 p-1 flex-shrink-0">{footer}</div>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}

export default SearchableSelect
