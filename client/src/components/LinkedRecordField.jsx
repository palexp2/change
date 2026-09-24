import { useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { Plus, X, Search, ChevronDown } from 'lucide-react'
import api from '../lib/api.js'

const EMPTY_OPTIONS = []

export default function LinkedRecordField({
  value,
  options = EMPTY_OPTIONS,
  labelFn,
  getHref,
  onOpen,
  saving = false,
  disabled = false,
  onChange,
  allowClear = true,
  name,
  // Candidats cherchés côté SERVEUR plutôt que dans `options` : table ERP cible
  // (`adresses`, `products`…). Pour les champs dont la page n'a pas — et ne peut
  // pas avoir — la liste complète en mémoire (un champ lien de fiche vise
  // n'importe quelle table du miroir). `options` ne sert alors qu'à donner son
  // libellé à la valeur déjà posée.
  searchTarget = null,
  // Filtre du champ lien : seul ce sous-ensemble de la table cible est proposé
  // (conditions posées dans la fiche du champ — cf. services/linkFilter.js).
  searchFilter = null,
  // Identifiant à STOCKER quand on choisit un candidat : 'airtable' (recXXX) ou
  // 'erp' (id Boréal, défaut). Une colonne ne doit pas mélanger les deux.
  identity = null,
  title,
  // Option : créer l'enregistrement cible au lieu d'en choisir un existant. La
  // liste recherchable gagne alors une dernière entrée (`createLabel`) qui
  // appelle `onCreate(recherche saisie)` — à l'appelant d'ouvrir son formulaire
  // de création puis de poser la valeur. Sans `onCreate`, rien ne change.
  onCreate = null,
  createLabel = 'Créer',
  // Option : libellé long affiché en entier (retour à la ligne) au lieu d'être tronqué.
  wrap = false,
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

  // Candidats venus du serveur (searchTarget) — débounce 200 ms : une frappe
  // n'est pas un appel.
  const [remote, setRemote] = useState(EMPTY_OPTIONS)
  // Le filtre est un tableau : sérialisé pour les deps, sinon un littéral
  // reconstruit à chaque rendu relancerait la recherche en boucle.
  const filterKey = searchFilter?.length ? JSON.stringify(searchFilter) : ''
  useEffect(() => {
    if (!open || !searchTarget) return
    let alive = true
    const timer = setTimeout(() => {
      api.recordLinks.search(searchTarget, search.trim(), 40, filterKey ? JSON.parse(filterKey) : null)
        .then(r => {
          if (!alive) return
          setRemote((r?.data || []).map(rec => ({
            id: String((identity === 'airtable' && rec.airtable_id) || rec.id),
            name: rec.label || rec.id,
            sub: rec.sub || null,
          })))
        })
        .catch(() => { if (alive) setRemote(EMPTY_OPTIONS) })
    }, 200)
    return () => { alive = false; clearTimeout(timer) }
  }, [open, search, searchTarget, identity, filterKey])

  const filtered = useMemo(() => {
    if (searchTarget) return remote
    const q = search.trim().toLowerCase()
    if (!q) return options.slice(0, 60)
    return options.filter(o => getLabel(o).toLowerCase().includes(q)).slice(0, 60)
  }, [options, search, getLabel, searchTarget, remote])

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

  // Liste recherchable — la même qu'un champ vide ouvre pour lier, et qu'un
  // champ rempli ouvre pour relier ailleurs. Rendue en portail : le champ vit
  // souvent dans une carte à `overflow` contraint (panneau latéral, cellule).
  const picker = open && createPortal(
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
            className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400"
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
            className={`flex w-full items-center gap-2 text-left px-3 py-2 text-sm hover:bg-slate-50 ${String(o.id) === String(value) ? 'text-brand-600 font-medium' : 'text-slate-700'}`}
          >
            <span className="flex-1 truncate">{getLabel(o)}</span>
            {o.sub && <span className="text-xs text-slate-400 truncate max-w-[40%]">{o.sub}</span>}
          </button>
        ))}
        {!search && !searchTarget && options.length > 60 && (
          <div className="px-3 py-2 text-xs text-slate-400 border-t border-slate-100">
            {options.length - 60} autres — affinez la recherche
          </div>
        )}
      </div>
      {onCreate && (
        <button
          type="button"
          onClick={() => { setOpen(false); onCreate(search.trim()) }}
          className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-brand-600 border-t border-slate-100 hover:bg-brand-50"
          data-testid="linked-record-create"
        >
          <Plus size={12} /> {createLabel}
        </button>
      )}
    </div>,
    document.body
  )

  if (selected) {
    const href = getHref ? getHref(selected) : null
    const label = getLabel(selected)
    const bodyCls = `text-sm text-slate-700 ${wrap ? 'break-words min-w-0' : 'truncate'}`
    return (
      <div className="flex items-center gap-1.5 min-w-0" data-testid={fieldTestId} data-state="selected" title={title}>
        <span ref={btnRef} className="inline-flex items-center gap-0.5 bg-slate-100 hover:bg-slate-200/70 rounded-md max-w-full transition-colors">
          {onOpen ? (
            // Pas de fiche dédiée pour la table cible : le libellé ouvre la
            // modale d'édition du record lié (même affordance qu'un lien).
            <button
              type="button"
              onClick={() => onOpen(selected)}
              className={`${bodyCls} pl-2.5 pr-1 py-1 text-left hover:text-brand-700 hover:underline`}
              data-testid="linked-record-open"
              title="Modifier"
            >
              {label}
            </button>
          ) : href ? (
            <Link
              to={href}
              className={`${bodyCls} pl-2.5 pr-1 py-1 hover:text-brand-700 hover:underline`}
              data-testid="linked-record-link"
            >
              {label}
            </Link>
          ) : (
            <span className={`${bodyCls} pl-2.5 pr-1 py-1`}>{label}</span>
          )}
          {/* Relier ailleurs sans passer par un vidage préalable : le libellé
              navigue (ou ouvre la modale), donc le changement de cible a besoin
              de sa propre poignée. Sans elle, un champ rempli non vidable
              (allowClear={false}) était définitivement figé. */}
          {!disabled && (
            <button
              type="button"
              onClick={() => !saving && setOpen(o => !o)}
              disabled={saving}
              className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-300/60 disabled:opacity-50"
              aria-label="Changer"
              title="Changer"
              data-testid="linked-record-change"
            >
              <ChevronDown size={12} />
            </button>
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
        {picker}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1.5 min-w-0" data-testid={fieldTestId} data-state="empty" title={title}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => !disabled && !saving && setOpen(o => !o)}
        disabled={disabled || saving}
        className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-slate-100 text-slate-400 hover:bg-slate-200 hover:text-slate-600 disabled:opacity-50 transition-colors"
        data-testid="linked-record-add"
      >
        <Plus size={12} />
      </button>
      {spinner}
      {picker}
    </div>
  )
}
