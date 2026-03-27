import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, FileDown, Copy, Trash2, Pencil, Check, X, Plus, ChevronUp, ChevronDown, ExternalLink } from 'lucide-react'
import { api } from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'

function fmtPrice(n, currency = 'CAD') {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat(currency === 'USD' ? 'en-US' : 'fr-CA', { style: 'currency', currency }).format(n)
}
function fmtDate(d) {
  if (!d) return '—'
  return new Date(d + (d.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('fr-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

const STATUS_COLORS = {
  'Brouillon': 'gray', 'Envoyée': 'blue', 'Acceptée': 'green', 'Refusée': 'red', 'Expirée': 'orange',
}
const STATUSES = Object.keys(STATUS_COLORS)

async function downloadPdf(id, title) {
  const token = localStorage.getItem('erp_token')
  const res = await fetch(`/erp/api/documents/soumissions/${id}/pdf`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error('Erreur téléchargement PDF')
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${title || 'Soumission'}.pdf`
  a.click()
  URL.revokeObjectURL(url)
}

function blankItem() {
  return { catalog_product_id: '', description_fr: '', description_en: '', qty: 1, unit_price_cad: 0 }
}

export default function SoumissionDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [soumission, setSoumission] = useState(null)
  const [catalog, setCatalog] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({})
  const [items, setItems] = useState([])
  const [saving, setSaving] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [pdfLoading, setPdfLoading] = useState(false)

  const load = async () => {
    try {
      const data = await api.documents.soumissions.get(id)
      setSoumission(data)
      setForm({
        language: data.language || 'French',
        currency: data.currency || 'CAD',
        status: data.status || 'Brouillon',
        notes: data.notes || '',
        discount_pct: data.discount_pct || 0,
        discount_amount: data.discount_amount || 0,
        discount_valid_until: data.discount_valid_until || '',
      })
      setItems((data.items || []).map(it => ({ ...it })))
    } catch {
      setSoumission(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])
  useEffect(() => { if (editing) api.catalog.list().then(setCatalog).catch(console.error) }, [editing])

  const isDraft = soumission?.status === 'Brouillon' && !soumission?.airtable_id
  const isFr = (editing ? form.language : soumission?.language) !== 'English'
  const currency = editing ? form.currency : (soumission?.currency || 'CAD')
  const fmt = (n) => fmtPrice(n, currency)

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  // When currency changes, re-apply prices from catalog
  const changeCurrency = (newCurrency) => {
    setForm(f => ({ ...f, currency: newCurrency }))
    setItems(prev => prev.map(it => {
      if (!it.catalog_product_id) return { ...it, unit_price_cad: 0 }
      const product = catalog.find(p => p.id === it.catalog_product_id)
      if (!product) return it
      return { ...it, unit_price_cad: newCurrency === 'USD' ? (product.price_usd || 0) : (product.price_cad || 0) }
    }))
  }

  const save = async () => {
    setSaving(true)
    try {
      await api.documents.soumissions.update(id, { ...form, items })
      setEditing(false)
      load()
    } catch (e) {
      alert(e.message)
    } finally {
      setSaving(false)
    }
  }

  const cancelEdit = () => {
    setForm({
      language: soumission.language || 'French',
      currency: soumission.currency || 'CAD',
      status: soumission.status || 'Brouillon',
      notes: soumission.notes || '',
      discount_pct: soumission.discount_pct || 0,
      discount_amount: soumission.discount_amount || 0,
      discount_valid_until: soumission.discount_valid_until || '',
    })
    setItems((soumission.items || []).map(it => ({ ...it })))
    setEditing(false)
  }

  const duplicate = async () => {
    setDuplicating(true)
    try {
      const copy = await api.documents.soumissions.duplicate(id)
      navigate(`/soumissions/${copy.id}`)
    } catch (e) {
      alert(e.message)
    } finally {
      setDuplicating(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm('Supprimer cette soumission ?')) return
    setDeleting(true)
    try {
      await api.documents.soumissions.delete(id)
      if (soumission.project_id) navigate(`/projects/${soumission.project_id}`, { state: { tab: 'soumissions' } })
      else navigate(-1)
    } catch (e) {
      alert(e.message)
      setDeleting(false)
    }
  }

  const handleDownload = async () => {
    setPdfLoading(true)
    try {
      const title = soumission.language === 'English'
        ? `Quote-${soumission.id.slice(0, 8).toUpperCase()}`
        : `Soumission-${soumission.id.slice(0, 8).toUpperCase()}`
      await downloadPdf(id, title)
    } catch (e) {
      alert(e.message)
    } finally {
      setPdfLoading(false)
    }
  }

  // Items helpers
  const addLine = () => setItems(prev => [...prev, blankItem()])
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
    const cur = form.currency || 'CAD'
    if (!product) {
      updateItem(idx, 'catalog_product_id', '')
      return
    }
    setItems(prev => prev.map((it, i) => i === idx ? {
      ...it,
      catalog_product_id: product.id,
      description_fr: product.name_fr,
      description_en: product.name_en,
      unit_price_cad: cur === 'USD' ? (product.price_usd || 0) : (product.price_cad || 0),
    } : it))
  }

  const subtotal = items.reduce((s, it) => s + (it.qty || 1) * (it.unit_price_cad || 0), 0)
  const discPct = parseFloat(form.discount_pct) || 0
  const discAmt = parseFloat(form.discount_amount) || 0
  const totalDiscount = editing
    ? Math.min(subtotal, subtotal * discPct / 100 + discAmt)
    : Math.min(subtotal, subtotal * (soumission?.discount_pct || 0) / 100 + (soumission?.discount_amount || 0))
  const netTotal = Math.max(0, subtotal - totalDiscount)

  const inp = 'border border-slate-200 rounded px-2 py-1 text-sm focus:outline-none focus:border-indigo-400 bg-white'

  if (loading) return <Layout><div className="p-8 text-center text-slate-400">Chargement…</div></Layout>
  if (!soumission) return <Layout><div className="p-8 text-center text-slate-500">Soumission introuvable.</div></Layout>

  const goBack = () => {
    if (soumission.project_id) navigate(`/projects/${soumission.project_id}`, { state: { tab: 'soumissions' } })
    else navigate(-1)
  }

  return (
    <Layout>
      <div className="max-w-5xl mx-auto px-4 py-6">

        {/* Top bar */}
        <div className="flex items-center justify-between mb-6">
          <button onClick={goBack} className="flex items-center gap-2 text-slate-500 hover:text-slate-700 text-sm">
            <ArrowLeft size={16} />
            {soumission.project_name ? `Projet : ${soumission.project_name}` : 'Retour'}
          </button>

          <div className="flex items-center gap-2">
            {!editing && isDraft && (
              <button onClick={() => setEditing(true)}
                className="flex items-center gap-1.5 border border-slate-200 text-slate-600 px-3 py-2 rounded-lg text-sm hover:bg-slate-50">
                <Pencil size={14} /> Éditer
              </button>
            )}
            {editing && (
              <>
                <button onClick={cancelEdit}
                  className="flex items-center gap-1.5 border border-slate-200 text-slate-600 px-3 py-2 rounded-lg text-sm hover:bg-slate-50">
                  <X size={14} /> Annuler
                </button>
                <button onClick={save} disabled={saving}
                  className="flex items-center gap-1.5 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                  <Check size={14} /> {saving ? 'Sauvegarde…' : 'Sauvegarder et regénérer PDF'}
                </button>
              </>
            )}
            {!editing && (
              <>
                <button onClick={duplicate} disabled={duplicating}
                  className="flex items-center gap-1.5 border border-slate-200 text-slate-600 px-3 py-2 rounded-lg text-sm hover:bg-slate-50">
                  <Copy size={14} /> {duplicating ? 'Copie…' : 'Dupliquer'}
                </button>
                {soumission.generated_pdf_path && (
                  <button onClick={handleDownload} disabled={pdfLoading}
                    className="flex items-center gap-1.5 border border-indigo-200 text-indigo-600 px-3 py-2 rounded-lg text-sm hover:bg-indigo-50">
                    <FileDown size={14} /> {pdfLoading ? 'Chargement…' : 'PDF'}
                  </button>
                )}
                {isDraft && (
                  <button onClick={handleDelete} disabled={deleting}
                    className="flex items-center gap-1.5 border border-red-200 text-red-500 px-3 py-2 rounded-lg text-sm hover:bg-red-50">
                    <Trash2 size={14} />
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Header card */}
        <div className="bg-white rounded-xl border shadow-sm p-6 mb-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <h1 className="text-2xl font-bold text-slate-900 mb-1">
                {soumission.title || <span className="text-slate-400 italic font-normal">Sans titre</span>}
              </h1>
              {soumission.company_name && (
                <Link to={`/companies/${soumission.company_id}`} className="text-indigo-600 hover:underline text-sm">
                  {soumission.company_name}
                </Link>
              )}
            </div>
            <div className="flex flex-col items-end gap-2 flex-shrink-0">
              {editing ? (
                <select className={`${inp}`} value={form.status} onChange={e => set('status', e.target.value)}>
                  {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : (
                <Badge color={STATUS_COLORS[soumission.status] || 'gray'}>{soumission.status || 'Brouillon'}</Badge>
              )}
              <div className="flex items-center gap-2">
                {editing ? (
                  <select className={`${inp}`} value={form.language} onChange={e => set('language', e.target.value)}>
                    <option value="French">Français</option>
                    <option value="English">English</option>
                  </select>
                ) : (
                  <span className="text-xs text-slate-500">{soumission.language === 'English' ? 'English' : 'Français'}</span>
                )}
                {editing ? (
                  <select className={`${inp} font-mono font-semibold`} value={form.currency} onChange={e => changeCurrency(e.target.value)}>
                    <option value="CAD">CAD</option>
                    <option value="USD">USD</option>
                  </select>
                ) : (
                  <span className="text-xs font-mono font-semibold text-slate-600 bg-slate-100 px-2 py-0.5 rounded">
                    {soumission.currency || 'CAD'}
                  </span>
                )}
              </div>
              {soumission.airtable_id && <span className="text-xs text-blue-400">Airtable</span>}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 mt-5 pt-4 border-t text-sm">
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-wider mb-0.5">Créée le</p>
              <p className="text-slate-700">{fmtDate(soumission.created_at)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-wider mb-0.5">Expiration</p>
              <p className="text-slate-700">{fmtDate(soumission.expiration_date)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-wider mb-0.5">Projet</p>
              <p className="text-slate-700">{soumission.project_name || '—'}</p>
            </div>
          </div>

          {(editing || soumission.notes) && (
            <div className="mt-4 pt-4 border-t">
              <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Notes</p>
              {editing ? (
                <textarea className="w-full border rounded-lg px-3 py-2 text-sm" rows={3}
                  value={form.notes} onChange={e => set('notes', e.target.value)} />
              ) : (
                <p className="text-sm text-slate-600 whitespace-pre-wrap">{soumission.notes}</p>
              )}
            </div>
          )}
        </div>

        {/* Items */}
        <div className="bg-white rounded-xl border shadow-sm overflow-hidden mb-5">
          <div className="px-4 py-3 border-b bg-slate-50">
            <h2 className="font-semibold text-slate-700 text-sm">Articles</h2>
          </div>

          {editing ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-slate-500 bg-slate-50">
                    <th className="px-3 py-2 text-left" style={{minWidth:200}}>Produit</th>
                    <th className="px-3 py-2 text-center" style={{width:64}}>Qté</th>
                    <th className="px-3 py-2 text-right" style={{width:110}}>Prix ({form.currency || 'CAD'})</th>
                    <th className="px-3 py-2 text-right" style={{width:100}}>Total</th>
                    <th style={{width:60}}></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, idx) => (
                    <tr key={idx} className="border-b last:border-0 hover:bg-slate-50/50">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          <select className={`${inp} flex-1 min-w-0`} value={it.catalog_product_id || ''}
                            onChange={e => selectProduct(idx, e.target.value)}>
                            <option value="">— Personnalisé —</option>
                            {catalog.map(p => (
                              <option key={p.id} value={p.id}>{isFr ? p.name_fr : (p.name_en || p.name_fr)}</option>
                            ))}
                          </select>
                          {it.catalog_product_id && (
                            <Link to={`/products/${it.catalog_product_id}`} target="_blank"
                              className="flex-shrink-0 text-slate-400 hover:text-indigo-600 p-0.5">
                              <ExternalLink size={13} />
                            </Link>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" min="1" className={`${inp} w-14 text-center`}
                          value={it.qty} onChange={e => updateItem(idx, 'qty', parseInt(e.target.value) || 1)} />
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600 text-sm">
                        {fmt(it.unit_price_cad || 0)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-medium text-slate-900">
                        {fmt((it.qty || 1) * (it.unit_price_cad || 0))}
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-0.5">
                          <button onClick={() => moveItem(idx, -1)} className="p-0.5 text-slate-300 hover:text-slate-500"><ChevronUp size={13} /></button>
                          <button onClick={() => moveItem(idx, 1)} className="p-0.5 text-slate-300 hover:text-slate-500"><ChevronDown size={13} /></button>
                          <button onClick={() => removeItem(idx)} className="p-0.5 text-slate-300 hover:text-red-500 ml-0.5"><Trash2 size={13} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="px-3 py-2 border-t">
                <button onClick={addLine}
                  className="flex items-center gap-1.5 text-sm text-indigo-600 hover:text-indigo-800 font-medium">
                  <Plus size={14} /> Ajouter une ligne
                </button>
              </div>

              {/* Discount + totals */}
              <div className="border-t px-4 py-4 bg-slate-50">
                <div className="flex items-start justify-between gap-8">
                  {/* Discount inputs */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Rabais global</p>
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex items-center gap-1.5">
                        <label className="text-xs text-slate-500 whitespace-nowrap">Rabais %</label>
                        <div className="relative">
                          <input type="number" min="0" max="100" step="0.1"
                            className={`${inp} w-20 text-right pr-5`}
                            value={form.discount_pct}
                            onChange={e => set('discount_pct', parseFloat(e.target.value) || 0)} />
                          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">%</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <label className="text-xs text-slate-500 whitespace-nowrap">Rabais $</label>
                        <input type="number" min="0" step="0.01"
                          className={`${inp} w-28 text-right`}
                          value={form.discount_amount}
                          onChange={e => set('discount_amount', parseFloat(e.target.value) || 0)} />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <label className="text-xs text-slate-500 whitespace-nowrap">Valide jusqu'au</label>
                        <input type="date"
                          className={`${inp} w-36`}
                          value={form.discount_valid_until}
                          onChange={e => set('discount_valid_until', e.target.value)} />
                      </div>
                    </div>
                  </div>

                  {/* Totals */}
                  <div className="space-y-1 text-sm min-w-48">
                    <div className="flex justify-between gap-6 text-slate-500">
                      <span>Sous-total</span>
                      <span className="font-mono">{fmt(subtotal)}</span>
                    </div>
                    {totalDiscount > 0 && (
                      <div className="flex justify-between gap-6 text-red-500">
                        <span>
                          Rabais
                          {discPct > 0 && ` ${discPct}%`}
                          {discPct > 0 && discAmt > 0 && ' +'}
                          {discAmt > 0 && ` ${fmt(discAmt)}`}
                        </span>
                        <span className="font-mono">-{fmt(totalDiscount)}</span>
                      </div>
                    )}
                    <div className="flex justify-between gap-6 font-bold text-indigo-700 pt-1 border-t border-slate-200">
                      <span>Total (avant taxes)</span>
                      <span className="font-mono">{fmt(netTotal)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

          ) : (
            items.length === 0 ? (
              <p className="text-center py-8 text-slate-400 text-sm">Aucun article</p>
            ) : (
              <>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-slate-500">
                      <th className="px-4 py-2 text-left">Produit</th>
                      <th className="px-4 py-2 text-center w-16">Qté</th>
                      <th className="px-4 py-2 text-right w-32">Prix ({soumission.currency || 'CAD'})</th>
                      <th className="px-4 py-2 text-right w-28">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, idx) => (
                      <tr key={idx} className="border-b last:border-0">
                        <td className="px-4 py-2.5">
                          {it.catalog_product_id ? (
                            <Link to={`/products/${it.catalog_product_id}`} target="_blank"
                              className="text-slate-800 hover:text-indigo-600 hover:underline inline-flex items-center gap-1">
                              {isFr ? (it.name_fr || it.description_fr) : (it.name_en || it.name_fr || it.description_en)}
                              <ExternalLink size={11} className="opacity-40" />
                            </Link>
                          ) : (
                            <span className="text-slate-800">
                              {isFr ? (it.name_fr || it.description_fr) : (it.name_en || it.name_fr || it.description_en)}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-center text-slate-600">{it.qty}</td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{fmt(it.unit_price_cad)}</td>
                        <td className="px-4 py-2.5 text-right font-mono font-medium text-slate-900">
                          {fmt((it.qty || 1) * (it.unit_price_cad || 0))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-50">
                      <td colSpan={3} className="px-4 py-2 text-right text-slate-500">Sous-total</td>
                      <td className="px-4 py-2 text-right font-mono text-slate-700">{fmt(subtotal)}</td>
                    </tr>
                    {totalDiscount > 0 && (
                      <tr className="bg-slate-50">
                        <td colSpan={3} className="px-4 py-2 text-right text-red-500">
                          Rabais
                          {(soumission.discount_pct || 0) > 0 && ` ${soumission.discount_pct}%`}
                          {(soumission.discount_pct || 0) > 0 && (soumission.discount_amount || 0) > 0 && ' +'}
                          {(soumission.discount_amount || 0) > 0 && ` ${fmt(soumission.discount_amount)}`}
                          {soumission.discount_valid_until && (
                            <span className="text-xs text-red-400 ml-1">(valide jusqu'au {fmtDate(soumission.discount_valid_until)})</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-red-500">-{fmt(totalDiscount)}</td>
                      </tr>
                    )}
                    <tr className="bg-indigo-50">
                      <td colSpan={3} className="px-4 py-3 text-right font-semibold text-slate-700">Total (avant taxes)</td>
                      <td className="px-4 py-3 text-right font-bold font-mono text-indigo-700">{fmt(netTotal)}</td>
                    </tr>
                  </tfoot>
                </table>
              </>
            )
          )}
        </div>

        {/* PDF section */}
        {!editing && (
          <div className="bg-white rounded-xl border shadow-sm p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-slate-700 text-sm">Document PDF</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  {soumission.generated_pdf_path ? 'PDF généré — cliquez pour télécharger' : 'Aucun PDF généré'}
                </p>
              </div>
              {soumission.generated_pdf_path && (
                <button onClick={handleDownload} disabled={pdfLoading}
                  className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                  <FileDown size={15} /> {pdfLoading ? 'Chargement…' : 'Télécharger'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </Layout>
  )
}
