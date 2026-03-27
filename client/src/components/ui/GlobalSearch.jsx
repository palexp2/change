import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search } from 'lucide-react'
import { baseAPI } from '../../hooks/useBaseAPI.js'
import { DynamicIcon } from './DynamicIcon.jsx'

export function GlobalSearch({ onClose }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef(null)
  const debounceRef = useRef(null)
  const navigate = useNavigate()

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (query.length < 2) { setResults([]); return }
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await baseAPI.search(query)
        setResults(res.results || [])
        setSelectedIndex(0)
      } catch { setResults([]) }
      setLoading(false)
    }, 300)
    return () => clearTimeout(debounceRef.current)
  }, [query])

  function handleKeyDown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, results.length - 1)) }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)) }
    if (e.key === 'Enter' && results[selectedIndex]) handleSelect(results[selectedIndex])
  }

  function handleSelect(result) {
    navigate(`/tables/${result.table_slug || result.table_id}/${result.record_id}`)
    onClose()
  }

  const grouped = results.reduce((acc, r) => {
    if (!acc[r.table_id]) acc[r.table_id] = { name: r.table_name, icon: r.table_icon, items: [] }
    acc[r.table_id].items.push(r)
    return acc
  }, {})

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-[200]" onClick={onClose} />
      <div className="fixed top-[20%] left-1/2 -translate-x-1/2 w-full max-w-lg z-[201] px-4">
        <div className="bg-white rounded-xl shadow-2xl overflow-hidden border">
          <div className="flex items-center gap-3 px-4 py-3 border-b">
            <Search size={18} className="text-gray-400 shrink-0" />
            <input ref={inputRef} type="text" value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Rechercher un enregistrement..."
              className="flex-1 text-sm outline-none placeholder-gray-400" />
            <kbd className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">ESC</kbd>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {query.length < 2 ? (
              <p className="px-4 py-8 text-center text-sm text-gray-400">Tapez au moins 2 caractères</p>
            ) : loading ? (
              <p className="px-4 py-8 text-center text-sm text-gray-400">Recherche...</p>
            ) : results.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-gray-400">Aucun enregistrement trouvé</p>
            ) : (
              Object.values(grouped).map(group => (
                <div key={group.name}>
                  <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400 bg-gray-50 flex items-center gap-1.5">
                    <DynamicIcon name={group.icon} size={12} />
                    {group.name}
                  </div>
                  {group.items.map(result => {
                    const flatIdx = results.indexOf(result)
                    return (
                      <button key={result.record_id} onClick={() => handleSelect(result)}
                        className={`w-full text-left px-4 py-2.5 text-sm ${
                          flatIdx === selectedIndex ? 'bg-indigo-50 text-indigo-700' : 'hover:bg-gray-50 text-gray-700'
                        }`}>
                        <span className="font-medium">{result.primary_value ?? '(sans titre)'}</span>
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>

          <div className="px-4 py-2 border-t bg-gray-50 flex items-center gap-4 text-[10px] text-gray-400">
            <span><kbd className="bg-gray-200 px-1 rounded">↑↓</kbd> naviguer</span>
            <span><kbd className="bg-gray-200 px-1 rounded">↵</kbd> ouvrir</span>
            <span><kbd className="bg-gray-200 px-1 rounded">esc</kbd> fermer</span>
          </div>
        </div>
      </div>
    </>
  )
}
