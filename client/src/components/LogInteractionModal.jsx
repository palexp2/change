import { useState } from 'react'
import { Save, X } from 'lucide-react'
import api from '../lib/api.js'
import { Modal } from './Modal.jsx'
import { ChoiceSelect } from './ChoiceSelect.jsx'
import LinkedRecordField from './LinkedRecordField.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import DateInput from './DateInput.jsx'

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

const pad = n => String(n).padStart(2, '0')

// Heure saisie en texte « HH:MM » 24 h : le champ natif date + heure suit la
// langue du navigateur (« 17 h 48 », « 5:48 PM »), jamais le format de l'app.
// Accepte « 1748 », « 17h48 », « 9:05 ». null si illisible.
function parseTime(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\s*[:hH ]?\s*(\d{2})$/)
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null
  return `${pad(m[1])}:${m[2]}`
}

export default function LogInteractionModal({ contactId, companyId, contacts, onClose, onSaved }) {
  const { addToast } = useToast()
  // Un seul contact dans l'entreprise : c'est forcément lui, présélectionné.
  const initialContactId = contactId || (contacts?.length === 1 ? contacts[0].id : '')
  const [form, setForm] = useState(() => {
    const d = new Date()
    return {
      type: 'call', direction: 'out', notes: '', contact_id: initialContactId || '',
      day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    }
  })
  const [saving, setSaving] = useState(false)
  const directional = LOG_TYPES.find(t => t.value === form.type)?.directional

  async function submit(e) {
    e.preventDefault()
    const time = form.time.trim() ? parseTime(form.time) : '00:00'
    if (!time) { addToast({ message: 'Heure : HH:MM', type: 'error' }); return }
    setSaving(true)
    try {
      await api.interactions.create({
        contact_id: form.contact_id || null,
        company_id: companyId || null,
        type: form.type,
        direction: directional ? form.direction : null,
        // Jour + heure saisis en heure du navigateur : converti en ISO UTC,
        // la convention de stockage.
        timestamp: form.day ? new Date(`${form.day}T${time}`).toISOString() : null,
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
            <ChoiceSelect
              value={form.type}
              choices={LOG_TYPES}
              table="interactions" field="type" colorsOnly
              onChange={v => setForm(f => ({ ...f, type: v }))}
              className="input w-full"
              emptyOption={null}
              testId="log-interaction-type"
            />
          </div>
          {directional && (
            <div>
              <label className="label">Sens</label>
              <ChoiceSelect
                value={form.direction}
                choices={[{ value: 'out', label: 'Sortant' }, { value: 'in', label: 'Entrant' }]}
                table="interactions" field="direction" colorsOnly
                onChange={v => setForm(f => ({ ...f, direction: v }))}
                className="input w-full"
                emptyOption={null}
              />
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
          <div className="flex gap-2">
            <DateInput
              value={form.day}
              onChange={e => setForm(f => ({ ...f, day: e.target.value }))}
              className="input flex-1"
              data-testid="log-interaction-day"
            />
            <input
              type="text"
              inputMode="numeric"
              maxLength={5}
              value={form.time}
              onChange={e => setForm(f => ({ ...f, time: e.target.value }))}
              onBlur={() => setForm(f => ({ ...f, time: parseTime(f.time) || f.time }))}
              className="input w-20 text-center tabular-nums"
              data-testid="log-interaction-time"
            />
          </div>
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
