import { useState, useEffect } from 'react'
import { Plus, Phone, Mail, MessageSquare } from 'lucide-react'
import InteractionTimeline from '../../interactions/InteractionTimeline.jsx'
import InteractionFormModal from '../../interactions/InteractionFormModal.jsx'

const API_BASE = '/erp/api'

export default function InteractionTimelineBlock({ block, config, selectedRecord, selectedRecordId }) {
  const [interactions, setInteractions] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [createType, setCreateType] = useState(null)

  useEffect(() => {
    if (!selectedRecordId) { setInteractions([]); setLoading(false); return }
    loadData()
  }, [selectedRecordId, config.limit, config.show_stats])

  async function loadData() {
    setLoading(true)
    const token = localStorage.getItem('erp_token')
    const qs = new URLSearchParams({ limit: String(config.limit || 20) })
    try {
      const res = await fetch(`${API_BASE}/base/records/${selectedRecordId}/interactions?${qs}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      const data = await res.json()
      setInteractions(data.data || [])

      if (config.show_stats) {
        const statsRes = await fetch(
          `${API_BASE}/base/interactions/stats?record_id=${selectedRecordId}&period=month`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        )
        setStats(await statsRes.json())
      }
    } catch {}
    setLoading(false)
  }

  if (!selectedRecordId) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-400 italic">
        Sélectionnez un enregistrement
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Stats bandeau */}
      {config.show_stats && stats && (
        <div className="flex gap-3 px-3 py-2 border-b shrink-0">
          {Object.entries(stats.by_type || {}).map(([type, count]) => (
            <span key={type} className="text-xs text-gray-500 flex items-center gap-1">
              {type === 'call' && <Phone size={10} />}
              {type === 'email' && <Mail size={10} />}
              {type === 'sms' && <MessageSquare size={10} />}
              {count}
            </span>
          ))}
        </div>
      )}

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {loading ? (
          <div className="text-center py-4 text-xs text-gray-400">Chargement…</div>
        ) : (
          <InteractionTimeline
            interactions={interactions}
            showLinkedRecords={false}
            onDelete={null}
          />
        )}
      </div>

      {/* Create button */}
      {config.allow_create && (
        <div className="px-3 py-2 border-t shrink-0">
          <button
            onClick={() => setCreateType('note')}
            className="text-xs text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
          >
            <Plus size={12} /> Logger une interaction
          </button>
        </div>
      )}

      {createType && (
        <InteractionFormModal
          type={createType}
          recordId={selectedRecordId}
          tableId={selectedRecord?.table_id}
          onClose={() => setCreateType(null)}
          onCreated={() => { setCreateType(null); loadData() }}
        />
      )}
    </div>
  )
}
