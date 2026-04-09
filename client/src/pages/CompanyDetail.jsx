import { useState, useEffect, useRef, useMemo } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Edit2, Plus, Save, X, Trash2, ChevronDown, ChevronUp, Phone, Mail, MessageSquare, Building2, PhoneCall, PhoneIncoming, PhoneOutgoing, Eye, CheckCircle2, Circle, Clock, AlertCircle, Zap } from 'lucide-react'
import InteractionTimeline from '../components/InteractionTimeline.jsx'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge, phaseBadgeColor, orderStatusColor, ticketStatusColor, projectStatusColor } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { useAuth } from '../lib/auth.jsx'

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

function fmtPhone(val) {
  if (!val) return ''
  const digits = String(val).replace(/\D/g, '')
  const d = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
  return val
}

function InlineField({ field, value, saving, onSave }) {
  const [local, setLocal] = useState(String(value ?? ''))
  useEffect(() => { setLocal(String(value ?? '')) }, [value])

  const base = `w-full text-sm rounded-lg border transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-400 ${saving ? 'opacity-50' : ''}`
  const inputCls = `${base} border-slate-200 bg-white px-3 py-1.5 hover:border-slate-300`
  const selectCls = `${base} border-slate-200 bg-white px-3 py-1.5 hover:border-slate-300`

  function commit(val) {
    if (val === String(value ?? '')) return
    onSave(val)
  }

  return (
    <div className={field.span2 ? 'col-span-2' : ''}>
      <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">{field.label}</div>
      {field.type === 'select' ? (
        <select value={local} onChange={e => { setLocal(e.target.value); commit(e.target.value) }} className={selectCls} disabled={saving}>
          <option value="">—</option>
          {(field.options || []).map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : field.type === 'textarea' ? (
        <textarea value={local} onChange={e => setLocal(e.target.value)} onBlur={e => commit(e.target.value)} className={`${inputCls} resize-none`} rows={3} />
      ) : field.type === 'phone' ? (
        <input type="tel" value={local} onChange={e => setLocal(e.target.value)}
          onBlur={e => { const f = fmtPhone(e.target.value); setLocal(f); commit(f) }}
          className={inputCls} />
      ) : (
        <input
          type={fieldTypeInput(field.type)}
          value={local}
          onChange={e => setLocal(e.target.value)}
          onBlur={e => commit(e.target.value)}
          className={inputCls}
        />
      )}
    </div>
  )
}

const COMPANY_FIELDS = [
  { key: 'type',            label: 'Type',      type: 'select', options: TYPES },
  { key: 'lifecycle_phase', label: 'Phase',     type: 'select', options: PHASES },
  { key: 'phone',           label: 'Téléphone', type: 'phone' },
  { key: 'website',         label: 'Site web',  type: 'url', span2: true },
  { key: 'notes',           label: 'Notes',     type: 'textarea', span2: true, defaultVisible: false },
]

export default function CompanyDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [company, setCompany] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('info')
  const [fieldSaving, setFieldSaving] = useState(null)
  const [showContactModal, setShowContactModal] = useState(false)
  const [contactForm, setContactForm] = useState({ first_name: '', last_name: '', email: '', phone: '', mobile: '', language: '' })
  const [interactions, setInteractions] = useState([])
  const [interactionsTotal, setInteractionsTotal] = useState(0)
  const [interactionsOffset, setInteractionsOffset] = useState(0)
  const [loadingInteractions, setLoadingInteractions] = useState(false)
  const [loadingMoreInteractions, setLoadingMoreInteractions] = useState(false)
  const INTER_LIMIT = 30
  const [factures, setFactures] = useState([])
  const [facturesTotal, setFacturesTotal] = useState(0)
  const [envoisTotal, setEnvoisTotal] = useState(0)
  const [abonnementsTotal, setAbonnementsTotal] = useState(0)
  const [abonnements, setAbonnements] = useState([])
  const [selectedAbonnement, setSelectedAbonnement] = useState(null)
  const [abonnementDetails, setAbonnementDetails] = useState(null)
  const [loadingAbDetails, setLoadingAbDetails] = useState(false)
  const [tasks, setTasks] = useState([])
  const [users, setUsers] = useState([])
  const [showTaskModal, setShowTaskModal] = useState(false)
  const [editingTask, setEditingTask] = useState(null)
  const [taskForm, setTaskForm] = useState({ title: '', status: 'À faire', priority: 'Normal', due_date: '', contact_id: '', assigned_to: '', notes: '' })
  const [savingTask, setSavingTask] = useState(false)
  const [envois, setEnvois] = useState([])
  const [facturesFourn, setFacturesFourn] = useState([])
  const [facturesFournTotal, setFacturesFournTotal] = useState(0)
  const [depenses, setDepenses] = useState([])
  const [depensesTotal, setDepensesTotal] = useState(0)
  const [retours, setRetours] = useState([])
  const [adresses, setAdresses] = useState([])
  const [showAdresseModal, setShowAdresseModal] = useState(false)
  const [editingAdresse, setEditingAdresse] = useState(null)
  const [adresseForm, setAdresseForm] = useState({ line1: '', city: '', province: '', postal_code: '', country: 'CA', address_type: 'Ferme', contact_id: '' })
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
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])

  useEffect(() => {
    api.adresses.list({ company_id: id, limit: 'all' }).then(r => setAdresses(r.data || [])).catch(() => {})
  }, [id])

  useEffect(() => {
    api.interactions.list({ company_id: id, limit: 1, offset: 0 }).then(d => setInteractionsTotal(d.total || 0)).catch(() => {})
    api.shipments.list({ company_id: id, limit: 1 }).then(r => setEnvoisTotal(r.total || 0)).catch(() => {})
    api.factures.list({ company_id: id, limit: 1 }).then(r => setFacturesTotal(r.total || 0)).catch(() => {})
    api.abonnements.list({ company_id: id, limit: 1 }).then(r => setAbonnementsTotal(r.total || r.data?.length || 0)).catch(() => {})
  }, [id])

  const visibleFields = useMemo(() => COMPANY_FIELDS.filter(f => f.defaultVisible !== false), [])

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
      api.factures.list({ company_id: id, limit: 'all' }).then(r => { setFactures(r.data); setFacturesTotal(r.total || r.data?.length || 0) }).catch(() => {})
    }
    if (tab === 'abonnements') {
      api.abonnements.list({ company_id: id, limit: 'all' }).then(r => setAbonnements(r.data)).catch(() => {})
    }
    if (tab === 'tâches') {
      api.tasks.list({ company_id: id, limit: 'all' }).then(r => setTasks(r.data || [])).catch(() => {})
      api.auth.users().then(setUsers).catch(() => {})
    }
    if (tab === 'envois') {
      api.shipments.list({ company_id: id, limit: 'all' }).then(r => { setEnvois(r.data || []); setEnvoisTotal(r.total || r.data?.length || 0) }).catch(() => {})
    }
    if (tab === 'fact-fourn') {
      api.facturesFournisseurs.list({ vendor_id: id, limit: 'all' }).then(r => { setFacturesFourn(r.data || []); setFacturesFournTotal(r.total || r.data?.length || 0) }).catch(() => {})
    }
    if (tab === 'depenses') {
      api.depenses.list({ vendor_id: id, limit: 'all' }).then(r => { setDepenses(r.data || []); setDepensesTotal(r.total || r.data?.length || 0) }).catch(() => {})
    }
    if (tab === 'retours') {
      api.returns.listByCompany(id).then(r => setRetours(r.data || [])).catch(() => {})
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

  async function saveField(key, value) {
    setFieldSaving(key)
    try {
      await api.companies.update(id, { [key]: value })
      setCompany(c => ({ ...c, [key]: value }))
    } finally {
      setFieldSaving(null)
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

  const tabs = ['info', 'contacts', 'interactions', 'projets', 'commandes', 'envois', 'retours', 'support', 'numéros de série', 'factures', 'abonnements', 'tâches', ...(company.quickbooks_vendor_id ? ['fact-fourn', 'depenses'] : [])]

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
              {company.phone && <span>· {fmtPhone(company.phone)}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
          </div>
        </div>

        {/* Tabs + Content */}
        <div className="flex gap-6 items-start">
          {/* Sidebar tabs */}
          <div className="w-44 flex-shrink-0">
            <nav className="flex flex-col gap-0.5">
              {tabs.map(t => {
                const tabLabel = t === 'info' ? 'Informations' : t === 'interactions' ? 'Interactions' : t === 'numéros de série' ? 'N° de série' : t === 'fact-fourn' ? 'Fact. fournisseurs' : t === 'depenses' ? 'Dépenses' : t === 'retours' ? 'Retours (RMA)' : t.charAt(0).toUpperCase() + t.slice(1)
                const counts = {
                  contacts: company.contacts?.length,
                  projets: company.projects?.length,
                  interactions: interactionsTotal || undefined,
                  commandes: company.orders?.length,
                  envois: envoisTotal || undefined,
                  support: company.tickets?.length,
                  'numéros de série': company.serials?.length,
                  factures: facturesTotal || undefined,
                  abonnements: abonnementsTotal || undefined,
                  tâches: tasks.length || undefined,
                  'fact-fourn': facturesFournTotal || undefined,
                  depenses: depensesTotal || undefined,
                  retours: (tab === 'retours' ? retours.length : company.returns_count) || undefined,
                }
                const count = counts[t]
                return (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left w-full ${
                      tab === t
                        ? 'bg-indigo-50 text-indigo-700'
                        : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <span>{tabLabel}</span>
                    {count > 0 && (
                      <span className="bg-slate-200 text-slate-600 text-xs px-1.5 py-0.5 rounded-full leading-none flex-shrink-0">{count}</span>
                    )}
                  </button>
                )
              })}
            </nav>
          </div>

          {/* Tab content */}
          <div className="flex-1 min-w-0">

        {/* Info Tab */}
        {tab === 'info' && (
          <div className="card p-6">
            <div className="grid grid-cols-2 gap-4">
              {visibleFields.map(field => {
                if (field.key === 'name') return null
                const value = company[field.key] ?? ''
                const isSaving = fieldSaving === field.key
                return (
                  <InlineField
                    key={field.key}
                    field={field}
                    value={value}
                    saving={isSaving}
                    onSave={val => saveField(field.key, val)}
                  />
                )
              })}
            </div>
          </div>
        )}

        {/* Adresses section (always shown below info) */}
        {tab === 'info' && (
          <div className="card p-6 mt-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-slate-700">Adresses</h3>
              <button onClick={() => { setEditingAdresse(null); setAdresseForm({ line1: '', city: '', province: '', postal_code: '', country: 'CA', address_type: 'Ferme', contact_id: '' }); setShowAdresseModal(true) }} className="btn-secondary btn-sm"><Plus size={13} /> Ajouter</button>
            </div>
            {adresses.length === 0 ? (
              <p className="text-sm text-slate-400">Aucune adresse</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {adresses.map(a => (
                  <div key={a.id} className="flex items-start justify-between py-3 gap-4">
                    <div>
                      <span className="inline-block text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 mb-1">{a.address_type || '—'}</span>
                      <div className="text-sm text-slate-800">{a.line1}</div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {[a.city, a.province, a.postal_code, a.country].filter(Boolean).join(', ')}
                      </div>
                      {a.contact_name?.trim() && (
                        <Link to={`/contacts/${a.contact_id}`} className="text-xs text-indigo-500 hover:underline mt-0.5 block">{a.contact_name.trim()}</Link>
                      )}
                      {a.language && <div className="text-xs text-slate-400 mt-0.5">{a.language}</div>}
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                      <button onClick={() => { setEditingAdresse(a); setAdresseForm({ line1: a.line1||'', city: a.city||'', province: a.province||'', postal_code: a.postal_code||'', country: a.country||'Canada', address_type: a.address_type||'Ferme', contact_id: a.contact_id||'' }); setShowAdresseModal(true) }} className="text-slate-400 hover:text-indigo-600 p-1"><Edit2 size={13} /></button>
                      <button onClick={async () => { if (!confirm('Supprimer cette adresse ?')) return; await api.adresses.delete(a.id); setAdresses(prev => prev.filter(x => x.id !== a.id)) }} className="text-slate-400 hover:text-red-500 p-1"><Trash2 size={13} /></button>
                    </div>
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
                      <tr key={c.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 cursor-pointer" onClick={() => navigate(`/contacts/${c.id}`)}>
                        <td className="px-4 py-3 font-medium text-indigo-600">{c.first_name} {c.last_name}</td>
                        <td className="px-4 py-3 hidden sm:table-cell text-slate-500">{c.email || '—'}</td>
                        <td className="px-4 py-3 hidden md:table-cell text-slate-500 font-mono text-sm">{fmtPhone(c.phone || c.mobile) || '—'}</td>
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
          <InteractionTimeline
            interactions={interactions}
            loading={loadingInteractions}
            total={interactionsTotal}
            onLoadMore={loadMoreInteractions}
            loadingMore={loadingMoreInteractions}
          />
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
                              ? <Link to={`/products/${s.product_id}`} className="flex items-center gap-2 text-indigo-600 hover:underline">
                                  {s.product_image
                                    ? <img src={s.product_image} alt="" className="w-8 h-8 object-cover rounded border border-slate-200 shrink-0" />
                                    : <div className="w-8 h-8 rounded border border-slate-200 bg-slate-100 shrink-0" />
                                  }
                                  <span>{s.product_name || s.sku || '—'}</span>
                                </Link>
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
          <div>
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
                      <tr key={a.id} className={`border-b border-slate-100 last:border-0 hover:bg-slate-50 cursor-pointer ${selectedAbonnement?.id === a.id ? 'bg-indigo-50' : ''}`}
                        onClick={() => {
                          if (selectedAbonnement?.id === a.id) { setSelectedAbonnement(null); setAbonnementDetails(null); return }
                          setSelectedAbonnement(a)
                          setAbonnementDetails(null)
                          setLoadingAbDetails(true)
                          api.abonnements.stripeDetails(a.id).then(setAbonnementDetails).catch(() => setAbonnementDetails(null)).finally(() => setLoadingAbDetails(false))
                        }}>
                        <td className="px-4 py-3 text-slate-900">{a.product_name || '—'}</td>
                        <td className="px-4 py-3 text-slate-600">{a.type || '—'}</td>
                        <td className="px-4 py-3 text-slate-600">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${a.status === 'active' ? 'bg-green-100 text-green-700' : a.status === 'canceled' ? 'bg-red-100 text-red-700' : a.status === 'past_due' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                            {a.status === 'active' ? 'Actif' : a.status === 'canceled' ? 'Annulé' : a.status === 'past_due' ? 'En retard' : a.status === 'trialing' ? 'Essai' : a.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-slate-700">{fmtCad(a.amount_cad)}</td>
                        <td className="px-4 py-3 hidden sm:table-cell text-slate-500">{fmtDate(a.start_date)}</td>
                        <td className="px-4 py-3 hidden md:table-cell text-slate-500">{fmtDate(a.end_date)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Détail abonnement */}
            {selectedAbonnement && (
              <div className="mt-4 card p-5 space-y-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-slate-900">Détails de l'abonnement</h3>
                  <div className="flex items-center gap-2">
                    {selectedAbonnement.stripe_url && (
                      <a href={selectedAbonnement.stripe_url} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-600 hover:underline">Voir sur Stripe</a>
                    )}
                    <button onClick={() => { setSelectedAbonnement(null); setAbonnementDetails(null) }} className="text-slate-400 hover:text-slate-600">
                      <X size={16} />
                    </button>
                  </div>
                </div>

                {loadingAbDetails ? (
                  <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600" /></div>
                ) : !abonnementDetails ? (
                  <p className="text-center py-6 text-slate-400 text-sm">Impossible de charger les détails Stripe</p>
                ) : (
                  <>
                    {/* Produits / Line items */}
                    <div>
                      <h4 className="text-sm font-semibold text-slate-700 mb-2">Produits</h4>
                      <div className="border border-slate-200 rounded-lg overflow-hidden">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-slate-50 border-b border-slate-200">
                              <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500">Produit</th>
                              <th className="text-right px-4 py-2 text-xs font-semibold text-slate-500">Prix unitaire</th>
                              <th className="text-right px-4 py-2 text-xs font-semibold text-slate-500">Qté</th>
                              <th className="text-right px-4 py-2 text-xs font-semibold text-slate-500">Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {abonnementDetails.items.map(item => (
                              <tr key={item.id} className="border-b border-slate-100 last:border-0">
                                <td className="px-4 py-2.5">
                                  <div className="font-medium text-slate-800">{item.product_name}</div>
                                  {item.description && <div className="text-xs text-slate-400 mt-0.5">{item.description}</div>}
                                  {item.interval && <div className="text-xs text-slate-400">/ {item.interval_count > 1 ? `${item.interval_count} ` : ''}{item.interval === 'month' ? 'mois' : item.interval === 'year' ? 'an' : item.interval}</div>}
                                </td>
                                <td className="px-4 py-2.5 text-right text-slate-600">{item.unit_amount != null ? `${item.unit_amount.toFixed(2)} ${item.currency}` : '—'}</td>
                                <td className="px-4 py-2.5 text-right text-slate-600">{item.quantity}</td>
                                <td className="px-4 py-2.5 text-right font-medium text-slate-800">{item.total != null ? `${item.total.toFixed(2)} ${item.currency}` : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {abonnementDetails.discount && (
                        <div className="mt-2 text-xs text-indigo-600">
                          Rabais: {abonnementDetails.discount.name}
                          {abonnementDetails.discount.percent_off && ` (${abonnementDetails.discount.percent_off}%)`}
                          {abonnementDetails.discount.amount_off && ` (${abonnementDetails.discount.amount_off} $)`}
                        </div>
                      )}
                    </div>

                    {/* Historique des changements */}
                    {abonnementDetails.history.length > 0 && (
                      <div>
                        <h4 className="text-sm font-semibold text-slate-700 mb-2">Historique des changements</h4>
                        <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                          {abonnementDetails.history.map((h, i) => (
                            <div key={i} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                              <div className="flex-shrink-0 pt-0.5 w-28">
                                <div className="text-xs text-slate-400">{fmtDate(h.date)}</div>
                                <div className={`text-[10px] font-medium mt-0.5 ${h.type === 'creation' ? 'text-green-600' : 'text-amber-600'}`}>
                                  {h.type === 'creation' ? 'Création' : 'Modification'}
                                </div>
                              </div>
                              <div className="flex-1 space-y-0.5">
                                {h.changes.map((c, j) => (
                                  <div key={j} className="text-slate-600 text-sm">{typeof c === 'string' ? c : `${c.field}: ${c.from || ''} → ${c.to || ''}`}</div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Factures récentes */}
                    {abonnementDetails.invoices.length > 0 && (
                      <div>
                        <h4 className="text-sm font-semibold text-slate-700 mb-2">Factures ({abonnementDetails.invoices.length})</h4>
                        <div className="border border-slate-200 rounded-lg overflow-hidden divide-y divide-slate-100">
                          {abonnementDetails.invoices.map((inv, i) => (
                            <div key={i} className="px-4 py-2.5">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                  <span className="text-xs text-slate-700 font-mono">{inv.number || '—'}</span>
                                  <span className="text-xs text-slate-400">{fmtDate(inv.date)}</span>
                                  <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium ${inv.status === 'paid' ? 'bg-green-100 text-green-700' : inv.status === 'open' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                                    {inv.status === 'paid' ? 'Payée' : inv.status === 'open' ? 'Ouverte' : inv.status === 'draft' ? 'Brouillon' : inv.status}
                                  </span>
                                </div>
                                <div className="flex items-center gap-3">
                                  <span className="font-medium text-slate-700 text-sm">{inv.amount.toFixed(2)} $</span>
                                  {inv.pdf && <a href={inv.pdf} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline text-xs">PDF</a>}
                                </div>
                              </div>
                              {inv.lines && inv.lines.length > 0 && (
                                <div className="mt-1.5 space-y-0.5">
                                  {inv.lines.map((li, j) => (
                                    <div key={j} className={`flex items-center justify-between text-xs ${li.proration ? 'text-amber-600' : 'text-slate-400'}`}>
                                      <span className="truncate mr-4">{li.proration ? '↕ ' : ''}{li.description}</span>
                                      <span className="flex-shrink-0 font-mono">{li.amount >= 0 ? '' : '-'}{Math.abs(li.amount).toFixed(2)} $</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Envois Tab */}
        {tab === 'envois' && (
          <div className="card overflow-hidden">
            {!envois.length ? (
              <p className="text-center py-10 text-slate-400">Aucun envoi</p>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-200 bg-slate-50">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">N° de suivi</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Statut</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden sm:table-cell">Transporteur</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Commande</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Envoyé le</th>
                </tr></thead>
                <tbody>
                  {envois.map(e => (
                    <tr key={e.id} onClick={() => navigate(`/envois/${e.id}`)} className="table-row-hover border-b border-slate-100 last:border-0 cursor-pointer">
                      <td className="px-4 py-3 font-mono text-slate-900">{e.tracking_number || <span className="text-slate-400">—</span>}</td>
                      <td className="px-4 py-3"><Badge color={e.status === 'Envoyé' ? 'green' : 'yellow'}>{e.status}</Badge></td>
                      <td className="px-4 py-3 hidden sm:table-cell text-slate-500">{e.carrier || '—'}</td>
                      <td className="px-4 py-3 hidden md:table-cell text-slate-500">{e.order_number ? `#${e.order_number}` : '—'}</td>
                      <td className="px-4 py-3 text-slate-500">{fmtDate(e.shipped_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Tâches Tab */}
        {tab === 'tâches' && (
          <div>
            <div className="flex justify-end mb-3">
              <button onClick={() => { setTaskForm({ title: '', status: 'À faire', priority: 'Normal', due_date: '', contact_id: '', assigned_to: '', notes: '' }); setEditingTask(null); setShowTaskModal(true) }} className="btn-primary btn-sm"><Plus size={14} /> Ajouter</button>
            </div>
            <div className="card overflow-hidden">
              {tasks.length === 0 ? (
                <p className="text-center py-10 text-slate-400">Aucune tâche</p>
              ) : (
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-slate-200 bg-slate-50">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Tâche</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Statut</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden sm:table-cell">Priorité</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Échéance</th>
                  </tr></thead>
                  <tbody>
                    {tasks.map(t => {
                      const overdue = t.due_date && t.status !== 'Terminé' && new Date(t.due_date) < new Date()
                      return (
                        <tr key={t.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 cursor-pointer" onClick={() => { setEditingTask(t); setTaskForm({ title: t.title, status: t.status, priority: t.priority, due_date: t.due_date || '', contact_id: t.contact_id || '', assigned_to: t.assigned_to || '', notes: t.notes || '' }); setShowTaskModal(true) }}>
                          <td className="px-4 py-3 font-medium text-slate-900">{t.title}</td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${t.status === 'Terminé' ? 'bg-green-100 text-green-700' : t.status === 'En cours' ? 'bg-blue-100 text-blue-700' : t.status === 'Annulé' ? 'bg-slate-100 text-slate-500' : 'bg-amber-100 text-amber-700'}`}>{t.status}</span>
                          </td>
                          <td className="px-4 py-3 hidden sm:table-cell text-slate-500">{t.priority}</td>
                          <td className="px-4 py-3 hidden md:table-cell">
                            {t.due_date ? <span className={overdue ? 'text-red-600 font-medium' : 'text-slate-500'}>{fmtDate(t.due_date)}</span> : <span className="text-slate-400">—</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
        {/* Factures fournisseurs Tab */}
        {tab === 'fact-fourn' && (
          <div className="card overflow-hidden">
            {!facturesFourn.length ? (
              <p className="text-center py-10 text-slate-400">Aucune facture fournisseur</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">N° facture</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Statut</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden sm:table-cell">Date</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Échéance</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500">Total</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500">Solde dû</th>
                  </tr>
                </thead>
                <tbody>
                  {facturesFourn.map(f => {
                    const balance = f.balance_due_cad ?? (f.total_cad - f.amount_paid_cad)
                    const overdue = f.status !== 'Payée' && f.status !== 'Annulée' && f.due_date && new Date(f.due_date) < new Date()
                    return (
                      <tr key={f.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                        <td className="px-4 py-3 font-mono font-medium text-slate-900">{f.bill_number || f.vendor_invoice_number || '—'}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex text-xs font-medium px-2 py-0.5 rounded-full ${
                            f.status === 'Payée' ? 'bg-green-100 text-green-700' :
                            f.status === 'En retard' ? 'bg-red-100 text-red-700' :
                            f.status === 'Payée partiellement' ? 'bg-yellow-100 text-yellow-700' :
                            f.status === 'Approuvée' ? 'bg-indigo-100 text-indigo-700' :
                            f.status === 'Annulée' ? 'bg-slate-100 text-slate-400' :
                            'bg-blue-100 text-blue-700'
                          }`}>{f.status}</span>
                        </td>
                        <td className="px-4 py-3 hidden sm:table-cell text-slate-500">{fmtDate(f.date_facture)}</td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          {f.due_date
                            ? <span className={overdue ? 'text-red-600 font-medium' : 'text-slate-500'}>{fmtDate(f.due_date)}</span>
                            : <span className="text-slate-400">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-slate-700">{fmtCad(f.total_cad)}</td>
                        <td className="px-4 py-3 text-right font-medium">
                          <span className={balance > 0 ? 'text-red-600' : 'text-green-600'}>{fmtCad(balance)}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Retours (RMA) Tab */}
        {tab === 'retours' && (
          <div className="card overflow-hidden">
            {!retours.length ? (
              <p className="text-center py-10 text-slate-400">Aucun retour</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">N° RMA</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Statut</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden sm:table-cell">Traitement</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Contact</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Commande</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500">Articles</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {retours.map(r => (
                    <tr key={r.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-3 font-mono font-medium text-slate-900">{r.return_number || '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex text-xs font-medium px-2 py-0.5 rounded-full ${
                          r.status === 'Fermé' ? 'bg-slate-100 text-slate-500' :
                          r.status === 'Ouvert' ? 'bg-blue-100 text-blue-700' :
                          'bg-amber-100 text-amber-700'
                        }`}>{r.status || '—'}</span>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell text-slate-500">{r.processing_status || '—'}</td>
                      <td className="px-4 py-3 hidden md:table-cell text-slate-500">
                        {r.contact_first_name ? `${r.contact_first_name} ${r.contact_last_name || ''}`.trim() : '—'}
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell text-slate-500">
                        {r.order_number ? `#${r.order_number}` : '—'}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-700">{r.items_count ?? 0}</td>
                      <td className="px-4 py-3 text-slate-500">{fmtDate(r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Dépenses Tab */}
        {tab === 'depenses' && (
          <div className="card overflow-hidden">
            {!depenses.length ? (
              <p className="text-center py-10 text-slate-400">Aucune dépense</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Description</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden sm:table-cell">Catégorie</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Paiement</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Date</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {depenses.map(d => (
                    <tr key={d.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-3 text-slate-900">{d.description || '—'}</td>
                      <td className="px-4 py-3 hidden sm:table-cell text-slate-500">{d.category || '—'}</td>
                      <td className="px-4 py-3 hidden md:table-cell text-slate-500">{d.payment_method || '—'}</td>
                      <td className="px-4 py-3 text-slate-500">{fmtDate(d.date_depense)}</td>
                      <td className="px-4 py-3 text-right font-medium text-slate-700">{fmtCad(d.amount_cad)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

          </div>{/* end tab content */}
        </div>{/* end flex tabs+content */}
      </div>

      {/* Task Modal */}
      {showTaskModal && (
        <Modal title={editingTask ? 'Modifier la tâche' : 'Nouvelle tâche'} onClose={() => setShowTaskModal(false)}>
          <form onSubmit={async e => {
            e.preventDefault()
            setSavingTask(true)
            try {
              if (editingTask) {
                await api.tasks.update(editingTask.id, { ...taskForm, company_id: id })
              } else {
                await api.tasks.create({ ...taskForm, company_id: id })
              }
              const r = await api.tasks.list({ company_id: id, limit: 'all' })
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
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Contact</label>
                <select value={taskForm.contact_id || ''} onChange={e => setTaskForm(f => ({ ...f, contact_id: e.target.value }))} className="select">
                  <option value="">—</option>
                  {(company.contacts || []).map(c => <option key={c.id} value={c.id}>{c.first_name} {c.last_name}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Responsable</label>
                <select value={taskForm.assigned_to || ''} onChange={e => setTaskForm(f => ({ ...f, assigned_to: e.target.value }))} className="select">
                  <option value="">—</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
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
                  const r = await api.tasks.list({ company_id: id, limit: 'all' })
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

      {/* Adresse Modal */}
      <Modal isOpen={showAdresseModal} onClose={() => setShowAdresseModal(false)} title={editingAdresse ? 'Modifier l\'adresse' : 'Ajouter une adresse'}>
        <form onSubmit={async e => {
          e.preventDefault()
          try {
            if (editingAdresse) {
              const updated = await api.adresses.update(editingAdresse.id, adresseForm)
              setAdresses(prev => prev.map(a => a.id === editingAdresse.id ? updated : a))
            } else {
              const created = await api.adresses.create({ ...adresseForm, company_id: id })
              setAdresses(prev => [...prev, created])
            }
            setShowAdresseModal(false)
          } catch (err) { alert(err.message) }
        }} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="label">Rue / Ligne 1</label>
              <input value={adresseForm.line1} onChange={e => setAdresseForm(f => ({ ...f, line1: e.target.value }))} className="input" />
            </div>
            <div>
              <label className="label">Ville</label>
              <input value={adresseForm.city} onChange={e => setAdresseForm(f => ({ ...f, city: e.target.value }))} className="input" />
            </div>
            <div>
              <label className="label">Province / État</label>
              <select value={adresseForm.province} onChange={e => setAdresseForm(f => ({ ...f, province: e.target.value }))} className="select">
                <option value="">—</option>
                {adresseForm.country === 'US' ? (
                  ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'].map(c => <option key={c} value={c}>{c}</option>)
                ) : (
                  ['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'].map(c => <option key={c} value={c}>{c}</option>)
                )}
              </select>
            </div>
            <div>
              <label className="label">Code postal</label>
              <input value={adresseForm.postal_code} onChange={e => setAdresseForm(f => ({ ...f, postal_code: e.target.value }))} className="input" />
            </div>
            <div>
              <label className="label">Pays</label>
              <select value={adresseForm.country} onChange={e => setAdresseForm(f => ({ ...f, country: e.target.value, province: '' }))} className="select">
                <option value="CA">Canada (CA)</option>
                <option value="US">États-Unis (US)</option>
              </select>
            </div>
            <div>
              <label className="label">Type</label>
              <select value={adresseForm.address_type} onChange={e => setAdresseForm(f => ({ ...f, address_type: e.target.value }))} className="select">
                {['Ferme', 'Livraison', 'Facturation'].map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label className="label">Contact associé</label>
              <select value={adresseForm.contact_id} onChange={e => setAdresseForm(f => ({ ...f, contact_id: e.target.value }))} className="select">
                <option value="">— Aucun —</option>
                {(company?.contacts || []).map(c => (
                  <option key={c.id} value={c.id}>{c.first_name} {c.last_name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setShowAdresseModal(false)} className="btn-secondary">Annuler</button>
            <button type="submit" className="btn-primary">Enregistrer</button>
          </div>
        </form>
      </Modal>

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
