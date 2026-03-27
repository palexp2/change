import { useState, useEffect } from 'react'
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom'
import { ArrowLeft, ExternalLink, Plus, FileDown, Trash2, ChevronUp, ChevronDown } from 'lucide-react'
import { api } from '../lib/api.js'

async function downloadSoumissionPdf(id, filename) {
  const token = localStorage.getItem('erp_token')
  const res = await fetch(`/erp/api/documents/soumissions/${id}/pdf`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error('Erreur téléchargement PDF')
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename || `soumission-${id}.pdf`
  a.click()
  URL.revokeObjectURL(url)
}
import { Layout } from '../components/Layout.jsx'
import { Badge, projectStatusColor } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'

function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n)
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('fr-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

function fmtMoney(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

const STATUS_COLORS = {
  'Brouillon': 'gray', 'Envoyée': 'blue', 'Acceptée': 'green', 'Refusée': 'red', 'Expirée': 'orange',
}

// ── Create soumission modal ───────────────────────────────────────────────────

function blankItem() {
  return { catalog_product_id: '', description_fr: '', description_en: '', qty: 1, unit_price_cad: 0 }
}

function CreateSoumissionModal({ project, onClose, onCreated }) {
  const [catalog, setCatalog] = useState([])
  const [form, setForm] = useState({
    language: project.contact_language || 'French',
    currency: 'CAD',
    notes: '',
    discount_pct: 0,
    discount_amount: 0,
  })
  const [items, setItems] = useState([blankItem()])
  const [saving, setSaving] = useState(false)
  const [step, setStep] = useState(1)

  useEffect(() => { api.catalog.list().then(setCatalog).catch(console.error) }, [])

  const isFr = form.language !== 'English'
  const fmt = (n) => fmtMoney(n) // CAD/USD handled by currency field but fmtMoney is CAD; we'll show currency label

  const removeItem = (idx) => setItems(prev => prev.filter((_, i) => i !== idx))
  const updateItem = (idx, key, val) => setItems(prev => prev.map((it, i) => i === idx ? { ...it, [key]: val } : it))
  const moveItem = (idx, dir) => {
    setItems(prev => {
      const arr = [...prev]
      const t = idx + dir
      if (t < 0 || t >= arr.length) return arr
      ;[arr[idx], arr[t]] = [arr[t], arr[idx]]
      return arr
    })
  }
  const selectProduct = (idx, productId) => {
    const product = catalog.find(p => p.id === productId)
    if (!product) { updateItem(idx, 'catalog_product_id', ''); return }
    const price = form.currency === 'USD' ? (product.price_usd || 0) : (product.price_cad || 0)
    setItems(prev => prev.map((it, i) => i === idx ? {
      ...it, catalog_product_id: product.id,
      description_fr: product.name_fr, description_en: product.name_en,
      unit_price_cad: price,
    } : it))
  }
  const changeCurrency = (newCurrency) => {
    setForm(f => ({ ...f, currency: newCurrency }))
    setItems(prev => prev.map(it => {
      if (!it.catalog_product_id) return { ...it, unit_price_cad: 0 }
      const product = catalog.find(p => p.id === it.catalog_product_id)
      if (!product) return it
      return { ...it, unit_price_cad: newCurrency === 'USD' ? (product.price_usd || 0) : (product.price_cad || 0) }
    }))
  }

  const subtotal = items.reduce((s, it) => s + (it.qty || 1) * (it.unit_price_cad || 0), 0)
  const discPct = parseFloat(form.discount_pct) || 0
  const discAmt = parseFloat(form.discount_amount) || 0
  const totalDiscount = Math.min(subtotal, subtotal * discPct / 100 + discAmt)
  const netTotal = Math.max(0, subtotal - totalDiscount)
  const fmtP = (n) => new Intl.NumberFormat(form.currency === 'USD' ? 'en-US' : 'fr-CA', { style: 'currency', currency: form.currency }).format(n || 0)

  const inp = 'border border-slate-200 rounded px-2 py-1 text-sm focus:outline-none focus:border-indigo-400'

  const save = async () => {
    setSaving(true)
    try {
      const result = await api.documents.soumissions.create({
        ...form,
        project_id: project.id,
        company_id: project.company_id || null,
        items: items.filter(it => it.description_fr || it.description_en || it.catalog_product_id).map(it => ({
          catalog_product_id: it.catalog_product_id || null,
          qty: it.qty, unit_price_cad: it.unit_price_cad,
          description_fr: it.description_fr, description_en: it.description_en,
        })),
      })
      onCreated(result)
    } catch (e) {
      alert(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title="Nouvelle soumission" size="xl">
      <div className="flex gap-3 mb-5">
        {[{ n: 1, label: 'Informations' }, { n: 2, label: 'Articles' }].map(s => (
          <button key={s.n} onClick={() => setStep(s.n)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${step === s.n ? 'bg-indigo-100 text-indigo-700' : 'text-slate-500 hover:text-slate-700'}`}>
            {s.n}. {s.label}
          </button>
        ))}
      </div>

      {step === 1 && (
        <div className="space-y-4">
          <p className="text-sm text-slate-500">Le numéro (QTE-Z-…) et la date d'expiration (30 jours) seront générés automatiquement.</p>
          <div className="flex gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Langue du client</label>
              <select className="border rounded-lg px-3 py-2 text-sm"
                value={form.language} onChange={e => setForm(f => ({ ...f, language: e.target.value }))}>
                <option value="French">Français</option>
                <option value="English">English</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Devise</label>
              <select className="border rounded-lg px-3 py-2 text-sm font-mono font-semibold"
                value={form.currency} onChange={e => changeCurrency(e.target.value)}>
                <option value="CAD">CAD</option>
                <option value="USD">USD</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Notes</label>
            <textarea className="w-full border rounded-lg px-3 py-2 text-sm" rows={3}
              value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
          <div className="flex justify-end">
            <button onClick={() => setStep(2)} className="bg-indigo-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700">
              Suivant : Articles →
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <div className="overflow-x-auto border rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b text-xs text-slate-500">
                  <th className="px-2 py-2 text-left" style={{minWidth:200}}>Produit</th>
                  <th className="px-2 py-2 text-center" style={{width:56}}>Qté</th>
                  <th className="px-2 py-2 text-right" style={{width:110}}>Prix ({form.currency})</th>
                  <th className="px-2 py-2 text-right" style={{width:90}}>Total</th>
                  <th style={{width:56}}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, idx) => (
                  <tr key={idx} className="border-b last:border-0">
                    <td className="px-2 py-1.5">
                      <select className={`${inp} w-full`} value={it.catalog_product_id || ''}
                        onChange={e => selectProduct(idx, e.target.value)}>
                        <option value="">— Personnalisé —</option>
                        {catalog.map(p => <option key={p.id} value={p.id}>{isFr ? p.name_fr : (p.name_en || p.name_fr)}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <input type="number" min="1" className={`${inp} w-12 text-center`}
                        value={it.qty} onChange={e => updateItem(idx, 'qty', parseInt(e.target.value) || 1)} />
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-600 text-sm">
                      {fmtP(it.unit_price_cad)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono font-medium text-slate-900 text-sm">
                      {fmtP((it.qty || 1) * (it.unit_price_cad || 0))}
                    </td>
                    <td className="px-1 py-1.5">
                      <div className="flex items-center gap-0.5">
                        <button onClick={() => moveItem(idx, -1)} className="p-0.5 text-slate-300 hover:text-slate-500"><ChevronUp size={12} /></button>
                        <button onClick={() => moveItem(idx, 1)} className="p-0.5 text-slate-300 hover:text-slate-500"><ChevronDown size={12} /></button>
                        <button onClick={() => removeItem(idx)} className="p-0.5 text-slate-300 hover:text-red-500"><Trash2 size={12} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-3 py-2 border-t">
              <button onClick={() => setItems(prev => [...prev, blankItem()])}
                className="flex items-center gap-1.5 text-sm text-indigo-600 hover:text-indigo-800 font-medium">
                <Plus size={13} /> Ajouter une ligne
              </button>
            </div>
          </div>

          {/* Global discount + totals */}
          <div className="flex items-start justify-between gap-6 pt-1">
            <div className="space-y-2">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Rabais global</p>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <label className="text-xs text-slate-500">%</label>
                  <div className="relative">
                    <input type="number" min="0" max="100" step="0.1"
                      className={`${inp} w-20 text-right pr-5`}
                      value={form.discount_pct}
                      onChange={e => setForm(f => ({ ...f, discount_pct: parseFloat(e.target.value) || 0 }))} />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">%</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-xs text-slate-500">$</label>
                  <input type="number" min="0" step="0.01"
                    className={`${inp} w-28 text-right`}
                    value={form.discount_amount}
                    onChange={e => setForm(f => ({ ...f, discount_amount: parseFloat(e.target.value) || 0 }))} />
                </div>
              </div>
            </div>

            <div className="space-y-1 text-sm min-w-44">
              <div className="flex justify-between gap-4 text-slate-500">
                <span>{isFr ? 'Sous-total' : 'Subtotal'}</span>
                <span className="font-mono">{fmtP(subtotal)}</span>
              </div>
              {totalDiscount > 0 && (
                <div className="flex justify-between gap-4 text-red-500">
                  <span>{isFr ? 'Rabais' : 'Discount'}</span>
                  <span className="font-mono">-{fmtP(totalDiscount)}</span>
                </div>
              )}
              <div className="flex justify-between gap-4 font-bold text-indigo-700 border-t pt-1">
                <span>{isFr ? 'Total' : 'Total'}</span>
                <span className="font-mono">{fmtP(netTotal)}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <button onClick={() => setStep(1)} className="text-slate-500 text-sm hover:text-slate-700">← Retour</button>
            <button onClick={save} disabled={saving}
              className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
              {saving ? 'Génération du PDF…' : 'Créer et générer PDF'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ProjectDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [project, setProject] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState(location.state?.tab || 'info')
  const [soumissions, setSoumissions] = useState([])
  const [showCreate, setShowCreate] = useState(false)

  useEffect(() => {
    setLoading(true)
    api.projects.get(id)
      .then(data => setProject(data))
      .catch(() => setProject(null))
      .finally(() => setLoading(false))
  }, [id])

  const loadSoumissions = () => {
    api.documents.soumissions.list({ project_id: id, limit: 'all' })
      .then(r => setSoumissions(r.data || []))
      .catch(() => {})
  }

  useEffect(() => {
    if (tab === 'soumissions') loadSoumissions()
  }, [tab, id])

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600" />
        </div>
      </Layout>
    )
  }
  if (!project) return <Layout><div className="p-6 text-slate-500">Projet introuvable.</div></Layout>

  const TABS = [
    { key: 'info', label: 'Informations' },
    { key: 'soumissions', label: `Soumissions${soumissions.length ? ` (${soumissions.length})` : ''}` },
  ]

  return (
    <Layout>
      <div className="p-6 max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <button onClick={() => navigate('/pipeline')} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-900">{project.name}</h1>
              <Badge color={projectStatusColor(project.status)} size="md">{project.status}</Badge>
            </div>
            <div className="text-sm text-slate-500 mt-1">
              {project.company_name && project.company_id && (
                <Link to={`/companies/${project.company_id}`} className="text-indigo-600 hover:underline mr-2">
                  {project.company_name}
                </Link>
              )}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-slate-200">
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                tab === t.key ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Info Tab */}
        {tab === 'info' && (
          <div className="card p-6">
            <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-4 text-sm">
              <div>
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Type</dt>
                <dd className="text-slate-900">{project.type || '—'}</dd>
              </div>
              <div>
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Statut</dt>
                <dd><Badge color={projectStatusColor(project.status)}>{project.status}</Badge></dd>
              </div>
              <div>
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Probabilité</dt>
                <dd className="font-semibold text-slate-900">{project.probability != null ? `${project.probability}%` : '—'}</dd>
              </div>
              <div>
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Date de clôture</dt>
                <dd className="text-slate-700">{fmtDate(project.close_date)}</dd>
              </div>
              <div>
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Responsable</dt>
                <dd className="text-slate-900">{project.assigned_name || '—'}</dd>
              </div>
              {project.refusal_reason && (
                <div className="col-span-2 md:col-span-3">
                  <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Raison du refus</dt>
                  <dd className="text-slate-700">{project.refusal_reason}</dd>
                </div>
              )}
              {project.notes && (
                <div className="col-span-2 md:col-span-3">
                  <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Notes</dt>
                  <dd className="text-slate-700 whitespace-pre-wrap">{project.notes}</dd>
                </div>
              )}
            </dl>
          </div>
        )}

        {/* Soumissions Tab */}
        {tab === 'soumissions' && (
          <div>
            <div className="flex justify-end mb-3">
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700"
              >
                <Plus size={15} /> Nouvelle soumission
              </button>
            </div>

            <div className="card overflow-hidden">
              {!soumissions.length ? (
                <p className="text-center py-10 text-slate-400">Aucune soumission</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50">
                      <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Titre</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Statut</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Date</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Expiration</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500">Prix achat</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500">Prix abo</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Liens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {soumissions.map((s, i) => (
                      <tr key={s.id || i} onClick={() => navigate(`/soumissions/${s.id}`)}
                        className="border-b border-slate-100 last:border-0 hover:bg-slate-50 cursor-pointer">
                        <td className="px-4 py-3 text-slate-800 font-medium">
                          {s.title || <span className="text-slate-400 italic font-normal">Sans titre</span>}
                        </td>
                        <td className="px-4 py-3">
                          {s.status
                            ? <Badge color={STATUS_COLORS[s.status] || 'gray'}>{s.status}</Badge>
                            : <span className="text-slate-400">—</span>}
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell text-slate-500">{fmtDate(s.created_at?.slice(0, 10))}</td>
                        <td className="px-4 py-3 hidden md:table-cell text-slate-500">{fmtDate(s.expiration_date)}</td>
                        <td className="px-4 py-3 text-right font-medium text-slate-700">{fmtCad(s.purchase_price_cad)}</td>
                        <td className="px-4 py-3 text-right font-medium text-slate-700">{fmtCad(s.subscription_price_cad)}</td>
                        <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center gap-2">
                            {s.generated_pdf_path && (
                              <button
                                onClick={() => downloadSoumissionPdf(s.id, `Soumission-${s.id.slice(0,8).toUpperCase()}.pdf`).catch(e => alert(e.message))}
                                className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline px-2 py-1 bg-indigo-50 rounded">
                                <FileDown size={11} /> PDF
                              </button>
                            )}
                            {s.quote_url && (
                              <a href={s.quote_url} target="_blank" rel="noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline px-2 py-1 bg-indigo-50 rounded">
                                <ExternalLink size={11} /> Soumission
                              </a>
                            )}
                            {s.pdf_url && (
                              <a href={s.pdf_url} target="_blank" rel="noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline px-2 py-1 bg-indigo-50 rounded">
                                <ExternalLink size={11} /> PDF Airtable
                              </a>
                            )}
                            {!s.generated_pdf_path && !s.quote_url && !s.pdf_url && <span className="text-slate-400">—</span>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>

      {showCreate && (
        <CreateSoumissionModal
          project={project}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadSoumissions() }}
        />
      )}
    </Layout>
  )
}
