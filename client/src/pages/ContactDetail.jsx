import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Mail, MessageSquare, Edit2, Building2, PhoneCall, PhoneIncoming, PhoneOutgoing, Plus, Save, X, Zap, Eye, ChevronDown } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { useAuth } from '../lib/auth.jsx'

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function fmtDuration(s) {
  if (!s) return null
  const m = Math.floor(s / 60), sec = s % 60
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`
}

const TYPE_LABELS = { call: 'Appel', email: 'Courriel', sms: 'SMS', meeting: 'Réunion', note: 'Note' }
const TYPE_COLORS = {
  call: 'bg-blue-100 text-blue-700',
  email: 'bg-purple-100 text-purple-700',
  sms: 'bg-green-100 text-green-700',
  meeting: 'bg-amber-100 text-amber-700',
  note: 'bg-slate-100 text-slate-600',
}
const TYPE_ICONS = {
  call: PhoneCall,
  email: Mail,
  sms: MessageSquare,
  meeting: Building2,
  note: Edit2,
}

function fieldTypeInput(type) {
  if (type === 'number') return 'number'
  if (type === 'date') return 'date'
  if (type === 'url') return 'url'
  if (type === 'email') return 'email'
  return 'text'
}

function fmtPhone(val) {
  if (!val) return ''
  const digits = String(val).replace(/\D/g, '')
  const d = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
  return val
}

const CONTACT_FIELDS = [
  { key: 'first_name', label: 'Prénom',      type: 'text', required: true },
  { key: 'last_name',  label: 'Nom',         type: 'text', required: true },
  { key: 'email',      label: 'Courriel',    type: 'email' },
  { key: 'phone',      label: 'Téléphone',   type: 'phone' },
  { key: 'mobile',     label: 'Mobile',      type: 'phone' },
  { key: 'language',   label: 'Langue',      type: 'select', options: ['French', 'English'] },
  { key: 'company_id', label: 'Entreprise',  type: 'company', span2: true },
  { key: 'notes',      label: 'Notes',       type: 'textarea', span2: true, defaultVisible: false },
]

function CompanySelect({ value, companies, saving, onSave }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef(null)
  const selected = companies.find(c => c.id === value)
  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return q ? companies.filter(c => c.name.toLowerCase().includes(q)).slice(0, 60) : companies.slice(0, 60)
  }, [companies, search])

  useEffect(() => { if (!open) setSearch('') }, [open])
  useEffect(() => {
    function handle(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => !saving && setOpen(o => !o)} disabled={saving}
        className="input text-sm text-left w-full flex items-center justify-between gap-2">
        <span className={selected ? 'text-slate-900 truncate' : 'text-slate-400'}>
          {selected ? selected.name : '— Aucune entreprise —'}
        </span>
        <ChevronDown size={14} className="text-slate-400 flex-shrink-0" />
      </button>
      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden">
          <div className="p-2 border-b border-slate-100">
            <input autoFocus type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Rechercher..." className="input text-sm py-1 w-full" />
          </div>
          <div className="max-h-52 overflow-y-auto">
            <button type="button" onClick={() => { onSave(''); setOpen(false) }}
              className="w-full text-left px-3 py-2 text-sm text-slate-400 hover:bg-slate-50">
              — Aucune entreprise —
            </button>
            {filtered.map(c => (
              <button key={c.id} type="button" onClick={() => { onSave(c.id); setOpen(false) }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-indigo-50 hover:text-indigo-700 ${c.id === value ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-slate-900'}`}>
                {c.name}
              </button>
            ))}
            {filtered.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">Aucun résultat</div>}
            {!search && companies.length > 60 && (
              <div className="px-3 py-2 text-xs text-slate-400 border-t border-slate-100">
                {companies.length - 60} autres — affinez la recherche
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function InlineField({ field, value, saving, onSave, companies = [] }) {
  const [local, setLocal] = useState(String(value ?? ''))
  useEffect(() => { setLocal(String(value ?? '')) }, [value])
  function commit(val) { if (val === String(value ?? '')) return; onSave(val) }

  if (field.type === 'select') {
    return (
      <select value={local} onChange={e => { setLocal(e.target.value); commit(e.target.value) }} className="input text-sm" disabled={saving}>
        <option value="">—</option>
        {(field.options || []).map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }
  if (field.type === 'company') {
    return <CompanySelect value={value} companies={companies} saving={saving} onSave={onSave} />
  }
  if (field.type === 'textarea') {
    return (
      <textarea value={local} onChange={e => setLocal(e.target.value)} onBlur={e => commit(e.target.value)} className="input text-sm" rows={3} disabled={saving} />
    )
  }
  if (field.type === 'phone') {
    return (
      <input type="tel" value={local} onChange={e => setLocal(e.target.value)}
        onBlur={e => { const f = fmtPhone(e.target.value); setLocal(f); commit(f) }}
        className="input text-sm" disabled={saving} />
    )
  }
  return (
    <input type={fieldTypeInput(field.type)} value={local} onChange={e => setLocal(e.target.value)} onBlur={e => commit(e.target.value)} className="input text-sm" disabled={saving} />
  )
}

function InteractionItem({ item }) {
  const [expanded, setExpanded] = useState(false)
  const Icon = TYPE_ICONS[item.type] || MessageSquare
  const hasBody = item.transcript_formatted || item.body_text || item.body_html || item.meeting_notes

  return (
    <div className="card p-4">
      <div className="flex items-start gap-3">
        <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${TYPE_COLORS[item.type] || 'bg-slate-100'}`}>
          <Icon size={14} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-slate-800">{TYPE_LABELS[item.type] || item.type}</span>
              {item.direction === 'in'
                ? <PhoneIncoming size={12} className="text-slate-400" />
                : item.direction === 'out'
                ? <PhoneOutgoing size={12} className="text-slate-400" />
                : null}
              {item.subject && <span className="text-sm text-slate-600 truncate">{item.subject}</span>}
              {item.type === 'email' && item.from_address && <span className="text-xs text-slate-400 font-mono truncate">De: {item.from_address}</span>}
              {item.type === 'email' && item.to_address && <span className="text-xs text-slate-400 font-mono truncate">À: {item.to_address}</span>}
              {item.automated === 1 && <span title="Courriel automatisé" className="inline-flex items-center gap-0.5 text-xs text-indigo-600 bg-indigo-50 border border-indigo-100 px-1.5 py-0.5 rounded"><Zap size={10} /> Auto</span>}
              {item.automated === 1 && item.open_count > 0 && <span title={`Ouvert ${item.open_count} fois`} className="inline-flex items-center gap-0.5 text-xs text-green-700 bg-green-50 border border-green-100 px-1.5 py-0.5 rounded"><Eye size={10} /> {item.open_count}</span>}
              {item.automated === 1 && item.open_count === 0 && <span title="Non ouvert" className="inline-flex items-center gap-0.5 text-xs text-slate-400 bg-slate-50 border border-slate-100 px-1.5 py-0.5 rounded"><Eye size={10} /> 0</span>}
              {item.meeting_title && item.meeting_title !== 'Note' && <span className="text-sm text-slate-600">{item.meeting_title}</span>}
              {item.duration_seconds && <span className="text-xs text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">{fmtDuration(item.duration_seconds)}</span>}
              {item.callee_number && <span className="text-xs text-slate-400 font-mono">{item.callee_number}</span>}
              {item.transcription_status === 'pending' && <Badge color="yellow" size="sm">Transcription...</Badge>}
              {item.drive_filename && <span className="text-xs text-slate-400 truncate max-w-xs">{item.drive_filename}</span>}
            </div>
            <span className="text-xs text-slate-400 flex-shrink-0">{fmtDate(item.timestamp)}</span>
          </div>

          {item.call_id && (item.recording_path || item.drive_file_id) && (
            <audio controls className="mt-2 w-full h-8"
              src={`/erp/api/calls/${item.call_id}/recording?token=${localStorage.getItem('erp_token')}`} />
          )}
          {hasBody && (
            <button
              onClick={() => setExpanded(e => !e)}
              className="mt-2 text-xs text-indigo-600 hover:underline"
            >
              {expanded ? 'Masquer' : 'Voir le contenu'}
            </button>
          )}
          {expanded && (
            <div className="mt-2 rounded overflow-hidden border border-slate-200">
              {item.body_html
                ? <iframe srcDoc={item.body_html} sandbox="allow-same-origin" scrolling="no" className="w-full border-0" style={{ minHeight: '200px' }} onLoad={e => { e.target.style.height = e.target.contentDocument.body.scrollHeight + 'px' }} />
                : <div className="p-3 bg-slate-50 text-xs text-slate-600 whitespace-pre-wrap">{item.transcript_formatted || item.body_text || item.meeting_notes}</div>
              }
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function ContactDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [contact, setContact] = useState(null)
  const [interactions, setInteractions] = useState([])
  const [companies, setCompanies] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [fieldSaving, setFieldSaving] = useState({})
  const [tasks, setTasks] = useState([])
  const [users, setUsers] = useState([])
  const [showTaskModal, setShowTaskModal] = useState(false)
  const [editingTask, setEditingTask] = useState(null)
  const [taskForm, setTaskForm] = useState({ title: '', status: 'À faire', priority: 'Normal', due_date: '', assigned_to: '', notes: '' })
  const [savingTask, setSavingTask] = useState(false)
  const LIMIT = 30

  async function load() {
    setLoading(true)
    try {
      const [c, inter, comps] = await Promise.all([
        api.contacts.get(id),
        api.interactions.list({ contact_id: id, limit: LIMIT, offset: 0 }),
        api.companies.list({ limit: 'all' }),
      ])
      setContact(c)
      setInteractions(inter.interactions || [])
      setTotal(inter.total || 0)
      setOffset(LIMIT)
      setCompanies(comps.data || [])
    } finally {
      setLoading(false)
    }
  }

  const visibleFields = useMemo(() => CONTACT_FIELDS.filter(f => f.defaultVisible !== false), [])

  async function loadMore() {
    setLoadingMore(true)
    try {
      const res = await api.interactions.list({ contact_id: id, limit: LIMIT, offset })
      setInteractions(prev => [...prev, ...(res.interactions || [])])
      setOffset(o => o + LIMIT)
    } finally {
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    load()
    api.tasks.list({ contact_id: id, limit: 'all' }).then(r => setTasks(r.data || [])).catch(() => {})
    api.auth.users().then(setUsers).catch(() => {})
  }, [id])

  async function saveField(key, value) {
    setFieldSaving(s => ({ ...s, [key]: true }))
    try {
      await api.contacts.update(id, { [key]: value || null })
      setContact(c => ({ ...c, [key]: value || null }))
      if (key === 'company_id') load()
    } catch (err) {
      alert(err.message)
    } finally {
      setFieldSaving(s => ({ ...s, [key]: false }))
    }
  }

  if (loading) {
    return <Layout><div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600" /></div></Layout>
  }
  if (!contact) {
    return <Layout><div className="p-6 text-slate-500">Contact introuvable.</div></Layout>
  }

  return (
    <Layout>
      <div className="p-6 max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <button onClick={() => navigate('/contacts')} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-900">{contact.first_name} {contact.last_name}</h1>
              {contact.language && (
                <Badge color={contact.language === 'French' ? 'blue' : 'green'}>
                  {contact.language === 'French' ? 'FR' : 'EN'}
                </Badge>
              )}
            </div>
            {contact.company_id && (
              <Link to={`/companies/${contact.company_id}`} className="text-sm text-indigo-600 hover:underline mt-0.5 block">
                {contact.company_name}
              </Link>
            )}
          </div>
          <div className="flex items-center gap-2">
          </div>
        </div>

        {/* Info card */}
        <div className="card p-5 mb-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
            {visibleFields.map(field => {
              const value = contact[field.key] ?? ''
              const span2 = field.span2 || field.type === 'textarea' || field.type === 'company'
              return (
                <div key={field.key} className={span2 ? 'sm:col-span-2' : ''}>
                  <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1 flex items-center gap-1">
                    {field.label}
                    {fieldSaving[field.key] && <span className="inline-block w-3 h-3 border border-indigo-400 border-t-transparent rounded-full animate-spin" />}
                  </div>
                  <InlineField
                    field={field}
                    value={value}
                    saving={!!fieldSaving[field.key]}
                    companies={companies}
                    onSave={val => saveField(field.key, val)}
                  />
                </div>
              )
            })}
          </div>
        </div>

        {/* Tasks section */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-slate-900">Tâches ({tasks.length})</h2>
            <button onClick={() => { setEditingTask(null); setTaskForm({ title: '', status: 'À faire', priority: 'Normal', due_date: '', assigned_to: '', notes: '' }); setShowTaskModal(true) }} className="btn-secondary btn-sm">
              <Plus size={14} /> Ajouter
            </button>
          </div>
          {tasks.length === 0 ? (
            <div className="card p-6 text-center text-slate-400 text-sm">Aucune tâche</div>
          ) : (
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-200 bg-slate-50">
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500">Tâche</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500">Statut</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 hidden sm:table-cell">Échéance</th>
                </tr></thead>
                <tbody>
                  {tasks.map(t => {
                    const overdue = t.due_date && t.status !== 'Terminé' && new Date(t.due_date) < new Date()
                    return (
                      <tr key={t.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 cursor-pointer" onClick={() => { setEditingTask(t); setTaskForm({ title: t.title, status: t.status, priority: t.priority, due_date: t.due_date || '', assigned_to: t.assigned_to || '', notes: t.notes || '' }); setShowTaskModal(true) }}>
                        <td className="px-4 py-2.5 font-medium text-slate-900">{t.title}</td>
                        <td className="px-4 py-2.5">
                          <span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full ${t.status === 'Terminé' ? 'bg-green-100 text-green-700' : t.status === 'En cours' ? 'bg-blue-100 text-blue-700' : t.status === 'Annulé' ? 'bg-slate-100 text-slate-500' : 'bg-amber-100 text-amber-700'}`}>{t.status}</span>
                        </td>
                        <td className="px-4 py-2.5 hidden sm:table-cell">
                          {t.due_date ? <span className={overdue ? 'text-red-600 font-medium' : 'text-slate-500'}>{fmtDate(t.due_date)}</span> : <span className="text-slate-400">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Conversation history */}
        <div>
          <h2 className="text-base font-semibold text-slate-900 mb-3">
            Historique ({total})
          </h2>
          {interactions.length === 0 ? (
            <div className="card p-10 text-center text-slate-400">Aucune interaction</div>
          ) : (
            <div className="space-y-2">
              {interactions.map(item => <InteractionItem key={item.id} item={item} />)}
              {interactions.length < total && (
                <button onClick={loadMore} disabled={loadingMore} className="btn-secondary w-full">
                  {loadingMore ? 'Chargement...' : `Charger plus (${total - interactions.length} restants)`}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {showTaskModal && (
        <Modal title={editingTask ? 'Modifier la tâche' : 'Nouvelle tâche'} onClose={() => setShowTaskModal(false)}>
          <form onSubmit={async e => {
            e.preventDefault()
            setSavingTask(true)
            try {
              if (editingTask) {
                await api.tasks.update(editingTask.id, { ...taskForm, contact_id: id })
              } else {
                await api.tasks.create({ ...taskForm, contact_id: id })
              }
              const r = await api.tasks.list({ contact_id: id, limit: 'all' })
              setTasks(r.data || [])
              setShowTaskModal(false)
            } catch(err) {
              alert(err.message)
            } finally {
              setSavingTask(false)
            }
          }} className="space-y-4">
            <div>
              <label className="label">Titre *</label>
              <input value={taskForm.title} onChange={e => setTaskForm(f => ({ ...f, title: e.target.value }))} className="input" required autoFocus />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Statut</label>
                <select value={taskForm.status} onChange={e => setTaskForm(f => ({ ...f, status: e.target.value }))} className="select">
                  {['À faire','En cours','Terminé','Annulé'].map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Priorité</label>
                <select value={taskForm.priority} onChange={e => setTaskForm(f => ({ ...f, priority: e.target.value }))} className="select">
                  {['Basse','Normal','Haute','Urgente'].map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="label">Échéance</label>
              <input type="date" value={taskForm.due_date || ''} onChange={e => setTaskForm(f => ({ ...f, due_date: e.target.value }))} className="input" />
            </div>
            <div>
              <label className="label">Responsable</label>
              <select value={taskForm.assigned_to || ''} onChange={e => setTaskForm(f => ({ ...f, assigned_to: e.target.value }))} className="select">
                <option value="">—</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Notes</label>
              <textarea value={taskForm.notes || ''} onChange={e => setTaskForm(f => ({ ...f, notes: e.target.value }))} className="input" rows={2} />
            </div>
            <div className="flex items-center justify-between pt-2">
              {editingTask && (
                <button type="button" onClick={async () => {
                  if (!confirm('Supprimer cette tâche ?')) return
                  await api.tasks.delete(editingTask.id)
                  const r = await api.tasks.list({ contact_id: id, limit: 'all' })
                  setTasks(r.data || [])
                  setShowTaskModal(false)
                }} className="text-sm text-red-500 hover:text-red-700 hover:underline">Supprimer</button>
              )}
              <div className="flex gap-3 ml-auto">
                <button type="button" onClick={() => setShowTaskModal(false)} className="btn-secondary"><X size={14} /> Annuler</button>
                <button type="submit" disabled={savingTask} className="btn-primary"><Save size={14} /> {savingTask ? 'Enregistrement...' : 'Enregistrer'}</button>
              </div>
            </div>
          </form>
        </Modal>
      )}
    </Layout>
  )
}
