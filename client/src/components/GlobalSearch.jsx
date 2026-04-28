import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Building2, Users, TrendingUp, ShoppingCart, Package, LifeBuoy, MessageSquare, X, Barcode, FileText, Receipt } from 'lucide-react'
import api from '../lib/api.js'

const TYPE_ICON = {
  company: Building2,
  contact: Users,
  project: TrendingUp,
  order: ShoppingCart,
  product: Package,
  serial: Barcode,
  ticket: LifeBuoy,
  interaction: MessageSquare,
  bill: FileText,
  expense: Receipt,
}

const TYPE_LABEL = {
  company: 'Entreprise',
  contact: 'Contact',
  project: 'Projet',
  order: 'Commande',
  product: 'Produit',
  serial: 'N° de série',
  ticket: 'Ticket',
  interaction: 'Interaction',
  bill: 'Facture fourn.',
  expense: 'Dépense',
}

export function GlobalSearch({ open, onClose }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(0)
  const inputRef = useRef(null)
  const navigate = useNavigate()
  const timerRef = useRef(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setResults([])
      setSelected(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const search = useCallback(async (q) => {
    if (q.length < 2) { setResults([]); return }
    setLoading(true)
    try {
      const { results: res } = await api.search.query(q)
      setResults(res || [])
      setSelected(0)
    } finally {
      setLoading(false)
    }
  }, [])

  function handleChange(e) {
    const q = e.target.value
    setQuery(q)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => search(q), 220)
  }

  function go(result) {
    navigate(result.url)
    onClose()
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, results.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)) }
    if (e.key === 'Enter' && results[selected]) go(results[selected])
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-xl bg-white rounded-xl shadow-2xl overflow-hidden">
        {/* Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200">
          <Search size={18} className="text-slate-400 flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Rechercher entreprises, contacts, projets…"
            className="flex-1 text-sm outline-none text-slate-900 placeholder-slate-400"
          />
          {loading && (
            <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
          )}
          {!loading && query && (
            <button onClick={() => { setQuery(''); setResults([]) }} className="text-slate-400 hover:text-slate-600">
              <X size={14} />
            </button>
          )}
          <kbd className="hidden sm:inline text-xs text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">Esc</kbd>
        </div>

        {/* Results */}
        {results.length > 0 && (
          <ul className="max-h-80 overflow-y-auto py-1">
            {results.map((r, i) => {
              const Icon = TYPE_ICON[r.type] || Search
              return (
                <li key={`${r.type}-${r.id}`}>
                  <button
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${i === selected ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}
                    onClick={() => go(r)}
                    onMouseEnter={() => setSelected(i)}
                  >
                    <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
                      <Icon size={14} className="text-slate-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{r.label}</div>
                      {r.sub && <div className="text-xs text-slate-400 truncate">{r.sub}</div>}
                    </div>
                    <span className="text-xs text-slate-400 flex-shrink-0">{TYPE_LABEL[r.type]}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {query.length >= 2 && !loading && results.length === 0 && (
          <div className="py-10 text-center text-slate-400 text-sm">Aucun résultat pour « {query} »</div>
        )}

        {query.length === 0 && (
          <div className="py-6 text-center text-slate-400 text-xs">Tapez au moins 2 caractères pour rechercher</div>
        )}
      </div>
    </div>
  )
}
