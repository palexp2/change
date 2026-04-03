import { useState, useEffect, useCallback } from 'react'
import { Users, Plus, X, Check, Pencil, Trash2 } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

const EMPTY = {
  first_name: '', last_name: '', phone_personal: '', phone_work: '',
  email_personal: '', email_work: '', birth_date: '', hire_date: '', matricule: '',
}

function EmployeeForm({ initial = EMPTY, onSave, onCancel, saving }) {
  const [form, setForm] = useState(initial)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <div className="grid grid-cols-2 gap-3 p-4 bg-slate-50 rounded-xl border border-slate-200">
      <div>
        <label className="label text-xs">Prénom *</label>
        <input className="input text-sm" value={form.first_name} onChange={e => set('first_name', e.target.value)} />
      </div>
      <div>
        <label className="label text-xs">Nom *</label>
        <input className="input text-sm" value={form.last_name} onChange={e => set('last_name', e.target.value)} />
      </div>
      <div>
        <label className="label text-xs">Matricule</label>
        <input className="input text-sm" value={form.matricule} onChange={e => set('matricule', e.target.value)} />
      </div>
      <div>
        <label className="label text-xs">Date d'embauche</label>
        <input type="date" className="input text-sm" value={form.hire_date} onChange={e => set('hire_date', e.target.value)} />
      </div>
      <div>
        <label className="label text-xs">Date de naissance</label>
        <input type="date" className="input text-sm" value={form.birth_date} onChange={e => set('birth_date', e.target.value)} />
      </div>
      <div />
      <div>
        <label className="label text-xs">Courriel travail</label>
        <input type="email" className="input text-sm" value={form.email_work} onChange={e => set('email_work', e.target.value)} />
      </div>
      <div>
        <label className="label text-xs">Courriel perso</label>
        <input type="email" className="input text-sm" value={form.email_personal} onChange={e => set('email_personal', e.target.value)} />
      </div>
      <div>
        <label className="label text-xs">Téléphone travail</label>
        <input type="tel" className="input text-sm" value={form.phone_work} onChange={e => set('phone_work', e.target.value)} />
      </div>
      <div>
        <label className="label text-xs">Téléphone perso</label>
        <input type="tel" className="input text-sm" value={form.phone_personal} onChange={e => set('phone_personal', e.target.value)} />
      </div>
      <div className="col-span-2 flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="btn-secondary btn-sm flex items-center gap-1.5">
          <X size={13} /> Annuler
        </button>
        <button
          onClick={() => onSave(form)}
          disabled={saving || !form.first_name || !form.last_name}
          className="btn-primary btn-sm flex items-center gap-1.5"
        >
          <Check size={13} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>
    </div>
  )
}

function EmployeeRow({ emp, onEdit, onDelete }) {
  const [confirming, setConfirming] = useState(false)

  return (
    <div className="card p-4 flex items-center gap-4 hover:shadow-sm transition-shadow">
      <div className="w-9 h-9 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center font-semibold text-sm flex-shrink-0">
        {emp.first_name[0]}{emp.last_name[0]}
      </div>
      <div className="flex-1 min-w-0 grid grid-cols-4 gap-x-4 gap-y-0.5">
        <div className="col-span-2">
          <p className="font-semibold text-slate-900 text-sm">{emp.first_name} {emp.last_name}</p>
          {emp.matricule && <p className="text-xs text-slate-400">#{emp.matricule}</p>}
        </div>
        <div>
          {emp.email_work && <p className="text-xs text-slate-600 truncate">{emp.email_work}</p>}
          {emp.email_personal && <p className="text-xs text-slate-400 truncate">{emp.email_personal}</p>}
        </div>
        <div>
          {emp.phone_work && <p className="text-xs text-slate-600">{emp.phone_work}</p>}
          {emp.phone_personal && <p className="text-xs text-slate-400">{emp.phone_personal}</p>}
        </div>
        <div>
          {emp.hire_date && <p className="text-xs text-slate-500">Embauche: {fmtDate(emp.hire_date)}</p>}
        </div>
        <div>
          {emp.birth_date && <p className="text-xs text-slate-500">Naissance: {fmtDate(emp.birth_date)}</p>}
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button onClick={() => onEdit(emp)} className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors">
          <Pencil size={14} />
        </button>
        {confirming
          ? <>
              <button onClick={() => onDelete(emp.id)} className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg transition-colors text-xs font-medium">Supprimer</button>
              <button onClick={() => setConfirming(false)} className="p-1.5 text-slate-400 hover:bg-slate-100 rounded-lg transition-colors"><X size={14} /></button>
            </>
          : <button onClick={() => setConfirming(true)} className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
              <Trash2 size={14} />
            </button>
        }
      </div>
    </div>
  )
}

export default function Employees() {
  const [employees, setEmployees] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await api.employees.list({ limit: 200 })
      setEmployees(data || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleCreate(form) {
    setSaving(true)
    try {
      const emp = await api.employees.create(form)
      setEmployees(prev => [emp, ...prev])
      setShowForm(false)
    } catch (e) { alert(e.message) } finally { setSaving(false) }
  }

  async function handleUpdate(form) {
    setSaving(true)
    try {
      const emp = await api.employees.update(editing.id, form)
      setEmployees(prev => prev.map(e => e.id === emp.id ? emp : e))
      setEditing(null)
    } catch (e) { alert(e.message) } finally { setSaving(false) }
  }

  async function handleDelete(id) {
    try {
      await api.employees.delete(id)
      setEmployees(prev => prev.filter(e => e.id !== id))
    } catch (e) { alert(e.message) }
  }

  const filtered = q
    ? employees.filter(e =>
        `${e.first_name} ${e.last_name} ${e.matricule || ''} ${e.email_work || ''}`.toLowerCase().includes(q.toLowerCase())
      )
    : employees

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Users size={22} className="text-indigo-600" />
            <h1 className="text-2xl font-bold text-slate-900">Employés</h1>
            {!loading && <span className="text-sm text-slate-400">· {employees.length}</span>}
          </div>
          <button onClick={() => { setShowForm(true); setEditing(null) }} className="btn-primary flex items-center gap-2">
            <Plus size={15} /> Nouvel employé
          </button>
        </div>

        {showForm && !editing && (
          <div className="mb-4">
            <EmployeeForm onSave={handleCreate} onCancel={() => setShowForm(false)} saving={saving} />
          </div>
        )}

        <div className="mb-4">
          <input
            className="input text-sm max-w-xs"
            placeholder="Rechercher…"
            value={q}
            onChange={e => setQ(e.target.value)}
          />
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" /></div>
        ) : filtered.length === 0 ? (
          <div className="card p-16 text-center">
            <Users size={40} className="text-slate-300 mx-auto mb-3" />
            <p className="text-slate-500 font-medium">{q ? 'Aucun résultat' : 'Aucun employé'}</p>
            {!q && <p className="text-sm text-slate-400 mt-1">Cliquez sur «Nouvel employé» pour commencer.</p>}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(emp => editing?.id === emp.id
              ? <EmployeeForm key={emp.id} initial={{ ...emp, birth_date: emp.birth_date || '', hire_date: emp.hire_date || '' }} onSave={handleUpdate} onCancel={() => setEditing(null)} saving={saving} />
              : <EmployeeRow key={emp.id} emp={emp} onEdit={setEditing} onDelete={handleDelete} />
            )}
          </div>
        )}
      </div>
    </Layout>
  )
}
