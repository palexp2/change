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
  const [loading, setLoading] = useState(false)
  const skipFetch = useRef(false)
  const wrapRef = useRef(null)

  // Sync quand le parent change la valeur (ex: reset formulaire)
  useEffect(() => { setQuery(value) }, [value])

  // Fermer si clic extérieur
  useEffect(() => {
    function handle(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  useEffect(() => {
    if (skipFetch.current) { skipFetch.current = false; return }
    if (!query || query.length < 1) { setResults([]); setOpen(false); return }

    const tid = setTimeout(async () => {
      setLoading(true)
      try {
        const { data } = await api.companies.list({ search: query, type: 'Fournisseur', limit: 10 })
        setResults(data || [])
        setOpen(true)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 200)
    return () => clearTimeout(tid)
  }, [query])

  function select(company) {
    skipFetch.current = true
    setQuery(company.name)
    setOpen(false)
    onChange({ vendor: company.name, vendor_id: company.id })
  }

  async function createAndSelect() {
    if (!query.trim()) return
    try {
      const company = await api.companies.create({ name: query.trim(), type: 'Fournisseur' })
      skipFetch.current = true
      setOpen(false)
      onChange({ vendor: company.name, vendor_id: company.id })
    } catch (e) {
      // En cas d'erreur, on garde juste le texte libre
      onChange({ vendor: query.trim(), vendor_id: null })
      setOpen(false)
    }
  }

  function handleInputChange(e) {
    setQuery(e.target.value)
    onChange({ vendor: e.target.value, vendor_id: null })
  }

  const exactMatch = results.some(r => r.name.toLowerCase() === query.toLowerCase())

  return (
    <div ref={wrapRef} className="relative">
      <input
        type="text"
        value={query}
        onChange={handleInputChange}
        onFocus={() => query && results.length > 0 && setOpen(true)}
        className="input"
        placeholder="Nom du fournisseur…"
        required={required}
        autoComplete="off"
      />
      {vendorId && (
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-indigo-500 pointer-events-none">lié</span>
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
              {c.quickbooks_vendor_id && (
                <span className="text-xs text-slate-400 ml-2">QB</span>
              )}
            </li>
          ))}
          {!exactMatch && query.trim() && (
            <li
              onMouseDown={createAndSelect}
              className="px-3 py-2 hover:bg-indigo-50 cursor-pointer text-indigo-600 border-t border-slate-100"
            >
              + Créer « {query.trim()} » comme fournisseur
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
