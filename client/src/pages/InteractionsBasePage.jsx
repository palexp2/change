import { useState, useEffect, useCallback, useRef } from 'react'
import { Plus, Phone, Mail, MessageSquare, FileText, CalendarDays, List, AlignLeft } from 'lucide-react'
import { Layout } from '../components/Layout.jsx'
import InteractionTimeline, { TYPE_ICONS, TYPE_STYLES, formatRelativeTime } from '../components/interactions/InteractionTimeline.jsx'
import InteractionFormModal from '../components/interactions/InteractionFormModal.jsx'

const API_BASE = '/erp/api'

const TYPE_CONFIG = {
  call:    { icon: Phone,        label: 'Appels' },
  email:   { icon: Mail,         label: 'Courriels' },
  sms:     { icon: MessageSquare,label: 'SMS' },
  note:    { icon: FileText,     label: 'Notes' },
  meeting: { icon: CalendarDays, label: 'Réunions' },
}

function groupByDay(interactions) {
  const groups = []
  const map = new Map()
  for (const itr of interactions) {
    const d = new Date(itr.completed_at || itr.created_at)
    const key = d.toISOString().slice(0, 10)
    if (!map.has(key)) {
      const now = new Date()
      const today = now.toISOString().slice(0, 10)
      const yesterday = new Date(now - 86400000).toISOString().slice(0, 10)
      const label = key === today ? "Aujourd'hui" :
        key === yesterday ? 'Hier' :
        d.toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      map.set(key, { label, interactions: [] })
      groups.push(map.get(key))
    }
    map.get(key).interactions.push(itr)
  }
  return groups
}

function StatCard({ label, value, icon: Icon, color }) {
  return (
    <div className="bg-white rounded-xl border p-4 flex items-center gap-4">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${color}`}>
        <Icon size={20} className="text-white" />
      </div>
      <div>
        <p className="text-2xl font-bold text-gray-900">{value ?? '—'}</p>
        <p className="text-xs text-gray-500">{label}</p>
      </div>
    </div>
  )
}

export default function InteractionsBasePage() {
  const [interactions, setInteractions] = useState([])
  const [stats, setStats] = useState(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [filterType, setFilterType] = useState(null)
  const [viewMode, setViewMode] = useState('timeline') // 'timeline' | 'table'
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [showMenu, setShowMenu] = useState(false)
  const [createType, setCreateType] = useState(null)
  const scrollRef = useRef(null)

  useEffect(() => { loadStats() }, [])
  useEffect(() => { loadInteractions(1, true) }, [filterType, search])

  async function loadStats() {
    const token = localStorage.getItem('erp_token')
    try {
      const res = await fetch(`${API_BASE}/base/interactions/stats?period=month`, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      setStats(await res.json())
    } catch {}
  }

  async function loadInteractions(p = 1, reset = false) {
    setLoading(true)
    const token = localStorage.getItem('erp_token')
    const qs = new URLSearchParams({ limit: '20', page: String(p) })
    if (filterType) qs.set('type', filterType)
    if (search) qs.set('search', search)
    try {
      const res = await fetch(`${API_BASE}/base/interactions?${qs}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      const data = await res.json()
      if (reset) setInteractions(data.data || [])
      else setInteractions(prev => [...prev, ...(data.data || [])])
      setTotal(data.total || 0)
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
    if (!confirm('Supprimer ?')) return
    const token = localStorage.getItem('erp_token')
    await fetch(`${API_BASE}/base/interactions/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    })
    loadInteractions(1, true)
  }

  const groups = groupByDay(interactions)

  return (
    <Layout>
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center gap-4 px-6 py-4 border-b bg-white shrink-0">
          <h1 className="text-lg font-semibold text-gray-900">Interactions</h1>
          <div className="relative ml-auto">
            <button onClick={() => setShowMenu(!showMenu)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
              <Plus size={14} /> Logger
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                <div className="absolute right-0 mt-1 w-40 bg-white rounded-lg shadow-xl border z-50 py-1">
                  {Object.entries(TYPE_CONFIG).map(([t, cfg]) => {
                    const Icon = cfg.icon
                    return (
                      <button key={t} onClick={() => { setCreateType(t); setShowMenu(false) }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 text-left">
                        <Icon size={14} className="text-gray-500" /> {cfg.label.replace(/s$/, '')}
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 px-6 py-4 bg-gray-50 border-b shrink-0">
            <StatCard label="Total ce mois" value={Object.values(stats.by_type || {}).reduce((a, b) => a + b, 0)} icon={AlignLeft} color="bg-gray-600" />
            <StatCard label="Appels" value={stats.by_type?.call || 0} icon={Phone} color="bg-blue-500" />
            <StatCard label="Courriels" value={stats.by_type?.email || 0} icon={Mail} color="bg-indigo-500" />
            <StatCard label="SMS" value={stats.by_type?.sms || 0} icon={MessageSquare} color="bg-purple-500" />
          </div>
        )}

        {/* Toolbar */}
        <div className="flex items-center gap-3 px-6 py-3 border-b bg-white shrink-0 flex-wrap">
          {/* Type pills */}
          <button onClick={() => setFilterType(null)}
            className={`px-2.5 py-1 text-xs rounded-full ${!filterType ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
            Tout ({total})
          </button>
          {Object.entries(TYPE_CONFIG).map(([t, cfg]) => {
            const Icon = cfg.icon
            return (
              <button key={t} onClick={() => setFilterType(filterType === t ? null : t)}
                className={`px-2.5 py-1 text-xs rounded-full flex items-center gap-1 ${filterType === t ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                <Icon size={10} /> {cfg.label}
              </button>
            )
          })}

          <div className="ml-auto flex items-center gap-2">
            <input
              type="text"
              placeholder="Rechercher…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="border rounded-lg px-3 py-1.5 text-sm w-48"
            />
            <button onClick={() => setViewMode('timeline')}
              className={`p-1.5 rounded ${viewMode === 'timeline' ? 'bg-gray-200' : 'hover:bg-gray-100'}`}
              title="Vue timeline">
              <AlignLeft size={16} className="text-gray-600" />
            </button>
            <button onClick={() => setViewMode('table')}
              className={`p-1.5 rounded ${viewMode === 'table' ? 'bg-gray-200' : 'hover:bg-gray-100'}`}
              title="Vue tableau">
              <List size={16} className="text-gray-600" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
          {loading && interactions.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-sm text-gray-400">Chargement…</div>
          ) : viewMode === 'timeline' ? (
            <div className="max-w-2xl mx-auto px-6 py-4">
              {groups.map(group => (
                <div key={group.label} className="mb-6">
                  <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                    {group.label}
                  </div>
                  <InteractionTimeline
                    interactions={group.interactions}
                    showLinkedRecords={true}
                    onDelete={handleDelete}
                  />
                </div>
              ))}
              {!loading && interactions.length === 0 && (
                <p className="text-center text-sm text-gray-400 py-8">Aucune interaction</p>
              )}
              {loading && <div className="text-center py-4 text-xs text-gray-400">Chargement…</div>}
            </div>
          ) : (
            <div className="px-6 py-4">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b">
                    <th className="py-2 font-medium">Type</th>
                    <th className="py-2 font-medium">Sujet / Détails</th>
                    <th className="py-2 font-medium">Direction</th>
                    <th className="py-2 font-medium">Source</th>
                    <th className="py-2 font-medium">Date</th>
                    <th className="py-2 font-medium">Statut</th>
                  </tr>
                </thead>
                <tbody>
                  {interactions.map(itr => {
                    const Icon = TYPE_ICONS[itr.type] || MessageSquare
                    const styles = TYPE_STYLES[itr.type] || {}
                    const iconColor = styles[itr.direction] || styles.default || 'text-gray-400'
                    return (
                      <tr key={itr.id} className="border-b hover:bg-gray-50 cursor-default">
                        <td className="py-2 pr-3">
                          <Icon size={14} className={iconColor} />
                        </td>
                        <td className="py-2 pr-3 max-w-xs truncate text-gray-700">
                          {itr.subject || itr.body?.slice(0, 60) || '—'}
                        </td>
                        <td className="py-2 pr-3 text-gray-500">{itr.direction || '—'}</td>
                        <td className="py-2 pr-3 text-gray-500">{itr.source || 'manual'}</td>
                        <td className="py-2 pr-3 text-gray-400 whitespace-nowrap">
                          {formatRelativeTime(itr.completed_at || itr.created_at)}
                        </td>
                        <td className="py-2">
                          <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                            itr.status === 'missed' || itr.status === 'failed' ? 'bg-red-100 text-red-600' :
                            itr.status === 'scheduled' ? 'bg-blue-100 text-blue-600' :
                            'bg-gray-100 text-gray-500'
                          }`}>
                            {itr.status || 'completed'}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {!loading && interactions.length === 0 && (
                <p className="text-center text-sm text-gray-400 py-8">Aucune interaction</p>
              )}
            </div>
          )}
        </div>
      </div>

      {createType && (
        <InteractionFormModal
          type={createType}
          onClose={() => setCreateType(null)}
          onCreated={() => {
            setCreateType(null)
            loadInteractions(1, true)
            loadStats()
          }}
        />
      )}
    </Layout>
  )
}
