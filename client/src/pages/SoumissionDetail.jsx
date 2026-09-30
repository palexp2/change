import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { ArrowLeft, Copy, Trash2, Check, Plus, ChevronUp, ChevronDown, PackagePlus, Mail } from 'lucide-react'
import { api } from '../lib/api.js'
import { PageTitle } from '../components/PageTitle.jsx'
import { Badge, SOUMISSION_STATUS_COLORS as STATUS_COLORS } from '../components/Badge.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import AttachmentPreview from '../components/AttachmentPreview.jsx'
import SoumissionSendModal from '../components/SoumissionSendModal.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { fmtDate } from '../lib/formatDate.js'
import { purchasePct } from '../lib/soumissionDiscount.js'

import { fmtMoney } from '../utils/formatters.js'
import { DetailFieldGrid, DetailField } from '../components/DetailFieldGrid.jsx'
import { InlineTextarea } from '../components/InlineFields.jsx'

const fmtPrice = (n, currency = 'CAD') => fmtMoney(n, currency, { locale: currency === 'USD' ? 'en-US' : 'fr-CA' })

// Statuts sélectionnables : explicites, car la map partagée contient aussi
// 'legacy' (soumissions importées d'Airtable) qui ne doit pas être proposé.
const STATUSES = ['Brouillon', 'Envoyée', 'Acceptée', 'Refusée', 'Expirée']

function blankItem() {
  return { catalog_product_id: '', description_fr: '', description_en: '', qty: 1, unit_price_cad: 0, unit_monthly_price: 0 }
}

export default function SoumissionDetail({ recordId, onClose }) {
  const id = recordId
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [catalog, setCatalog] = useState([])
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({})
  const [items, setItems] = useState([])
  const [saving, setSaving] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [sending, setSending] = useState(false)
  const saveTimerRef = useRef(null)
  const skipSaveRef = useRef(true)
  const confirm = useConfirm()
  const { addToast } = useToast()

  // Le record principal passe par le hook ; le formulaire d'édition et les
  // items sont dérivés de la même réponse, posés au passage.
  const { record: soumission, setRecord: setSoumission, loading, loadError, reload: load } =
    useDetailRecord(async () => {
      const data = await api.documents.soumissions.get(id)
      skipSaveRef.current = true
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
      return data
    }, [id], { clearOnError: true })

  useEffect(() => { if (editing) api.catalog.list().then(setCatalog).catch(console.error) }, [editing])

  useRealtimeChannel(id ? `soumission:${id}` : null, (msg) => {
    if (msg.type === 'soumission:updated') setSoumission(s => s ? { ...s, ...msg.payload } : s)
    else if (msg.type === 'soumission:deleted') onClose?.()
  })

  const isDraft = soumission?.status === 'Brouillon' && !soumission?.airtable_id
  const isFr = (editing ? form.language : soumission?.language) !== 'English'
  const currency = editing ? form.currency : (soumission?.currency || 'CAD')
  const fmt = (n) => fmtPrice(n, currency)

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  // When currency changes, re-apply prices from catalog
  const changeCurrency = (newCurrency) => {
    setForm(f => ({ ...f, currency: newCurrency }))
    setItems(prev => prev.map(it => {
      if (!it.catalog_product_id) return { ...it, unit_price_cad: 0, unit_monthly_price: 0 }
      const product = catalog.find(p => p.id === it.catalog_product_id)
      if (!product) return it
      const usd = newCurrency === 'USD'
      return {
        ...it,
        unit_price_cad: (usd ? product.price_usd : product.price_cad) || 0,
        unit_monthly_price: (usd ? product.monthly_price_usd : product.monthly_price_cad) || 0,
      }
    }))
  }

  const doSave = async (nextForm, nextItems) => {
    setSaving(true)
    try {
      await api.documents.soumissions.update(id, { ...nextForm, items: nextItems })
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  // Autosave debounce — fires 500ms after last edit while editing mode is on
  useEffect(() => {
    if (!editing || skipSaveRef.current) {
      skipSaveRef.current = false
      return
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => doSave(form, items), 500)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, items])

  // Notes modifiables sur place, hors mode édition. `discount_valid_until`
  // est renvoyé tel quel : la route l'écrase sinon.
  const [notesSaving, setNotesSaving] = useState(false)
  const saveNotes = async (notes) => {
    setNotesSaving(true)
    try {
      const updated = await api.documents.soumissions.update(id, { notes, discount_valid_until: soumission.discount_valid_until || null })
      setSoumission(s => s ? { ...s, ...updated } : s)
      setForm(f => ({ ...f, notes }))
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setNotesSaving(false)
    }
  }

  const closeEdit = async () => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    await doSave(form, items)
    setEditing(false)
    load()
  }

  const duplicate = async () => {
    setDuplicating(true)
    try {
      const copy = await api.documents.soumissions.duplicate(id)
      // La copie s'ouvre dans l'éditeur ; sans projet, l'éditeur n'a rien à charger.
      const pid = copy.project_id || soumission.project_id
      navigate(pid ? `/soumissions/nouvelle?projet=${pid}&soumission=${copy.id}` : `/soumissions/${copy.id}`)
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setDuplicating(false)
    }
  }

  const handleDelete = async () => {
    if (!(await confirm('Supprimer cette soumission ?'))) return
    setDeleting(true)
    try {
      await api.documents.soumissions.delete(id)
      // La fiche supprimée n'a plus rien à montrer. Ouverte depuis son projet,
      // on referme le panneau et le projet reste dessous ; ouverte par sa propre
      // adresse (lien, fil d'activité), elle cède la place à son projet.
      const pid = soumission.project_id
      if (pid && (!onClose || pathname.startsWith('/soumissions/'))) {
        navigate(`/projects/${pid}`, { replace: !!onClose, state: { tab: 'soumissions' } })
      } else if (onClose) onClose()
      else navigate('/pipeline')
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
      setDeleting(false)
    }
  }

  const pdfTitle = soumission
    ? `${soumission.language === 'English' ? 'Quote' : 'Soumission'}-${String(soumission.id).slice(0, 8).toUpperCase()}`
    : 'Soumission'

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
      unit_monthly_price: (cur === 'USD' ? product.monthly_price_usd : product.monthly_price_cad) || 0,
    } : it))
  }

  const discPct = parseFloat(form.discount_pct) || 0
  // Rabais nommés (modale de création) : une ligne chacun.
  const discountList = (() => {
    try { const l = JSON.parse(soumission?.discounts || 'null'); return Array.isArray(l) && l.length ? l : null } catch { return null }
  })()
  // Deux offres par soumission : achat unique et location mensuelle. Même règle
  // que le PDF (serveur, discountTotals) : un % et un montant par colonne
  // (le % d'achat retombe sur celui de l'abonnement s'il manque).
  const monthlyOf = it => (it.qty || 1) * (it.unit_monthly_price || 0)
  const purchaseOf = it => (it.qty || 1) * (it.unit_price_cad || 0)
  const monthlySubtotal = items.reduce((s, it) => s + monthlyOf(it), 0)
  const purchaseSubtotal = items.reduce((s, it) => s + purchaseOf(it), 0)
  const globalPct = editing ? discPct : (soumission?.discount_pct || 0)
  const globalAmount = editing ? (parseFloat(form.discount_amount) || 0) : (soumission?.discount_amount || 0)
  const discounts = (!editing && discountList)
    || (globalPct || globalAmount ? [{ name: `Rabais${globalPct ? ` ${globalPct}%` : ''}`, pct: globalPct, amount: globalAmount, global: true }] : [])
  const discountLines = discounts.map(d => ({
    name: d.name,
    global: d.global,
    until: d.until,
    monthly: monthlySubtotal * (d.pct || 0) / 100 + (d.monthly || 0),
    amount: purchaseSubtotal * purchasePct(d) / 100 + (d.amount || 0),
  })).filter(d => d.monthly > 0 || d.amount > 0)
  const netMonthly = Math.max(0, monthlySubtotal - discountLines.reduce((t, d) => t + d.monthly, 0))
  const netPurchase = Math.max(0, purchaseSubtotal - discountLines.reduce((t, d) => t + d.amount, 0))
  // `extra` : colonne d'actions du mode édition.
  const priceHead = extra => (
    <>
      <tr className="text-xs text-slate-500">
        <th rowSpan={2} className="px-3 py-2 text-left align-bottom">Produit</th>
        <th rowSpan={2} className="px-3 py-2 text-center align-bottom w-14">Qté</th>
        <th colSpan={2} className="px-3 pt-2 text-center border-l">Achat ({currency || 'CAD'})</th>
        <th colSpan={2} className="px-3 pt-2 text-center border-l">Location / mois</th>
        {extra && <th rowSpan={2} style={{width:60}}></th>}
      </tr>
      <tr className="border-b text-[11px] text-slate-400">
        <th className="px-3 pb-1.5 text-right font-normal border-l">Prix</th>
        <th className="px-3 pb-1.5 text-right font-normal">Total</th>
        <th className="px-3 pb-1.5 text-right font-normal border-l">Prix</th>
        <th className="px-3 pb-1.5 text-right font-normal">Total</th>
      </tr>
    </>
  )
  const priceCells = it => (
    <>
      <td className="px-3 py-2 text-right font-mono text-slate-600 border-l">{fmt(it.unit_price_cad || 0)}</td>
      <td className="px-3 py-2 text-right font-mono font-medium text-slate-900">{fmt(purchaseOf(it))}</td>
      <td className="px-3 py-2 text-right font-mono text-slate-600 border-l">{fmt(it.unit_monthly_price || 0)}</td>
      <td className="px-3 py-2 text-right font-mono font-medium text-slate-900">{fmt(monthlyOf(it))}</td>
    </>
  )
  const totalsFoot = extra => (
    <tfoot>
      <tr className="bg-slate-50 border-t">
        <td colSpan={2} className="px-3 py-2 text-right text-slate-500">Sous-total</td>
        <td colSpan={2} className="px-3 py-2 text-right font-mono text-slate-700 border-l">{fmt(purchaseSubtotal)}</td>
        <td colSpan={2} className="px-3 py-2 text-right font-mono text-slate-700 border-l">{fmt(monthlySubtotal)}</td>
        {extra && <td />}
      </tr>
      {discountLines.map((d, i) => (
        <tr key={i} className="bg-slate-50 text-red-500">
          <td colSpan={2} className="px-3 py-2 text-right">
            {d.name}
            {d.global && !editing && soumission?.discount_valid_until && (
              <span className="text-xs text-red-400 ml-1">(→ {fmtDate(soumission.discount_valid_until)})</span>
            )}
            {d.until && <span className="text-xs text-red-400 ml-1">(→ {fmtDate(d.until)})</span>}
          </td>
          <td colSpan={2} className="px-3 py-2 text-right font-mono border-l">{d.amount > 0 ? `-${fmt(d.amount)}` : ''}</td>
          <td colSpan={2} className="px-3 py-2 text-right font-mono border-l">{d.monthly > 0 ? `-${fmt(d.monthly)}` : ''}</td>
          {extra && <td />}
        </tr>
      ))}
      <tr className="bg-brand-50">
        <td colSpan={2} className="px-3 py-3 text-right font-semibold text-slate-700">Total (avant taxes)</td>
        <td colSpan={2} className="px-3 py-3 text-right font-bold font-mono text-brand-700 border-l">{fmt(netPurchase)}</td>
        <td colSpan={2} className="px-3 py-3 text-right font-bold font-mono text-brand-700 border-l">{fmt(netMonthly)} / mois</td>
        {extra && <td />}
      </tr>
    </tfoot>
  )

  const inp = 'border border-slate-200 rounded px-2 py-1 text-sm focus:outline-none focus:border-brand-400 bg-white'

  const pending = detailPending({ loading, loadError, onRetry: load, record: soumission, notFound: 'Soumission introuvable.' })
  if (pending) return pending

  return (
    <DetailShell className="px-4 py-6">

        {/* Top bar */}
        <div className="flex items-center justify-between mb-6">
          {soumission.project_id ? (
            <Link to={`/projects/${soumission.project_id}`} state={{ tab: 'soumissions' }}
              className="flex items-center gap-2 text-slate-500 hover:text-slate-700 text-sm">
              <ArrowLeft size={16} />
              {soumission.project_name ? `Projet : ${soumission.project_name}` : 'Projet'}
            </Link>
          ) : <div />}

          <div className="flex items-center gap-2">
            {editing && (
              <>
                <span className="text-xs text-slate-400">{saving ? 'Sauvegarde…' : 'Sauvegardé'}</span>
                <button onClick={closeEdit}
                  className="flex items-center gap-1.5 bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700">
                  <Check size={14} /> Fermer
                </button>
              </>
            )}
            {!editing && (
              <>
                {soumission.converted_order && (
                  <Link to={`/orders/${soumission.converted_order.id}`}
                    className="flex items-center gap-1.5 border border-green-200 bg-green-50 text-green-700 px-3 py-2 rounded-lg text-sm hover:bg-green-100">
                    <PackagePlus size={14} /> Commande #{soumission.converted_order.order_number}
                  </Link>
                )}
                <button onClick={() => setSending(true)} data-testid="soumission-send"
                  className="flex items-center gap-1.5 bg-brand-600 text-white px-3 py-2 rounded-lg text-sm font-medium hover:bg-brand-700">
                  <Mail size={14} /> Envoyer
                </button>
                <button onClick={duplicate} disabled={duplicating}
                  className="flex items-center gap-1.5 border border-slate-200 text-slate-600 px-3 py-2 rounded-lg text-sm hover:bg-slate-50">
                  <Copy size={14} /> {duplicating ? 'Copie…' : 'Dupliquer'}
                </button>
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
              <PageTitle className="mb-1">
                {soumission.title || <span className="text-slate-400 italic font-normal">Sans titre</span>}
              </PageTitle>
              {soumission.company_name && (
                <LinkedRecordField
                  name="company_id"
                  value={soumission.company_id || soumission.company_name}
                  options={[{ id: soumission.company_id || soumission.company_name, name: soumission.company_name }]}
                  getHref={soumission.company_id ? c => `/companies/${c.id}` : undefined}
                  disabled
                  allowClear={false}
                />
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

          {/* Carte de champs commune : une seule liste, réordonnable et
              masquable depuis la fiche (bouton « Personnaliser les champs »).
              Les champs personnalisés de la table s'y posent seuls. */}
          <DetailFieldGrid
            entityType="soumissions"
            record={soumission}
            className="mt-5 pt-4 border-t"
            testId="soumission-fields"
          >
            <DetailField id="created_at" label="Créée le">
              <p className="text-sm text-slate-700">{fmtDate(soumission.created_at)}</p>
            </DetailField>
            <DetailField id="expiration_date" label="Expiration">
              <p className="text-sm text-slate-700">{fmtDate(soumission.expiration_date)}</p>
            </DetailField>
            <DetailField id="project_name" label="Projet">
              {soumission.project_id
                ? <LinkedRecordField
                  name="project_id"
                  value={soumission.project_id}
                  options={[{ id: soumission.project_id, name: soumission.project_name || 'Projet' }]}
                  getHref={p => `/projects/${p.id}`}
                  disabled
                  allowClear={false}
                />
                : <p className="text-sm text-slate-700">{soumission.project_name || '—'}</p>}
            </DetailField>
            <DetailField id="notes" label="Notes" span2>
              {editing ? (
                <textarea className="input" rows={3}
                  value={form.notes} onChange={e => set('notes', e.target.value)} />
              ) : !soumission.airtable_id ? (
                <InlineTextarea value={soumission.notes} saving={notesSaving} onSave={saveNotes} testId="soumission-notes" />
              ) : (
                <p className="text-sm text-slate-600 whitespace-pre-wrap">{soumission.notes || '—'}</p>
              )}
            </DetailField>
          </DetailFieldGrid>
        </div>

        {/* Items */}
        <div className="bg-white rounded-xl border shadow-sm overflow-hidden mb-5">
          <div className="px-4 py-3 border-b bg-slate-50">
            <h2 className="font-semibold text-slate-700 text-sm">Articles</h2>
          </div>

          {editing ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">{priceHead(true)}</thead>
                <tbody>
                  {items.map((it, idx) => (
                    <tr key={idx} className="border-b last:border-0 hover:bg-slate-50/50">
                      <td className="px-3 py-2" style={{minWidth:200}}>
                        <LinkedRecordField
                          name={`soumission_item_${idx}`}
                          value={it.catalog_product_id || ''}
                          options={catalog}
                          labelFn={p => isFr ? p.name_fr : (p.name_en || p.name_fr)}
                          getHref={p => `/products/${p.id}`}
                          onChange={v => selectProduct(idx, v)}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" min="1" className={`${inp} w-14 text-center`}
                          value={it.qty} onChange={e => updateItem(idx, 'qty', parseInt(e.target.value) || 1)} />
                      </td>
                      {priceCells(it)}
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
                {totalsFoot(true)}
              </table>

              <div className="px-3 py-2 border-t">
                <button onClick={addLine}
                  className="flex items-center gap-1.5 text-sm text-brand-600 hover:text-brand-800 font-medium">
                  <Plus size={14} /> Ajouter une ligne
                </button>
              </div>

              {/* Rabais global (totaux dans le pied du tableau) */}
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
                </div>
              </div>
            </div>

          ) : (
            items.length === 0 ? (
              <p className="text-center py-8 text-slate-400 text-sm">Aucun article</p>
            ) : (
              <>
                <table className="w-full text-sm">
                  <thead>{priceHead(false)}</thead>
                  <tbody>
                    {items.map((it, idx) => (
                      <tr key={idx} className="border-b last:border-0">
                        <td className="px-3 py-2.5">
                          <span className="text-slate-800">
                            {isFr ? (it.name_fr || it.description_fr) : (it.name_en || it.name_fr || it.description_en)}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-center text-slate-600">{it.qty}</td>
                        {priceCells(it)}
                      </tr>
                    ))}
                  </tbody>
                  {totalsFoot(false)}
                </table>
              </>
            )
          )}
        </div>

        {/* PDF section */}
        {!editing && (
          <div className="bg-white rounded-xl border shadow-sm p-5">
            <h2 className="font-semibold text-slate-700 text-sm mb-3">Document PDF</h2>
            {/* Le serveur produit le PDF à la demande : rendu local, ou pièce
                jointe relue dans Airtable pour une soumission synchronisée. */}
            {soumission.generated_pdf_path || soumission.pdf_url || !soumission.airtable_id ? (
              <AttachmentPreview
                url={`${api.documents.soumissions.pdfUrl(id)}?v=${encodeURIComponent(soumission.updated_at || '')}`}
                kind="pdf"
                title={pdfTitle}
                fileName={`${pdfTitle}.pdf`}
                size="md"
                testId="soumission-pdf"
              />
            ) : (
              <p className="text-xs text-slate-400">Aucun PDF</p>
            )}
          </div>
        )}
      <SoumissionSendModal soumissionId={id} isOpen={sending} onClose={() => setSending(false)} onSent={() => load()} />
    </DetailShell>
  )
}
