import { useState, useEffect } from 'react'
import { Layout } from '../components/Layout.jsx'
import { Webhook, Plus, X } from 'lucide-react'
import { useToast } from '../contexts/ToastContext.jsx'
import { api } from '../lib/api.js'
import { baseAPI } from '../hooks/useBaseAPI.js'

const EVENTS = ['record:created', 'record:updated', 'record:deleted']

function formatRelative(dateStr) {
  if (!dateStr) return '—'
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'à l\'instant'
  if (mins < 60) return `il y a ${mins}min`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `il y a ${hrs}h`
  return `il y a ${Math.floor(hrs / 24)}j`
}

export function WebhooksContent() {
  const [webhooks, setWebhooks] = useState([])
  const [tables, setTables] = useState([])
  const [editing, setEditing] = useState(null) // null | 'new' | {id,...}
  const { addToast } = useToast()

  useEffect(() => {
    load()
    baseAPI.tables().then(r => setTables(r.tables || []))
  }, [])

  async function load() {
    try {
      const data = await api.webhooks.list()
      setWebhooks(data)
    } catch {
      addToast({ message: 'Erreur de chargement', type: 'error' })
    }
  }

  async function toggleActive(wh, e) {
    e.stopPropagation()
    try {
      await api.webhooks.update(wh.id, { enabled: !wh.active })
      load()
    } catch {
      addToast({ message: 'Erreur', type: 'error' })
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Webhook size={22} /> Webhooks
        </h2>
        <button onClick={() => setEditing('new')}
          className="flex items-center gap-1.5 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
          <Plus size={14} /> Nouveau webhook
        </button>
      </div>

      <div className="bg-white rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Nom / URL</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Table</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Événements</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Statut</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Dernier tir</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {webhooks.map(wh => (
              <tr key={wh.id} className="hover:bg-gray-50 cursor-pointer"
                onClick={() => setEditing(wh)}>
                <td className="px-4 py-3">
                  <div className="font-medium">{wh.name}</div>
                  <div className="text-xs text-gray-400 truncate max-w-xs">{wh.url}</div>
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">{wh.table_name || 'Toutes'}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {(wh.events || []).map(ev => (
                      <span key={ev} className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{ev}</span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <button onClick={(e) => toggleActive(wh, e)}
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${
                      wh.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                    }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${wh.active ? 'bg-green-500' : 'bg-gray-400'}`} />
                    {wh.active ? 'Actif' : 'Inactif'}
                  </button>
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">{formatRelative(wh.last_triggered_at)}</td>
              </tr>
            ))}
            {webhooks.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-gray-400">
                  Aucun webhook configuré.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <WebhookModal
          webhook={editing === 'new' ? null : editing}
          tables={tables}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
    </div>
  )
}

export default function Webhooks() {
  return <Layout><div className="p-6 max-w-5xl mx-auto"><WebhooksContent /></div></Layout>
}

function WebhookModal({ webhook, tables, onClose, onSaved }) {
  const { addToast } = useToast()
  const [name, setName] = useState(webhook?.name || '')
  const [url, setUrl] = useState(webhook?.url || '')
  const [tableId, setTableId] = useState(webhook?.table_id || '')
  const [events, setEvents] = useState(webhook?.events || ['record:created', 'record:updated', 'record:deleted'])
  const [secret, setSecret] = useState(webhook?.secret || '')
  const [active, setActive] = useState(webhook ? !!webhook.active : true)
  const [saving, setSaving] = useState(false)

  function toggleEvent(ev) {
    setEvents(prev => prev.includes(ev) ? prev.filter(e => e !== ev) : [...prev, ev])
  }

  async function handleSave() {
    if (!url.trim()) { addToast({ message: 'URL requise', type: 'error' }); return }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      addToast({ message: 'URL invalide (doit commencer par http:// ou https://)', type: 'error' }); return
    }
    setSaving(true)
    const body = {
      name: name || url,
      url: url.trim(),
      table_id: tableId || null,
      events,
      secret: secret || null,
      enabled: active,
    }
    try {
      if (webhook) {
        await api.webhooks.update(webhook.id, body)
        addToast({ message: 'Webhook mis à jour', type: 'success' })
      } else {
        await api.webhooks.create(body)
        addToast({ message: 'Webhook créé', type: 'success' })
      }
      onSaved()
    } catch (e) {
      addToast({ message: e.message || 'Erreur', type: 'error' })
    }
    setSaving(false)
  }

  async function handleDelete() {
    if (!confirm(`Supprimer ce webhook ?`)) return
    await api.webhooks.delete(webhook.id).catch(() => {})
    addToast({ message: 'Webhook supprimé', type: 'success' })
    onSaved()
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-base font-semibold">{webhook ? 'Modifier le webhook' : 'Nouveau webhook'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Nom (optionnel)</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="Mon webhook" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">URL cible *</label>
            <input type="url" value={url} onChange={e => setUrl(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="https://..." />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Table</label>
            <select value={tableId} onChange={e => setTableId(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="">Toutes les tables</option>
              {tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Événements</label>
            <div className="flex flex-col gap-2">
              {EVENTS.map(ev => (
                <label key={ev} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={events.includes(ev)} onChange={() => toggleEvent(ev)} />
                  <span className="text-sm">{ev}</span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Secret</label>
            <input type="text" value={secret} onChange={e => setSecret(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
              placeholder="Optionnel — utilisé pour signer les requêtes (HMAC-SHA256)" />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
            <span className="text-sm">Activé</span>
          </label>
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t">
          <div>
            {webhook && (
              <button onClick={handleDelete}
                className="px-3 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50">
                Supprimer
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Annuler</button>
            <button onClick={handleSave} disabled={saving}
              className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
              {saving ? 'Enregistrement...' : webhook ? 'Mettre à jour' : 'Créer'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
