import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Phone, Mail, MessageSquare, Edit2, Building2, PhoneCall, PhoneIncoming, PhoneOutgoing } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'

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

function ContactForm({ initial = {}, companies = [], customFields = [], onSave, onClose }) {
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', phone: '', mobile: '',
    company_id: '', language: '', notes: '',
    ...initial,
    extra_fields: { ...(initial.extra_fields || {}) }
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
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

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Prénom *</label>
          <input value={form.first_name} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))} className="input" required />
        </div>
        <div>
          <label className="label">Nom *</label>
          <input value={form.last_name} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))} className="input" required />
        </div>
        <div>
          <label className="label">Courriel</label>
          <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Téléphone</label>
          <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Mobile</label>
          <input value={form.mobile} onChange={e => setForm(f => ({ ...f, mobile: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Langue</label>
          <select value={form.language} onChange={e => setForm(f => ({ ...f, language: e.target.value }))} className="select">
            <option value="">—</option>
            <option value="French">Français</option>
            <option value="English">Anglais</option>
          </select>
        </div>
        <div className="col-span-2">
          <label className="label">Entreprise</label>
          <select value={form.company_id} onChange={e => setForm(f => ({ ...f, company_id: e.target.value }))} className="select">
            <option value="">— Aucune entreprise —</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        {customFields.map(cf => (
          <div key={cf.key} className="col-span-2">
            <label className="label">{cf.label}</label>
            <input type={fieldTypeInput(cf.field_type)}
              value={form.extra_fields?.[cf.key] || ''}
              onChange={e => setForm(f => ({ ...f, extra_fields: { ...f.extra_fields, [cf.key]: e.target.value } }))}
              className="input" />
          </div>
        ))}
      </div>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">
          {saving ? 'Enregistrement...' : 'Enregistrer'}
        </button>
      </div>
    </form>
  )
}

function InteractionItem({ item }) {
  const [expanded, setExpanded] = useState(false)
  const Icon = TYPE_ICONS[item.type] || MessageSquare
  const hasBody = item.transcript_formatted || item.body_text || item.meeting_notes

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
            <div className="mt-2 p-3 bg-slate-50 rounded text-xs text-slate-600 whitespace-pre-wrap max-h-64 overflow-y-auto">
              {item.transcript_formatted || item.body_text || item.meeting_notes}
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
  const [contact, setContact] = useState(null)
  const [interactions, setInteractions] = useState([])
  const [companies, setCompanies] = useState([])
  const [customFields, setCustomFields] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [editing, setEditing] = useState(false)
  const LIMIT = 30

  async function load() {
    setLoading(true)
    try {
      const [c, inter, comps] = await Promise.all([
        api.contacts.get(id),
        api.interactions.list({ contact_id: id, limit: LIMIT, offset: 0 }),
        api.companies.list({ limit: 200 }),
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

  useEffect(() => {
    api.fieldDefs.list('contacts').then(setCustomFields).catch(() => {})
  }, [])

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

  useEffect(() => { load() }, [id])

  async function handleUpdate(form) {
    await api.contacts.update(id, form)
    setEditing(false)
    load()
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
          <button onClick={() => setEditing(true)} className="btn-secondary btn-sm">
            <Edit2 size={14} /> Modifier
          </button>
        </div>

        {/* Info card */}
        <div className="card p-5 mb-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            {contact.email && (
              <div className="flex items-center gap-2 text-slate-600">
                <Mail size={14} className="text-slate-400 flex-shrink-0" />
                <a href={`mailto:${contact.email}`} className="text-indigo-600 hover:underline truncate">{contact.email}</a>
              </div>
            )}
            {contact.phone && (
              <div className="flex items-center gap-2 text-slate-600">
                <Phone size={14} className="text-slate-400 flex-shrink-0" />
                <a href={`tel:${contact.phone}`} className="hover:underline">{contact.phone}</a>
              </div>
            )}
            {contact.mobile && (
              <div className="flex items-center gap-2 text-slate-600">
                <Phone size={14} className="text-slate-400 flex-shrink-0" />
                <a href={`tel:${contact.mobile}`} className="hover:underline">{contact.mobile}
                  <span className="text-slate-400 text-xs ml-1">(mobile)</span>
                </a>
              </div>
            )}
          </div>
          {customFields.filter(cf => contact.extra_fields?.[cf.key]).length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3 pt-3 border-t border-slate-100 text-sm">
              {customFields.filter(cf => contact.extra_fields?.[cf.key]).map(cf => (
                <div key={cf.key} className="text-slate-600">
                  <span className="text-xs font-medium text-slate-400 uppercase tracking-wide block">{cf.label}</span>
                  {contact.extra_fields[cf.key]}
                </div>
              ))}
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

      <Modal isOpen={editing} onClose={() => setEditing(false)} title="Modifier le contact">
        <ContactForm initial={contact} companies={companies} customFields={customFields} onSave={handleUpdate} onClose={() => setEditing(false)} />
      </Modal>
    </Layout>
  )
}
