import { useState, useEffect, useRef } from 'react'
import { Plus, Phone, Mail, MessageSquare, FileText, CalendarDays } from 'lucide-react'
import InteractionTimeline from './InteractionTimeline.jsx'
import InteractionFormModal from './InteractionFormModal.jsx'

const API_BASE = '/erp/api'

const TYPE_CONFIG = {
  call:    { icon: Phone,        label: 'Appels',    singular: 'Appel' },
  email:   { icon: Mail,         label: 'Courriels', singular: 'Courriel' },
  sms:     { icon: MessageSquare,label: 'SMS',       singular: 'SMS' },
  note:    { icon: FileText,     label: 'Notes',     singular: 'Note' },
  meeting: { icon: CalendarDays, label: 'Réunions',  singular: 'Réunion' },
}

export default function InteractionsTab({ recordId, tableId }) {
  const [interactions, setInteractions] = useState([])
  const [typeCounts, setTypeCounts] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [filterType, setFilterType] = useState(null)
  const [page, setPage] = useState(1)
  const [showMenu, setShowMenu] = useState(false)
  const [createType, setCreateType] = useState(null)
  const scrollRef = useRef(null)

  useEffect(() => { loadInteractions(1, true) }, [recordId, filterType])

  async function loadInteractions(p = 1, reset = false) {
    setLoading(true)
    const token = localStorage.getItem('erp_token')
    const qs = new URLSearchParams({ limit: '20', page: String(p) })
    if (filterType) qs.set('type', filterType)
    try {
      const res = await fetch(`${API_BASE}/base/records/${recordId}/interactions?${qs}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      const data = await res.json()
      if (reset) setInteractions(data.data || [])
      else setInteractions(prev => [...prev, ...(data.data || [])])
      setTotal(data.total || 0)
      setTypeCounts(data.type_counts || [])
      setPage(p)
    } catch {}
    setLoading(false)
  }

  function handleScroll() {
    const el = scrollRef.current
    if (!el || loading) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
      if (interactions.length < total) loadInteractions(page + 1)
    }
  }

  async function handleDelete(id) {
    if (!confirm('Supprimer cette interaction ?')) return
    const token = localStorage.getItem('erp_token')
    await fetch(`${API_BASE}/base/interactions/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    })
    loadInteractions(1, true)
  }

  // Listen for WebSocket interaction events
  useEffect(() => {
    function handler(e) {
      const msg = e.detail || {}
      if (msg.type === 'interaction:created') {
        const linked = msg.links?.some(l => l.record_id === recordId)
        if (linked) loadInteractions(1, true)
      }
    }
    window.addEventListener('ws-interaction', handler)
    return () => window.removeEventListener('ws-interaction', handler)
  }, [recordId])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-3 border-b shrink-0">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-gray-500">
            {total} interaction{total > 1 ? 's' : ''}
          </span>
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="flex items-center gap-1 px-2.5 py-1 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            >
              <Plus size={12} /> Logger
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-[55]" onClick={() => setShowMenu(false)} />
                <div className="absolute right-0 mt-1 w-40 bg-white rounded-lg shadow-xl border z-[60] py-1">
                  {Object.entries(TYPE_CONFIG).map(([t, cfg]) => (
                    <button key={t}
                      onClick={() => { setCreateType(t); setShowMenu(false) }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 text-left">
                      <cfg.icon size={14} className="text-gray-500" /> {cfg.singular}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Filter pills */}
        <div className="flex gap-1.5 flex-wrap">
          <button onClick={() => setFilterType(null)}
            className={`px-2 py-0.5 text-xs rounded-full transition-colors ${
              !filterType ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}>
            Tout ({total})
          </button>
          {typeCounts.map(tc => {
            const cfg = TYPE_CONFIG[tc.type]
            if (!cfg) return null
            const Icon = cfg.icon
            return (
              <button key={tc.type}
                onClick={() => setFilterType(filterType === tc.type ? null : tc.type)}
                className={`px-2 py-0.5 text-xs rounded-full flex items-center gap-1 transition-colors ${
                  filterType === tc.type ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                }`}>
                <Icon size={10} /> {tc.count}
              </button>
            )
          })}
        </div>
      </div>

      {/* Timeline */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-5 py-3">
        <InteractionTimeline
          interactions={interactions}
          showLinkedRecords={false}
          onDelete={handleDelete}
        />
        {loading && <div className="text-center py-4 text-xs text-gray-400">Chargement…</div>}
        {!loading && interactions.length === 0 && (
          <div className="text-center py-8">
            <p className="text-sm text-gray-400">Aucune interaction</p>
            <p className="text-xs text-gray-300 mt-1">Utilisez "Logger" pour commencer</p>
          </div>
        )}
      </div>

      {/* Create modal */}
      {createType && (
        <InteractionFormModal
          type={createType}
          recordId={recordId}
          tableId={tableId}
          onClose={() => setCreateType(null)}
          onCreated={() => { setCreateType(null); loadInteractions(1, true) }}
        />
      )}
    </div>
  )
}
