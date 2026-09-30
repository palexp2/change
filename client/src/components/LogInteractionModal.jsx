import { useState } from 'react'
import { Save, X } from 'lucide-react'
import api from '../lib/api.js'
import { Modal } from './Modal.jsx'
import LinkedRecordField from './LinkedRecordField.jsx'
import { useToast } from '../contexts/ToastContext.jsx'

// ─── Log manuel d'une interaction ────────────────────────────────────────────
// Ce qui n'est pas passé par l'ERP (appel sur le cellulaire, discussion à un
// salon, SMS) n'a aucune trace dans le fil. Cette modale la crée à la main.
// `contacts` (optionnel) : depuis une fiche entreprise, le contact n'est pas
// connu d'avance — la modale offre alors de le choisir parmi ceux-ci.
const LOG_TYPES = [
  { value: 'call',    label: 'Appel',   directional: true },
  { value: 'sms',     label: 'SMS',     directional: true },
  { value: 'meeting', label: 'Réunion' },
  { value: 'note',    label: 'Note' },
]

function nowLocalInput() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function LogInteractionModal({ contactId, companyId, contacts, onClose, onSaved }) {
  const { addToast } = useToast()
  const [form, setForm] = useState({ type: 'call', direction: 'out', at: nowLocalInput(), notes: '', contact_id: contactId || '' })
  const [saving, setSaving] = useState(false)
  const directional = LOG_TYPES.find(t => t.value === form.type)?.directional

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    try {
      await api.interactions.create({
        contact_id: form.contact_id || null,
        company_id: companyId || null,
        type: form.type,
        direction: directional ? form.direction : null,
        // datetime-local est en heure du navigateur : converti en ISO UTC,
        // la convention de stockage.
        timestamp: form.at ? new Date(form.at).toISOString() : null,
        notes: form.notes.trim() || null,
      })
      await onSaved()
      onClose()
    } catch (err) {
      addToast({ message: err.message || 'Erreur', type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen={true} onClose={onClose} title="Consigner une interaction" size="sm">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Type</label>
            <select
              value={form.type}
              onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
              className="select"
              data-testid="log-interaction-type"
            >
              {LOG_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          {directional && (
            <div>
              <label className="label">Sens</label>
              <select
                value={form.direction}
                onChange={e => setForm(f => ({ ...f, direction: e.target.value }))}
                className="select"
              >
                <option value="out">Sortant</option>
                <option value="in">Entrant</option>
              </select>
            </div>
          )}
        </div>
        {contacts && (
          <div>
            <label className="label">Contact</label>
            <LinkedRecordField
              name="log_interaction_contact_id"
              value={form.contact_id || ''}
              options={contacts}
              labelFn={c => `${c.first_name || ''} ${c.last_name || ''}`.trim()}
              getHref={c => `/contacts/${c.id}`}
              onChange={v => setForm(f => ({ ...f, contact_id: v || '' }))}
            />
          </div>
        )}
        <div>
          <label className="label">Quand</label>
          <input
            type="datetime-local"
            value={form.at}
            onChange={e => setForm(f => ({ ...f, at: e.target.value }))}
            className="input"
          />
        </div>
        <div>
          <label className="label">Notes</label>
          <textarea
            value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            className="input"
            rows={4}
            autoFocus
            data-testid="log-interaction-notes"
          />
        </div>
        <div className="flex justify-end gap-3 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary"><X size={14} /> Annuler</button>
          <button type="submit" disabled={saving} className="btn-primary" data-testid="log-interaction-save">
            <Save size={14} /> {saving ? 'Enregistrement...' : 'Enregistrer'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
