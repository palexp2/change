import { useState } from 'react'
import { X } from 'lucide-react'
import { useToast } from '../ui/ToastProvider.jsx'

const TYPE_LABELS = { call: 'Appel', email: 'Courriel', sms: 'SMS', note: 'Note', meeting: 'Réunion' }
const API_BASE = '/erp/api'

export default function InteractionFormModal({ type, recordId, tableId, onClose, onCreated }) {
  const [form, setForm] = useState({
    type,
    direction: type === 'note' ? null : 'outbound',
    subject: '',
    body: '',
    phone_number: '',
    from_address: '',
    to_addresses: [],
    duration_minutes: '',
    duration_seconds_part: '',
    status: type === 'meeting' ? 'scheduled' : 'completed',
    scheduled_at: '',
    completed_at: new Date().toISOString().slice(0, 16),
  })
  const [submitting, setSubmitting] = useState(false)
  const { addToast } = useToast()

  function set(key, val) {
    setForm(f => ({ ...f, [key]: val }))
  }

  async function handleSubmit() {
    if (type === 'email' && !form.subject) {
      addToast({ message: 'Le sujet est requis', type: 'error' })
      return
    }
    setSubmitting(true)
    const token = localStorage.getItem('erp_token')
    const durationSec = form.duration_minutes || form.duration_seconds_part
      ? (Number(form.duration_minutes || 0) * 60) + Number(form.duration_seconds_part || 0)
      : null

    const body = {
      type: form.type,
      direction: form.direction,
      subject: form.subject || null,
      body: form.body || null,
      phone_number: form.phone_number || null,
      from_address: form.from_address || null,
      to_addresses: form.to_addresses.length > 0 ? form.to_addresses : undefined,
      status: form.status,
      completed_at: form.completed_at ? new Date(form.completed_at).toISOString() : new Date().toISOString(),
      scheduled_at: form.scheduled_at ? new Date(form.scheduled_at).toISOString() : null,
      duration_seconds: durationSec,
      links: recordId ? [{ table_id: tableId, record_id: recordId }] : [],
    }

    try {
      const res = await fetch(`${API_BASE}/base/interactions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      addToast({ message: 'Interaction enregistrée', type: 'success' })
      onCreated()
    } catch (err) {
      addToast({ message: err.message || 'Erreur', type: 'error' })
    }
    setSubmitting(false)
  }

  return (
    <div className="fixed inset-0 bg-black/30 z-[70] flex items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-[480px] max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="font-semibold text-gray-900">
            Nouveau {TYPE_LABELS[type]?.toLowerCase()}
          </h3>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Direction */}
          {type !== 'note' && (
            <div className="flex gap-2">
              <button onClick={() => set('direction', 'outbound')}
                className={`flex-1 py-2 text-sm rounded-lg border transition-colors ${
                  form.direction === 'outbound' ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                }`}>
                {type === 'call' ? 'Sortant' : type === 'email' ? 'Envoyé' : 'Sortant'}
              </button>
              <button onClick={() => set('direction', 'inbound')}
                className={`flex-1 py-2 text-sm rounded-lg border transition-colors ${
                  form.direction === 'inbound' ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                }`}>
                {type === 'call' ? 'Entrant' : type === 'email' ? 'Reçu' : 'Entrant'}
              </button>
            </div>
          )}

          {/* Phone (call, sms) */}
          {(type === 'call' || type === 'sms') && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Numéro</label>
              <input type="tel" value={form.phone_number}
                onChange={e => set('phone_number', e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm"
                placeholder="+1 514 555 0000" />
            </div>
          )}

          {/* Email fields */}
          {type === 'email' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">De</label>
                <input type="email" value={form.from_address}
                  onChange={e => set('from_address', e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">À</label>
                <input type="text"
                  value={form.to_addresses.join(', ')}
                  onChange={e => set('to_addresses', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                  placeholder="email@exemple.com, ..." />
              </div>
            </>
          )}

          {/* Subject */}
          {['email','note','meeting'].includes(type) && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Sujet {type === 'email' && <span className="text-red-500">*</span>}
              </label>
              <input type="text" value={form.subject}
                onChange={e => set('subject', e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
          )}

          {/* Call duration */}
          {type === 'call' && form.status !== 'missed' && (
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">Minutes</label>
                <input type="number" min="0" value={form.duration_minutes}
                  onChange={e => set('duration_minutes', e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">Secondes</label>
                <input type="number" min="0" max="59" value={form.duration_seconds_part}
                  onChange={e => set('duration_seconds_part', e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>
          )}

          {/* Call status */}
          {type === 'call' && (
            <div className="flex gap-2">
              {['completed','missed','voicemail'].map(s => (
                <button key={s} onClick={() => set('status', s)}
                  className={`flex-1 py-1.5 text-xs rounded-lg border transition-colors ${
                    form.status === s ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                  }`}>
                  {{ completed: 'Complété', missed: 'Manqué', voicemail: 'Messagerie' }[s]}
                </button>
              ))}
            </div>
          )}

          {/* Meeting scheduled_at */}
          {type === 'meeting' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Date et heure</label>
              <input type="datetime-local" value={form.scheduled_at}
                onChange={e => set('scheduled_at', e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
          )}

          {/* Date */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
            <input type="datetime-local" value={form.completed_at}
              onChange={e => set('completed_at', e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>

          {/* Notes / body */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {type === 'email' ? 'Corps' : type === 'sms' ? 'Message' : 'Notes'}
            </label>
            <textarea value={form.body} onChange={e => set('body', e.target.value)}
              rows={type === 'sms' ? 3 : 4}
              maxLength={type === 'sms' ? 1600 : undefined}
              className="w-full border rounded-lg px-3 py-2 text-sm resize-y" />
            {type === 'sms' && (
              <p className="text-[10px] text-gray-400 mt-0.5 text-right">{form.body.length}/1600</p>
            )}
          </div>
        </div>

        <div className="px-5 py-4 border-t bg-gray-50 flex justify-end gap-2">
          <button onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
            Annuler
          </button>
          <button onClick={handleSubmit} disabled={submitting}
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors">
            {submitting ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </div>
    </div>
  )
}
