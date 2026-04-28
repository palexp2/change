import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Plus, Trash2 } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'

const DEPARTMENTS = ['R&D', 'Opérations', 'Marketing']
const GENDERS = ['Homme', 'Femme', 'Autre']

const SECTIONS = [
  {
    title: 'Identité',
    fields: [
      { key: 'first_name', label: 'Prénom', type: 'text' },
      { key: 'last_name',  label: 'Nom',    type: 'text' },
      { key: 'gender',     label: 'Genre',  type: 'select', options: GENDERS },
      { key: 'birth_date', label: 'Date de naissance', type: 'date' },
      { key: 'address',    label: 'Adresse de résidence', type: 'textarea', span2: true },
      { key: 'emergency_contact', label: "Contact d'urgence", type: 'textarea', span2: true },
      { key: 'address_verified',  label: 'Adresse validée',   type: 'checkbox', span2: true },
    ],
  },
  {
    title: 'Coordonnées',
    fields: [
      { key: 'email_work',     label: 'Courriel travail', type: 'email' },
      { key: 'email_personal', label: 'Courriel perso',   type: 'email' },
      { key: 'phone_work',     label: 'Téléphone travail', type: 'tel' },
      { key: 'phone_personal', label: 'Téléphone perso',   type: 'tel' },
    ],
  },
  {
    title: 'Emploi',
    fields: [
      { key: 'matricule', label: 'Matricule', type: 'text' },
      { key: 'accounting_department', label: 'Département', type: 'select', options: DEPARTMENTS },
      { key: 'hire_date', label: "Date d'embauche", type: 'date' },
      { key: 'end_date',  label: "Date de fin d'emploi", type: 'date' },
      { key: 'hours_per_week',   label: 'Heures par semaine', type: 'number', step: '0.5' },
      { key: 'last_raise_date',  label: 'Dernière augmentation', type: 'date' },
      { key: 'active',         label: 'Actif',          type: 'checkbox' },
      { key: 'is_salesperson', label: 'Vendeur',        type: 'checkbox' },
      { key: 'is_consultant',  label: 'Consultant',     type: 'checkbox' },
      { key: 'office_key',     label: 'Clef du bureau', type: 'checkbox' },
    ],
  },
  {
    title: 'Paie & assurances',
    fields: [
      { key: 'nethris_username', label: 'Nethris username', type: 'text' },
      { key: 'insurance_id',     label: 'ID Assurances',    type: 'text' },
      { key: 'banking_info',     label: 'Coordonnées bancaires', type: 'text', span2: true },
      { key: 'group_insurance',  label: 'Assurance collective',  type: 'checkbox', span2: true },
    ],
  },
  {
    title: 'Notes',
    fields: [
      { key: 'peer_reviews', label: 'Évaluations par les pairs', type: 'textarea', span2: true },
      { key: 'issues',       label: 'Problèmes',                 type: 'textarea', span2: true },
    ],
  },
]

const BOOL_KEYS = new Set(['active', 'is_salesperson', 'is_consultant', 'office_key', 'group_insurance', 'address_verified'])

function normalize(raw) {
  const out = { ...raw }
  for (const k of BOOL_KEYS) out[k] = raw?.[k] ? 1 : 0
  return out
}

const inp = 'w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:border-indigo-400 bg-white'

export default function EmployeeDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const { addToast } = useToast()
  const [employee, setEmployee] = useState(null)
  const [form, setForm] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const saveTimer = useRef(null)
  const pendingRef = useRef({})

  async function load() {
    setLoading(true)
    try {
      const data = await api.employees.get(id)
      setEmployee(data)
      setForm(normalize(data))
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [id])
  useEffect(() => () => clearTimeout(saveTimer.current), [])

  function change(key, val) {
    setForm(f => ({ ...f, [key]: val }))
    pendingRef.current[key] = val
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flush, 400)
  }

  async function flush() {
    const patch = pendingRef.current
    pendingRef.current = {}
    if (!Object.keys(patch).length) return
    setSaving(true)
    try {
      const updated = await api.employees.update(id, patch)
      setEmployee(updated)
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!(await confirm(`Supprimer ${employee.first_name} ${employee.last_name} ?`))) return
    try {
      await api.employees.delete(id)
      navigate('/employees')
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    }
  }

  if (loading || !form) {
    return <Layout><div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600" /></div></Layout>
  }
  if (!employee) {
    return <Layout><div className="p-6 text-slate-500">Employé introuvable.</div></Layout>
  }

  const initials = (form.first_name?.[0] || '') + (form.last_name?.[0] || '')

  return (
    <Layout>
      <div className="p-6 max-w-4xl mx-auto">
        <div className="flex items-start gap-4 mb-6">
          <button onClick={() => navigate('/employees')} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
            <ArrowLeft size={18} />
          </button>
          <div className="w-14 h-14 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center font-semibold text-lg flex-shrink-0">
            {initials || '—'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-900">
                {(form.first_name || form.last_name) ? `${form.first_name || ''} ${form.last_name || ''}`.trim() : <span className="text-slate-400 italic font-normal">Sans nom</span>}
              </h1>
              {!form.active && <Badge color="red">Inactif</Badge>}
              {!!form.is_salesperson && <Badge color="indigo">Vendeur</Badge>}
              {!!form.is_consultant && <Badge color="purple">Consultant</Badge>}
            </div>
            <div className="text-sm text-slate-500 mt-1 flex gap-3 flex-wrap">
              {form.matricule && <span className="font-mono bg-slate-100 px-2 py-0.5 rounded">{form.matricule}</span>}
              {form.accounting_department && <span>{form.accounting_department}</span>}
              {form.email_work && <a href={`mailto:${form.email_work}`} className="text-indigo-600 hover:underline">{form.email_work}</a>}
            </div>
          </div>
          <div className="flex items-center gap-3 pt-1">
            <span className={`text-xs transition-opacity ${saving ? 'opacity-100 text-slate-400' : 'opacity-0'}`}>Sauvegarde…</span>
          </div>
        </div>

        <div className="space-y-6">
          <VacationsSection employeeId={id} />

          {SECTIONS.map(section => (
            <div key={section.title} className="card p-5">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-4">{section.title}</div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                {section.fields.map(field => {
                  const val = form[field.key]
                  const span = field.span2 ? 'col-span-2' : ''
                  if (field.type === 'checkbox') {
                    return (
                      <div key={field.key} className={span}>
                        <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-slate-700">
                          <input type="checkbox" className="rounded" checked={!!val}
                            onChange={e => change(field.key, e.target.checked ? 1 : 0)} />
                          {field.label}
                        </label>
                      </div>
                    )
                  }
                  if (field.type === 'textarea') {
                    return (
                      <div key={field.key} className={span}>
                        <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">{field.label}</label>
                        <textarea className={inp} rows={2}
                          value={val ?? ''} onChange={e => change(field.key, e.target.value)} />
                      </div>
                    )
                  }
                  if (field.type === 'select') {
                    return (
                      <div key={field.key} className={span}>
                        <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">{field.label}</label>
                        <select className={inp} value={val || ''} onChange={e => change(field.key, e.target.value)}>
                          <option value="">—</option>
                          {field.options.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      </div>
                    )
                  }
                  if (field.type === 'number') {
                    return (
                      <div key={field.key} className={span}>
                        <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">{field.label}</label>
                        <input type="number" step={field.step || '1'} className={inp}
                          value={val ?? ''} onChange={e => change(field.key, e.target.value === '' ? null : parseFloat(e.target.value))} />
                      </div>
                    )
                  }
                  return (
                    <div key={field.key} className={span}>
                      <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">{field.label}</label>
                      <input type={field.type} className={inp}
                        value={val ?? ''} onChange={e => change(field.key, e.target.value)} />
                    </div>
                  )
                })}
              </div>
            </div>
          ))}

          <div className="flex justify-end pt-2">
            <button onClick={handleDelete}
              className="text-sm text-slate-400 hover:text-red-600 flex items-center gap-1.5">
              <Trash2 size={14} /> Supprimer cet employé
            </button>
          </div>
        </div>
      </div>
    </Layout>
  )
}

function VacationsSection({ employeeId }) {
  const { addToast } = useToast()
  const confirm = useConfirm()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [savingIds, setSavingIds] = useState(() => new Set())
  const timers = useRef({})
  const pending = useRef({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.vacations.list({ employee_id: employeeId })
      setRows(res.data || [])
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [employeeId, addToast])

  useEffect(() => { load() }, [load])
  useEffect(() => () => { for (const t of Object.values(timers.current)) clearTimeout(t) }, [])

  function markSaving(id, on) {
    setSavingIds(prev => {
      const next = new Set(prev)
      if (on) next.add(id); else next.delete(id)
      return next
    })
  }

  async function flush(id) {
    const patch = pending.current[id]
    if (!patch || !Object.keys(patch).length) return
    pending.current[id] = {}
    markSaving(id, true)
    try {
      const updated = await api.vacations.update(id, patch)
      setRows(rs => rs.map(r => r.id === id ? updated : r))
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      markSaving(id, false)
    }
  }

  function change(id, key, val) {
    setRows(rs => rs.map(r => r.id === id ? { ...r, [key]: val } : r))
    pending.current[id] = { ...(pending.current[id] || {}), [key]: val }
    clearTimeout(timers.current[id])
    timers.current[id] = setTimeout(() => flush(id), 400)
  }

  async function addVacation() {
    try {
      const today = new Date().toISOString().slice(0, 10)
      const created = await api.vacations.create({
        employee_id: employeeId,
        start_date: today,
        end_date: today,
        paid: 1,
      })
      setRows(rs => [created, ...rs])
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    }
  }

  async function removeVacation(row) {
    const label = row.start_date ? `du ${row.start_date}${row.end_date ? ` au ${row.end_date}` : ''}` : 'cette période'
    if (!(await confirm(`Supprimer les vacances ${label} ?`))) return
    try {
      await api.vacations.delete(row.id)
      setRows(rs => rs.filter(r => r.id !== row.id))
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    }
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Vacances</div>
        <button
          onClick={addVacation}
          className="text-xs text-indigo-600 hover:text-indigo-700 flex items-center gap-1 font-medium"
          data-testid="add-vacation"
        >
          <Plus size={14} /> Ajouter
        </button>
      </div>

      {loading ? (
        <div className="text-sm text-slate-400">Chargement…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-slate-400 italic">Aucune vacance enregistrée.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="vacations-table">
            <thead>
              <tr className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                <th className="text-left pb-2 pr-3 font-medium">Du</th>
                <th className="text-left pb-2 pr-3 font-medium">Au</th>
                <th className="text-left pb-2 pr-3 font-medium">Type</th>
                <th className="text-left pb-2 pr-3 font-medium">Notes</th>
                <th className="pb-2 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} data-vacation-id={row.id} className="border-t border-slate-100">
                  <td className="py-2 pr-3">
                    <input
                      type="date"
                      className={inp}
                      value={row.start_date || ''}
                      onChange={e => change(row.id, 'start_date', e.target.value)}
                      data-testid="vacation-start"
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <input
                      type="date"
                      className={inp}
                      value={row.end_date || ''}
                      onChange={e => change(row.id, 'end_date', e.target.value)}
                      data-testid="vacation-end"
                    />
                  </td>
                  <td className="py-2 pr-3 min-w-[9rem]">
                    <select
                      className={inp}
                      value={row.paid ? '1' : '0'}
                      onChange={e => change(row.id, 'paid', e.target.value === '1' ? 1 : 0)}
                      data-testid="vacation-paid"
                    >
                      <option value="1">Congé payé</option>
                      <option value="0">Sans solde</option>
                    </select>
                  </td>
                  <td className="py-2 pr-3">
                    <input
                      type="text"
                      className={inp}
                      value={row.notes || ''}
                      onChange={e => change(row.id, 'notes', e.target.value)}
                      placeholder="—"
                      data-testid="vacation-notes"
                    />
                  </td>
                  <td className="py-2 text-right">
                    <div className="flex items-center gap-2 justify-end">
                      <span className={`text-xs transition-opacity ${savingIds.has(row.id) ? 'opacity-100 text-slate-400' : 'opacity-0'}`}>…</span>
                      <button
                        onClick={() => removeVacation(row)}
                        className="p-1 text-slate-400 hover:text-red-600"
                        title="Supprimer"
                        data-testid="vacation-delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
