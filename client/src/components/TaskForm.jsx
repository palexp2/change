import { useState, useEffect, useCallback } from 'react'
import { Plus, X, Save, Trash2 } from 'lucide-react'
import { api } from '../lib/api.js'
import LinkedRecordField from './LinkedRecordField.jsx'
import { useConfirm } from './ConfirmProvider.jsx'

const STATUSES = ['À faire', 'En cours', 'Terminé', 'Annulé']
const PRIORITIES = ['Basse', 'Normal', 'Haute', 'Urgente']
const TYPES = ['Problème']

export function parseKeywords(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string' && v.trim()) { try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] } }
  return []
}

function KeywordPicker({ value, onChange }) {
  const [catalog, setCatalog] = useState([])
  const [open, setOpen] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const confirm = useConfirm()

  const load = useCallback(() => {
    api.tasks.keywords.list().then(r => setCatalog(r.data || [])).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  function toggle(id) {
    onChange(value.includes(id) ? value.filter(v => v !== id) : [...value, id])
  }

  async function handleCreate(e) {
    e.preventDefault()
    if (!newLabel.trim()) return
    const created = await api.tasks.keywords.create({ label: newLabel.trim() })
    setNewLabel('')
    setCatalog(c => c.some(k => k.id === created.id) ? c : [...c, created].sort((a, b) => a.label.localeCompare(b.label)))
    if (!value.includes(created.id)) onChange([...value, created.id])
  }

  async function handleDelete(id) {
    if (!(await confirm('Supprimer ce mot-clé du catalogue ?'))) return
    await api.tasks.keywords.delete(id)
    setCatalog(c => c.filter(k => k.id !== id))
    if (value.includes(id)) onChange(value.filter(v => v !== id))
  }

  const selectedLabels = value.map(id => catalog.find(k => k.id === id)).filter(Boolean)

  return (
    <div>
      <label className="label">Mots-clés</label>
      <div className="relative">
        <button type="button" onClick={() => setOpen(o => !o)} className="input text-left flex flex-wrap gap-1 min-h-[38px] items-center">
          {selectedLabels.length === 0 && <span className="text-slate-400">Choisir…</span>}
          {selectedLabels.map(k => (
            <span key={k.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-brand-100 text-brand-700 text-xs">{k.label}</span>
          ))}
        </button>
        {open && (
          <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
            {catalog.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">Aucun mot-clé. Ajoutez-en un ci-dessous.</div>}
            {catalog.map(k => (
              <div key={k.id} className="flex items-center justify-between px-3 py-1.5 hover:bg-slate-50">
                <label className="flex items-center gap-2 text-sm flex-1 cursor-pointer">
                  <input type="checkbox" checked={value.includes(k.id)} onChange={() => toggle(k.id)} />
                  {k.label}
                </label>
                <button type="button" onClick={() => handleDelete(k.id)} className="text-slate-400 hover:text-red-500"><Trash2 size={14} /></button>
              </div>
            ))}
            <div className="flex gap-1 p-2 border-t border-slate-200">
              <input value={newLabel} onChange={e => setNewLabel(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleCreate(e)} className="input flex-1 text-sm" placeholder="Nouveau mot-clé…" />
              <button type="button" onClick={handleCreate} className="btn-secondary px-2"><Plus size={14} /></button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function TaskForm({ initial = {}, companies = [], contacts = [], users = [], tickets = [], defaultAssignedTo = '', onSave, onClose }) {
  const [form, setForm] = useState({
    title: '', description: '', status: 'À faire', priority: 'Normal',
    due_date: '', company_id: '', contact_id: '', notes: '',
    ...initial,
    type: initial.type || '',
    ticket_id: initial.ticket_id || '',
    assigned_to: initial.id ? (initial.assigned_to || '') : (defaultAssignedTo || ''),
    keywords: parseKeywords(initial.keywords),
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.title.trim()) return setError('Le titre est requis')
    setError('')
    setSaving(true)
    try {
      await onSave(form)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const f = (k) => (e) => setForm(p => ({ ...p, [k]: e.target.value }))
  const setKey = (k) => (v) => setForm(p => ({ ...p, [k]: v }))

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Titre *</label>
        <input value={form.title} onChange={f('title')} className="input" placeholder="Titre de la tâche" autoFocus />
      </div>
      <div>
        <label className="label">Description</label>
        <textarea value={form.description} onChange={f('description')} className="input" rows={2} placeholder="Optionnel" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Statut</label>
          <select value={form.status} onChange={f('status')} className="select">
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Priorité</label>
          <select value={form.priority} onChange={f('priority')} className="select">
            {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Type</label>
          <select value={form.type || ''} onChange={f('type')} className="select">
            <option value="">—</option>
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="label">Date d'échéance</label>
        <input type="date" value={form.due_date || ''} onChange={f('due_date')} className="input" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Entreprise</label>
          <LinkedRecordField
            name="task_company_id"
            value={form.company_id || ''}
            options={companies}
            labelFn={c => c.name}
            placeholder="Entreprise"
            onChange={setKey('company_id')}
          />
        </div>
        <div>
          <label className="label">Contact</label>
          <LinkedRecordField
            name="task_contact_id"
            value={form.contact_id || ''}
            options={contacts}
            labelFn={c => `${c.first_name || ''} ${c.last_name || ''}`.trim()}
            placeholder="Contact"
            onChange={setKey('contact_id')}
          />
        </div>
      </div>
      <div>
        <label className="label">Billet</label>
        <LinkedRecordField
          name="task_ticket_id"
          value={form.ticket_id || ''}
          options={tickets}
          labelFn={t => t.title || '(sans titre)'}
          getHref={t => `/tickets/${t.id}`}
          placeholder="Billet"
          onChange={setKey('ticket_id')}
        />
      </div>
      <div>
        <label className="label">Responsable</label>
        <LinkedRecordField
          name="task_assigned_to"
          value={form.assigned_to || ''}
          options={users}
          labelFn={u => u.name}
          placeholder="Responsable"
          onChange={setKey('assigned_to')}
        />
      </div>
      <KeywordPicker value={form.keywords} onChange={(kw) => setForm(p => ({ ...p, keywords: kw }))} />
      <div>
        <label className="label">Notes</label>
        <textarea value={form.notes || ''} onChange={f('notes')} className="input" rows={2} />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary"><X size={14} /> Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary"><Save size={14} /> {saving ? 'Enregistrement...' : 'Enregistrer'}</button>
      </div>
    </form>
  )
}
