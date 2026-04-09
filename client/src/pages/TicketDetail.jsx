import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Save, X, Trash2, ChevronDown } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge, ticketStatusColor } from '../components/Badge.jsx'

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function fmtDuration(mins) {
  if (!mins) return '—'
  const h = Math.floor(mins / 60), m = mins % 60
  return h === 0 ? `${m}m` : `${h}h${m > 0 ? m + 'm' : ''}`
}

function SearchSelect({ value, options, labelFn, placeholder, saving, onSave }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef(null)
  const selected = options.find(o => o.id === value)
  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return q ? options.filter(o => labelFn(o).toLowerCase().includes(q)).slice(0, 60) : options.slice(0, 60)
  }, [options, search, labelFn])

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
          {selected ? labelFn(selected) : placeholder || '—'}
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
              {placeholder || '—'}
            </button>
            {filtered.map(o => (
              <button key={o.id} type="button" onClick={() => { onSave(o.id); setOpen(false) }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-indigo-50 hover:text-indigo-700 ${o.id === value ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-slate-900'}`}>
                {labelFn(o)}
              </button>
            ))}
            {filtered.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">Aucun resultat</div>}
          </div>
        </div>
      )}
    </div>
  )
}

export default function TicketDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [ticket, setTicket] = useState(null)
  const [companies, setCompanies] = useState([])
  const [contacts, setContacts] = useState([])
  const [users, setUsers] = useState([])
  const [meta, setMeta] = useState({ types: [], statuses: [] })
  const [loading, setLoading] = useState(true)
  const [fieldSaving, setFieldSaving] = useState({})

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const [t, comps, conts, m] = await Promise.all([
          api.tickets.get(id),
          api.companies.list({ limit: 'all' }),
          api.contacts.list({ limit: 'all' }),
          api.tickets.meta(),
        ])
        setTicket(t)
        setCompanies(comps.data || [])
        setContacts(conts.data || [])
        setMeta(m)
        api.admin.listUsers().then(setUsers).catch(() => {})
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id])

  async function saveField(key, value) {
    setFieldSaving(s => ({ ...s, [key]: true }))
    try {
      const updated = await api.tickets.update(id, { ...ticket, [key]: value || null })
      setTicket(updated)
    } catch (err) {
      alert(err.message)
    } finally {
      setFieldSaving(s => ({ ...s, [key]: false }))
    }
  }

  async function handleDelete() {
    if (!confirm('Supprimer ce billet ?')) return
    await api.tickets.delete(id)
    navigate('/tickets')
  }

  const filteredContacts = ticket?.company_id
    ? contacts.filter(c => c.company_id === ticket.company_id)
    : contacts

  if (loading) {
    return <Layout><div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600" /></div></Layout>
  }
  if (!ticket) {
    return <Layout><div className="p-6 text-slate-500">Billet introuvable.</div></Layout>
  }

  return (
    <Layout>
      <div className="p-6 max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <button onClick={() => navigate('/tickets')} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-slate-900">{ticket.title}</h1>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <Badge color={ticketStatusColor(ticket.status)}>{ticket.status}</Badge>
              {ticket.type && <Badge color="gray">{ticket.type}</Badge>}
              {ticket.company_name && (
                <Link to={`/companies/${ticket.company_id}`} className="text-sm text-indigo-600 hover:underline">
                  {ticket.company_name}
                </Link>
              )}
            </div>
          </div>
          <button onClick={handleDelete} className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg" title="Supprimer">
            <Trash2 size={16} />
          </button>
        </div>

        {/* Info card */}
        <div className="card p-5 mb-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
            <div className="sm:col-span-2">
              <FieldLabel label="Titre" saving={fieldSaving.title} />
              <InlineText value={ticket.title} saving={!!fieldSaving.title} onSave={v => saveField('title', v)} />
            </div>
            <div>
              <FieldLabel label="Statut" saving={fieldSaving.status} />
              <select value={ticket.status || ''} onChange={e => saveField('status', e.target.value)} className="select text-sm w-full" disabled={!!fieldSaving.status}>
                <option value="">—</option>
                {meta.statuses.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <FieldLabel label="Type" saving={fieldSaving.type} />
              <select value={ticket.type || ''} onChange={e => saveField('type', e.target.value)} className="select text-sm w-full" disabled={!!fieldSaving.type}>
                <option value="">—</option>
                {meta.types.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <FieldLabel label="Entreprise" saving={fieldSaving.company_id} />
              <SearchSelect
                value={ticket.company_id}
                options={companies}
                labelFn={c => c.name}
                placeholder="— Aucune entreprise —"
                saving={!!fieldSaving.company_id}
                onSave={v => saveField('company_id', v)}
              />
            </div>
            <div>
              <FieldLabel label="Contact" saving={fieldSaving.contact_id} />
              <SearchSelect
                value={ticket.contact_id}
                options={filteredContacts}
                labelFn={c => `${c.first_name} ${c.last_name}`}
                placeholder="— Aucun contact —"
                saving={!!fieldSaving.contact_id}
                onSave={v => saveField('contact_id', v)}
              />
            </div>
            <div>
              <FieldLabel label="Assigne a" saving={fieldSaving.assigned_to} />
              <select value={ticket.assigned_to || ''} onChange={e => saveField('assigned_to', e.target.value)} className="select text-sm w-full" disabled={!!fieldSaving.assigned_to}>
                <option value="">—</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div>
              <FieldLabel label="Duree" saving={fieldSaving.duration_minutes} />
              <div className="flex items-center gap-2">
                <input type="number" min="0" value={ticket.duration_minutes || 0}
                  onChange={e => saveField('duration_minutes', parseInt(e.target.value) || 0)}
                  className="input text-sm w-24" disabled={!!fieldSaving.duration_minutes} />
                <span className="text-xs text-slate-400">{fmtDuration(ticket.duration_minutes)}</span>
              </div>
            </div>
            <div className="sm:col-span-2">
              <FieldLabel label="Description" saving={fieldSaving.description} />
              <InlineTextarea value={ticket.description} saving={!!fieldSaving.description} onSave={v => saveField('description', v)} />
            </div>
          </div>
        </div>

        {/* Meta */}
        <div className="text-xs text-slate-400 flex gap-4">
          <span>Cree: {fmtDate(ticket.created_at)}</span>
          {ticket.updated_at && <span>Modifie: {fmtDate(ticket.updated_at)}</span>}
        </div>
      </div>
    </Layout>
  )
}

function FieldLabel({ label, saving }) {
  return (
    <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1 flex items-center gap-1">
      {label}
      {saving && <span className="inline-block w-3 h-3 border border-indigo-400 border-t-transparent rounded-full animate-spin" />}
    </div>
  )
}

function InlineText({ value, saving, onSave }) {
  const [local, setLocal] = useState(value || '')
  useEffect(() => { setLocal(value || '') }, [value])
  return (
    <input type="text" value={local} onChange={e => setLocal(e.target.value)}
      onBlur={e => { if (e.target.value !== (value || '')) onSave(e.target.value) }}
      className="input text-sm w-full" disabled={saving} />
  )
}

function InlineTextarea({ value, saving, onSave }) {
  const [local, setLocal] = useState(value || '')
  const ref = useRef(null)
  useEffect(() => { setLocal(value || '') }, [value])
  useEffect(() => { autoResize() }, [local])

  function autoResize() {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }

  return (
    <textarea ref={ref} value={local} onChange={e => setLocal(e.target.value)}
      onBlur={e => { if (e.target.value !== (value || '')) onSave(e.target.value) }}
      className="input text-sm w-full resize-none overflow-hidden" rows={1} disabled={saving} />
  )
}
