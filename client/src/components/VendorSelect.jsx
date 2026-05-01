import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api.js'

/**
 * Autocomplete fournisseur (companies avec type=Fournisseur).
 *
 * Props:
 *   value        – texte affiché (nom du fournisseur)
 *   vendorId     – companies.id sélectionné (null si libre)
 *   onChange     – ({ vendor, vendor_id }) => void
 *   required     – bool
 */
export function VendorSelect({ value = '', vendorId = null, onChange, required = false }) {
  const [query, setQuery] = useState(value)
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [_loading, setLoading] = useState(false)
  const debounceTid = useRef(null)
  const wrapRef = useRef(null)

  // Sync quand le parent change la valeur (chargement initial, reset, sélection confirmée).
  // On ne déclenche PAS de recherche ici, sinon le menu s'ouvrirait tout seul à l'ouverture
  // de la fiche.
  useEffect(() => { setQuery(value) }, [value])

  // Fermer si clic extérieur
  useEffect(() => {
    function handle(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  useEffect(() => () => clearTimeout(debounceTid.current), [])

  function runSearch(q) {
    clearTimeout(debounceTid.current)
    if (!q || q.length < 1) { setResults([]); setOpen(false); return }
    debounceTid.current = setTimeout(async () => {
      setLoading(true)
      try {
        const { data } = await api.companies.list({ search: q, limit: 10 })
        setResults(data || [])
        setOpen(true)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 200)
  }

  function select(company) {
    clearTimeout(debounceTid.current)
    setOpen(false)
    setQuery(company.name)
    onChange({ vendor: company.name, vendor_id: company.id })
  }

  async function createAndSelect() {
    if (!query.trim()) return
    clearTimeout(debounceTid.current)
    setOpen(false)
    try {
      const company = await api.companies.create({ name: query.trim(), type: 'Fournisseur' })
      onChange({ vendor: company.name, vendor_id: company.id })
    } catch {
      onChange({ vendor: query.trim(), vendor_id: null })
    }
  }

  function handleInputChange(e) {
    const v = e.target.value
    setQuery(v)
    onChange({ vendor: v, vendor_id: null })
    runSearch(v)
  }

  const exactMatch = results.some(r => r.name.toLowerCase() === query.toLowerCase())

  return (
    <div ref={wrapRef} className="relative">
      <input
        type="text"
        value={query}
        onChange={handleInputChange}
        onFocus={() => runSearch(query)}
        className="input"
        placeholder="Nom du fournisseur…"
        required={required}
        autoComplete="off"
      />
      {vendorId && (
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-brand-500 pointer-events-none">lié</span>
      )}
      {open && (results.length > 0 || (!exactMatch && query.length > 0)) && (
        <ul className="absolute z-50 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-52 overflow-y-auto text-sm">
          {results.map(c => (
            <li
              key={c.id}
              onMouseDown={() => select(c)}
              className="flex items-center justify-between px-3 py-2 hover:bg-slate-50 cursor-pointer"
            >
              <span>{c.name}</span>
              <span className="flex items-center gap-2 ml-2">
                {c.type && <span className="text-xs text-slate-400">{c.type}</span>}
                {c.quickbooks_vendor_id && (
                  <span className="text-xs text-slate-400">QB</span>
                )}
              </span>
            </li>
          ))}
          {!exactMatch && query.trim() && (
            <li
              onMouseDown={createAndSelect}
              className="px-3 py-2 hover:bg-brand-50 cursor-pointer text-brand-600 border-t border-slate-100"
            >
              + Créer « {query.trim()} » comme fournisseur
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
