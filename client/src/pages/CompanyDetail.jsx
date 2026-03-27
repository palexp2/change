import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Edit2, Plus, Save, X, Trash2, ChevronDown, ChevronUp, Phone, Mail, MessageSquare, Building2, PhoneCall, PhoneIncoming, PhoneOutgoing, Eye } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge, phaseBadgeColor, orderStatusColor, ticketStatusColor, projectStatusColor } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'

const TYPE_LABELS = { call: 'Appel', email: 'Courriel', sms: 'SMS', meeting: 'Réunion', note: 'Note' }
const TYPE_COLORS = { call: 'bg-blue-100 text-blue-700', email: 'bg-purple-100 text-purple-700', sms: 'bg-green-100 text-green-700', meeting: 'bg-amber-100 text-amber-700', note: 'bg-slate-100 text-slate-600' }
const TYPE_ICONS = { call: PhoneCall, email: Mail, sms: MessageSquare, meeting: Building2, note: Edit2 }

function fmtDuration(s) {
  if (!s) return null
  const m = Math.floor(s / 60), sec = s % 60
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`
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
              {item.direction === 'in' ? <PhoneIncoming size={12} className="text-slate-400" /> : item.direction === 'out' ? <PhoneOutgoing size={12} className="text-slate-400" /> : null}
              {item.contact_name?.trim() && (
                <Link to={`/contacts/${item.contact_id}`} onClick={e => e.stopPropagation()} className="text-sm text-indigo-600 hover:underline">
                  {item.contact_name.trim()}
                </Link>
              )}
              {item.subject && <span className="text-sm text-slate-600 truncate">{item.subject}</span>}
              {item.meeting_title && item.meeting_title !== 'Note' && <span className="text-sm text-slate-600">{item.meeting_title}</span>}
              {item.duration_seconds && <span className="text-xs text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">{fmtDuration(item.duration_seconds)}</span>}
              {item.callee_number && <span className="text-xs text-slate-400 font-mono">{item.callee_number}</span>}
              {item.transcription_status === 'pending' && <span className="text-xs bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded">Transcription...</span>}
            </div>
            <span className="text-xs text-slate-400 flex-shrink-0">
              {new Date(item.timestamp).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          {item.call_id && (item.recording_path || item.drive_file_id) && (
            <audio controls className="mt-2 w-full h-8"
              src={`/erp/api/calls/${item.call_id}/recording?token=${localStorage.getItem('erp_token')}`} />
          )}
          {hasBody && (
            <button onClick={() => setExpanded(e => !e)} className="mt-2 text-xs text-indigo-600 hover:underline">
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

const PHASES = ['Contact', 'Qualified', 'Problem aware', 'Solution aware', 'Lead', 'Quote Sent', 'Customer', 'Not a Client Anymore']
const TYPES = ['ASC', 'Serriculteur', 'Pépinière', 'Producteur fleurs', 'Centre jardin', 'Agriculture urbaine', 'Cannabis', 'Particulier', 'Distributeur', 'Partenaire', 'Compétiteur', 'Consultant', 'Autre']

function fmtCad(n) {
  if (!n) return '$0'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n)
}
function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

function fieldTypeInput(type) {
  if (type === 'number') return 'number'
  if (type === 'date') return 'date'
  if (type === 'url') return 'url'
  if (type === 'email') return 'email'
  return 'text'
}

export default function CompanyDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [company, setCompany] = useState(null)
  const [customFields, setCustomFields] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('info')
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({})
  const [saving, setSaving] = useState(false)
  const [showContactModal, setShowContactModal] = useState(false)
  const [contactForm, setContactForm] = useState({ first_name: '', last_name: '', email: '', phone: '', mobile: '', language: '' })
  const [interactions, setInteractions] = useState([])
  const [interactionsTotal, setInteractionsTotal] = useState(0)
  const [interactionsOffset, setInteractionsOffset] = useState(0)
  const [loadingInteractions, setLoadingInteractions] = useState(false)
  const [loadingMoreInteractions, setLoadingMoreInteractions] = useState(false)
  const INTER_LIMIT = 30
  const [factures, setFactures] = useState([])
  const [abonnements, setAbonnements] = useState([])
  const [serialCols, setSerialCols] = useState(['serial', 'product_name', 'status', 'manufacture_date', 'last_programmed_date'])
  const [showSerialColPicker, setShowSerialColPicker] = useState(false)
  const serialColPickerRef = useRef(null)

  const SERIAL_COL_DEFS = [
    { id: 'serial',               label: 'N° de série' },
    { id: 'product_name',         label: 'Produit' },
    { id: 'status',               label: 'Statut' },
    { id: 'manufacture_date',     label: 'Date fab.' },
    { id: 'last_programmed_date', label: 'Dernière prog.' },
  ]

  useEffect(() => {
    function onClick(e) {
      if (serialColPickerRef.current && !serialColPickerRef.current.contains(e.target)) {
        setShowSerialColPicker(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  async function load() {
    setLoading(true)
    try {
      const data = await api.companies.get(id)
      setCompany(data)
      setForm({
        name: data.name, type: data.type || '', lifecycle_phase: data.lifecycle_phase || '',
        phone: data.phone || '', email: data.email || '', website: data.website || '',
        address: data.address || '', city: data.city || '', province: data.province || '',
        country: data.country || 'Canada', notes: data.notes || '',
        extra_fields: { ...(data.extra_fields || {}) },
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])

  useEffect(() => {
    api.fieldDefs.list('companies').then(setCustomFields).catch(() => {})
  }, [])

  useEffect(() => {
    if (tab === 'interactions') {
      setLoadingInteractions(true)
      setInteractions([])
      setInteractionsOffset(0)
      api.interactions.list({ company_id: id, limit: INTER_LIMIT, offset: 0 })
        .then(d => {
          setInteractions(d.interactions || [])
          setInteractionsTotal(d.total || 0)
          setInteractionsOffset(INTER_LIMIT)
        })
        .finally(() => setLoadingInteractions(false))
    }
  }, [tab, id])

  useEffect(() => {
    if (tab === 'factures') {
      api.factures.list({ company_id: id, limit: 'all' }).then(r => setFactures(r.data)).catch(() => {})
    }
    if (tab === 'abonnements') {
      api.abonnements.list({ company_id: id, limit: 'all' }).then(r => setAbonnements(r.data)).catch(() => {})
    }
  }, [tab, id])

  async function loadMoreInteractions() {
    setLoadingMoreInteractions(true)
    try {
      const d = await api.interactions.list({ company_id: id, limit: INTER_LIMIT, offset: interactionsOffset })
      setInteractions(prev => [...prev, ...(d.interactions || [])])
      setInteractionsOffset(o => o + INTER_LIMIT)
    } finally {
      setLoadingMoreInteractions(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      await api.companies.update(id, form)
      await load()
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  async function handleAddContact(e) {
    e.preventDefault()
    await api.contacts.create({ ...contactForm, company_id: id })
    setShowContactModal(false)
    setContactForm({ first_name: '', last_name: '', email: '', phone: '', mobile: '', language: '' })
    load()
  }

  if (loading) {
    return <Layout><div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600" /></div></Layout>
  }
  if (!company) {
    return <Layout><div className="p-6 text-slate-500">Entreprise introuvable.</div></Layout>
  }

  const tabs = ['info', 'contacts', 'interactions', 'projets', 'commandes', 'support', 'numéros de série', 'factures', 'abonnements']

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <button onClick={() => navigate('/companies')} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-900">{company.name}</h1>
              {company.lifecycle_phase && (
                <Badge color={phaseBadgeColor(company.lifecycle_phase)} size="md">{company.lifecycle_phase}</Badge>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1 text-sm text-slate-500 flex-wrap">
              {company.type && <span>{company.type}</span>}
              {company.phone && <span>· {company.phone}</span>}
            </div>
          </div>
          {!editing && (
            <button onClick={() => setEditing(true)} className="btn-secondary">
              <Edit2 size={14} /> Modifier
            </button>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-slate-200 overflow-x-auto">
          {tabs.map(t => {
            const tabLabel = t === 'info' ? 'Informations' : t === 'interactions' ? 'Interactions' : t === 'numéros de série' ? 'N° de série' : t.charAt(0).toUpperCase() + t.slice(1)
            const counts = {
              contacts: company.contacts?.length,
              projets: company.projects?.length,
              interactions: interactionsTotal || undefined,
              commandes: company.orders?.length,
              support: company.tickets?.length,
              'numéros de série': company.serials?.length,
              factures: factures.length || undefined,
              abonnements: abonnements.length || undefined,
            }
            const count = counts[t]
            return (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-shrink-0 flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  tab === t
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                {tabLabel}
                {count > 0 && (
                  <span className="bg-slate-200 text-slate-600 text-xs px-1.5 py-0.5 rounded-full leading-none">{count}</span>
                )}
              </button>
            )
          })}
        </div>

        {/* Info Tab */}
        {tab === 'info' && (
          <div className="card p-6">
            {editing ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="col-span-2">
                    <label className="label">Nom *</label>
                    <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="input" />
                  </div>
                  <div>
                    <label className="label">Type</label>
                    <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} className="select">
                      <option value="">—</option>
                      {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">Phase</label>
                    <select value={form.lifecycle_phase} onChange={e => setForm(f => ({ ...f, lifecycle_phase: e.target.value }))} className="select">
                      <option value="">—</option>
                      {PHASES.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">Téléphone</label>
                    <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="input" />
                  </div>
                  <div className="col-span-2">
                    <label className="label">Site web</label>
                    <input value={form.website} onChange={e => setForm(f => ({ ...f, website: e.target.value }))} className="input" />
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
                <div className="flex justify-end gap-3">
                  <button onClick={() => setEditing(false)} className="btn-secondary"><X size={14} /> Annuler</button>
                  <button onClick={handleSave} disabled={saving} className="btn-primary"><Save size={14} /> {saving ? 'Enregistrement...' : 'Enregistrer'}</button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-8 gap-y-4">
                {[
                  ['Type', company.type],
                  ['Phase', company.lifecycle_phase],
                  ['Téléphone', company.phone],
                  ['Site web', company.website],
                ].map(([label, value]) => value ? (
                  <div key={label}>
                    <div className="text-xs font-medium text-slate-400 uppercase tracking-wide">{label}</div>
                    <div className="text-sm text-slate-900 mt-0.5">
                      {label === 'Site web' ? (
                        <a href={company.website} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline">{value}</a>
                      ) : value}
                    </div>
                  </div>
                ) : null)}
                {customFields.filter(cf => company.extra_fields?.[cf.key]).map(cf => (
                  <div key={cf.key}>
                    <div className="text-xs font-medium text-slate-400 uppercase tracking-wide">{cf.label}</div>
                    <div className="text-sm text-slate-900 mt-0.5">{company.extra_fields[cf.key]}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Contacts Tab */}
        {tab === 'contacts' && (
          <div>
            <div className="flex justify-end mb-3">
              <button onClick={() => setShowContactModal(true)} className="btn-primary btn-sm"><Plus size={14} /> Ajouter</button>
            </div>
            <div className="card overflow-hidden">
              {company.contacts?.length === 0 ? (
                <p className="text-center py-10 text-slate-400">Aucun contact</p>
              ) : (
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-slate-200 bg-slate-50">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Nom</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden sm:table-cell">Courriel</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Téléphone</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Langue</th>
                  </tr></thead>
                  <tbody>
                    {company.contacts.map(c => (
                      <tr key={c.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                        <td className="px-4 py-3 font-medium">{c.first_name} {c.last_name}</td>
                        <td className="px-4 py-3 hidden sm:table-cell text-slate-500">{c.email || '—'}</td>
                        <td className="px-4 py-3 hidden md:table-cell text-slate-500">{c.phone || c.mobile || '—'}</td>
                        <td className="px-4 py-3">
                          {c.language && <Badge color={c.language === 'French' ? 'blue' : 'green'}>{c.language}</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* Interactions Tab */}
        {tab === 'interactions' && (
          <div>
            {loadingInteractions ? (
              <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" /></div>
            ) : interactions.length === 0 ? (
              <div className="card p-10 text-center text-slate-400">Aucune interaction</div>
            ) : (
              <div className="space-y-2">
                {interactions.map(item => <InteractionItem key={item.id} item={item} />)}
                {interactions.length < interactionsTotal && (
                  <button onClick={loadMoreInteractions} disabled={loadingMoreInteractions} className="btn-secondary w-full">
                    {loadingMoreInteractions ? 'Chargement...' : `Charger plus (${interactionsTotal - interactions.length} restants)`}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Projects Tab */}
        {tab === 'projets' && (
          <div>
            <div className="flex justify-end mb-3">
              <Link to={`/pipeline?company_id=${id}`} className="btn-secondary btn-sm"><Plus size={14} /> Nouveau projet</Link>
            </div>
            <div className="space-y-3">
              {company.projects?.length === 0 ? (
                <div className="card p-10 text-center text-slate-400">Aucun projet</div>
              ) : company.projects.map(p => (
                <div key={p.id} className="card p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium text-slate-900">{p.name}</div>
                      <div className="text-xs text-slate-500 mt-0.5">{p.type} · {p.assigned_name || 'Non assigné'}</div>
                    </div>
                    <Badge color={projectStatusColor(p.status)}>{p.status}</Badge>
                  </div>
                  <div className="flex gap-4 mt-3 text-sm">
                    <div><span className="text-slate-400">Valeur: </span><span className="font-medium">{fmtCad(p.value_cad)}</span></div>
                    <div><span className="text-slate-400">Probabilité: </span><span className="font-medium">{p.probability}%</span></div>
                    {p.nb_greenhouses > 0 && <div><span className="text-slate-400">Serres: </span><span className="font-medium">{p.nb_greenhouses}</span></div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Orders Tab */}
        {tab === 'commandes' && (
          <div className="card overflow-hidden">
            {company.orders?.length === 0 ? (
              <p className="text-center py-10 text-slate-400">Aucune commande</p>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-200 bg-slate-50">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Commande</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Statut</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Articles</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Date</th>
                </tr></thead>
                <tbody>
                  {company.orders.map(o => (
                    <tr key={o.id} onClick={() => navigate(`/orders/${o.id}`)} className="table-row-hover border-b border-slate-100 last:border-0">
                      <td className="px-4 py-3 font-medium">#{o.order_number}</td>
                      <td className="px-4 py-3"><Badge color={orderStatusColor(o.status)}>{o.status}</Badge></td>
                      <td className="px-4 py-3 hidden md:table-cell text-slate-500">{o.items_count}</td>
                      <td className="px-4 py-3 text-slate-500">{fmtDate(o.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Support Tab */}
        {tab === 'support' && (
          <div className="card overflow-hidden">
            {company.tickets?.length === 0 ? (
              <p className="text-center py-10 text-slate-400">Aucun ticket</p>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-200 bg-slate-50">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Titre</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Type</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Statut</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Date</th>
                </tr></thead>
                <tbody>
                  {company.tickets.map(t => (
                    <tr key={t.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium">{t.title}</td>
                      <td className="px-4 py-3"><Badge color="blue">{t.type}</Badge></td>
                      <td className="px-4 py-3"><Badge color={ticketStatusColor(t.status)}>{t.status}</Badge></td>
                      <td className="px-4 py-3 hidden md:table-cell text-slate-500">{fmtDate(t.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Numéros de série Tab */}
        {tab === 'numéros de série' && (
          <div>
            <div className="flex justify-end mb-3 relative" ref={serialColPickerRef}>
              <button
                onClick={() => setShowSerialColPicker(s => !s)}
                className="btn-secondary btn-sm flex items-center gap-1.5"
              >
                <Eye size={13} /> Colonnes
              </button>
              {showSerialColPicker && (
                <div className="absolute top-full right-0 mt-1 z-20 bg-white border border-slate-200 rounded-lg shadow-xl p-3 w-52">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Colonnes visibles</p>
                  <div className="space-y-0.5">
                    {SERIAL_COL_DEFS.map(col => (
                      <label key={col.id} className="flex items-center gap-2 px-1 py-1 rounded hover:bg-slate-50 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={serialCols.includes(col.id)}
                          onChange={e => setSerialCols(prev => e.target.checked ? [...prev, col.id] : prev.filter(c => c !== col.id))}
                          className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="text-sm text-slate-700">{col.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="card overflow-hidden">
              {!company.serials?.length ? (
                <p className="text-center py-10 text-slate-400">Aucun numéro de série</p>
              ) : (
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-slate-200 bg-slate-50">
                    {serialCols.includes('serial') && <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">N° de série</th>}
                    {serialCols.includes('product_name') && <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Produit</th>}
                    {serialCols.includes('status') && <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Statut</th>}
                    {serialCols.includes('manufacture_date') && <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Date fab.</th>}
                    {serialCols.includes('last_programmed_date') && <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Dernière prog.</th>}
                  </tr></thead>
                  <tbody>
                    {company.serials.map(s => (
                      <tr key={s.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                        {serialCols.includes('serial') && <td className="px-4 py-3 font-mono font-medium text-slate-900">{s.serial}</td>}
                        {serialCols.includes('product_name') && (
                          <td className="px-4 py-3">
                            {s.product_id
                              ? <Link to={`/products/${s.product_id}`} className="text-indigo-600 hover:underline">{s.product_name || s.sku || '—'}</Link>
                              : '—'
                            }
                          </td>
                        )}
                        {serialCols.includes('status') && <td className="px-4 py-3 text-slate-600">{s.status || '—'}</td>}
                        {serialCols.includes('manufacture_date') && <td className="px-4 py-3 text-slate-500">{fmtDate(s.manufacture_date)}</td>}
                        {serialCols.includes('last_programmed_date') && <td className="px-4 py-3 text-slate-500">{fmtDate(s.last_programmed_date)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* Factures Tab */}
        {tab === 'factures' && (
          <div className="card overflow-hidden">
            {!factures.length ? (
              <p className="text-center py-10 text-slate-400">Aucune facture</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">N° document</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Statut</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden sm:table-cell">Date</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Échéance</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500">Total</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500">Solde dû</th>
                  </tr>
                </thead>
                <tbody>
                  {factures.map(f => (
                    <tr key={f.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-3 font-mono font-medium text-slate-900">{f.document_number || '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{f.status || '—'}</td>
                      <td className="px-4 py-3 hidden sm:table-cell text-slate-500">{fmtDate(f.document_date)}</td>
                      <td className="px-4 py-3 hidden md:table-cell text-slate-500">{fmtDate(f.due_date)}</td>
                      <td className="px-4 py-3 text-right font-medium text-slate-700">{fmtCad(f.total_cad)}</td>
                      <td className="px-4 py-3 text-right font-medium">
                        <span className={f.balance_due_cad > 0 ? 'text-red-600' : 'text-green-600'}>
                          {fmtCad(f.balance_due_cad)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Abonnements Tab */}
        {tab === 'abonnements' && (
          <div className="card overflow-hidden">
            {!abonnements.length ? (
              <p className="text-center py-10 text-slate-400">Aucun abonnement</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Produit</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Type</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Statut</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500">Montant</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden sm:table-cell">Début</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Fin</th>
                  </tr>
                </thead>
                <tbody>
                  {abonnements.map(a => (
                    <tr key={a.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-3 text-slate-900">{a.product_name || '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{a.type || '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{a.status || '—'}</td>
                      <td className="px-4 py-3 text-right font-medium text-slate-700">{fmtCad(a.amount_cad)}</td>
                      <td className="px-4 py-3 hidden sm:table-cell text-slate-500">{fmtDate(a.start_date)}</td>
                      <td className="px-4 py-3 hidden md:table-cell text-slate-500">{fmtDate(a.end_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Add Contact Modal */}
      <Modal isOpen={showContactModal} onClose={() => setShowContactModal(false)} title="Ajouter un contact">
        <form onSubmit={handleAddContact} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Prénom *</label>
              <input value={contactForm.first_name} onChange={e => setContactForm(f => ({ ...f, first_name: e.target.value }))} className="input" required />
            </div>
            <div>
              <label className="label">Nom *</label>
              <input value={contactForm.last_name} onChange={e => setContactForm(f => ({ ...f, last_name: e.target.value }))} className="input" required />
            </div>
            <div>
              <label className="label">Courriel</label>
              <input type="email" value={contactForm.email} onChange={e => setContactForm(f => ({ ...f, email: e.target.value }))} className="input" />
            </div>
            <div>
              <label className="label">Téléphone</label>
              <input value={contactForm.phone} onChange={e => setContactForm(f => ({ ...f, phone: e.target.value }))} className="input" />
            </div>
            <div>
              <label className="label">Mobile</label>
              <input value={contactForm.mobile} onChange={e => setContactForm(f => ({ ...f, mobile: e.target.value }))} className="input" />
            </div>
            <div>
              <label className="label">Langue</label>
              <select value={contactForm.language} onChange={e => setContactForm(f => ({ ...f, language: e.target.value }))} className="select">
                <option value="">—</option>
                <option value="French">Français</option>
                <option value="English">Anglais</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setShowContactModal(false)} className="btn-secondary">Annuler</button>
            <button type="submit" className="btn-primary">Ajouter</button>
          </div>
        </form>
      </Modal>
    </Layout>
  )
}
