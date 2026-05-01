import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, ShoppingBag, Trash2 } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { fmtDate } from '../lib/formatDate.js'

const STATUS_COLORS = { 'Commandé': 'blue', 'Reçu partiellement': 'yellow', 'Reçu': 'green', 'Annulé': 'red' }
const STATUS_OPTIONS = ['Commandé', 'Reçu partiellement', 'Reçu', 'Annulé']

function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

const inp = 'w-full border border-slate-200 rounded-lg px-2 py-1 text-sm text-slate-900 focus:outline-none focus:border-brand-400 bg-white'

function FieldShell({ label, saving, children }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-0.5">
        <div className="text-xs font-medium text-slate-400 uppercase tracking-wide">{label}</div>
        {saving && <div className="h-2 w-2 rounded-full bg-brand-400 animate-pulse" title="Enregistrement…" />}
      </div>
      {children}
    </div>
  )
}

function EditableText({ value, saving, onCommit, type = 'text', placeholder }) {
  const [local, setLocal] = useState(value ?? '')
  useEffect(() => { setLocal(value ?? '') }, [value])
  const commit = () => {
    const v = local.trim ? local.trim() : local
    if ((v || '') === (value ?? '')) return
    onCommit(v === '' ? null : v)
  }
  return (
    <input
      type={type}
      className={inp}
      value={local ?? ''}
      onChange={e => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
      placeholder={placeholder}
      disabled={saving}
    />
  )
}

function EditableNumber({ value, saving, onCommit, step = '1' }) {
  const [local, setLocal] = useState(value ?? '')
  useEffect(() => { setLocal(value ?? '') }, [value])
  const commit = () => {
    const raw = String(local).trim()
    const num = raw === '' ? null : Number(raw)
    if (num !== null && Number.isNaN(num)) return
    if ((num ?? null) === (value ?? null)) return
    onCommit(num)
  }
  return (
    <input
      type="number"
      step={step}
      className={inp}
      value={local ?? ''}
      onChange={e => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
      disabled={saving}
    />
  )
}

function EditableSelect({ value, options, saving, onCommit }) {
  return (
    <select
      className={inp}
      value={value ?? ''}
      onChange={e => onCommit(e.target.value || null)}
      disabled={saving}
    >
      <option value="">—</option>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}

function EditableDate({ value, saving, onCommit }) {
  // Le backend retourne parfois une date ISO longue ; on normalise à YYYY-MM-DD pour l'input.
  const dateOnly = value ? String(value).slice(0, 10) : ''
  const [local, setLocal] = useState(dateOnly)
  useEffect(() => { setLocal(dateOnly) }, [dateOnly])
  const commit = () => {
    if ((local || '') === dateOnly) return
    onCommit(local || null)
  }
  return (
    <input
      type="date"
      className={inp}
      value={local}
      onChange={e => setLocal(e.target.value)}
      onBlur={commit}
      disabled={saving}
    />
  )
}

function EditableTextarea({ value, saving, onCommit }) {
  const [local, setLocal] = useState(value ?? '')
  useEffect(() => { setLocal(value ?? '') }, [value])
  const commit = () => {
    if ((local || '') === (value ?? '')) return
    onCommit(local || null)
  }
  return (
    <textarea
      className={inp + ' resize-y'}
      rows={3}
      value={local ?? ''}
      onChange={e => setLocal(e.target.value)}
      onBlur={commit}
      disabled={saving}
    />
  )
}

export default function PurchaseDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [purchase, setPurchase] = useState(null)
  const [loading, setLoading] = useState(true)
  const [fieldSaving, setFieldSaving] = useState({})
  const [deleting, setDeleting] = useState(false)
  const confirm = useConfirm()
  const { addToast } = useToast()

  useEffect(() => {
    api.purchases.get(id)
      .then(setPurchase)
      .catch(() => setPurchase(null))
      .finally(() => setLoading(false))
  }, [id])

  async function saveField(key, value) {
    setFieldSaving(s => ({ ...s, [key]: true }))
    try {
      const updated = await api.purchases.update(id, { [key]: value })
      setPurchase(updated)
    } catch (e) {
      addToast({ message: `Erreur : ${e.message}`, type: 'error' })
    } finally {
      setFieldSaving(s => ({ ...s, [key]: false }))
    }
  }

  async function handleDelete() {
    const label = purchase?.product_name || purchase?.reference || 'cet achat'
    if (!(await confirm(`Supprimer l'achat "${label}" ? Cette action est irréversible.`))) return
    setDeleting(true)
    try {
      await api.purchases.delete(id)
      navigate('/purchases')
    } catch (e) {
      addToast({ message: `Erreur lors de la suppression : ${e.message}`, type: 'error' })
      setDeleting(false)
    }
  }

  if (loading) {
    return <Layout><div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600" /></div></Layout>
  }
  if (!purchase) {
    return <Layout><div className="p-6 text-slate-500">Achat introuvable.</div></Layout>
  }

  const subtotal = (Number(purchase.qty_ordered) || 0) * (Number(purchase.unit_cost) || 0)

  return (
    <Layout>
      <div className="p-6 max-w-2xl mx-auto">
        <div className="flex items-start gap-4 mb-6">
          <button onClick={() => navigate(-1)} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <ShoppingBag size={20} className="text-slate-400" />
              <h1 className="text-2xl font-bold text-slate-900">
                {purchase.reference || <span className="text-slate-400 font-normal">Sans référence</span>}
              </h1>
              {purchase.status && <Badge color={STATUS_COLORS[purchase.status] || 'gray'}>{purchase.status}</Badge>}
            </div>
            {purchase.product_name && (
              <div className="text-sm text-slate-500 mt-1">
                {purchase.product_id
                  ? <Link to={`/products/${purchase.product_id}`} className="text-brand-600 hover:underline">{purchase.product_name}</Link>
                  : purchase.product_name
                }
                {purchase.sku && <span className="ml-1 font-mono text-slate-400">({purchase.sku})</span>}
              </div>
            )}
          </div>
        </div>

        <div className="card p-5 space-y-5">
          <div className="grid grid-cols-2 gap-5">
            <FieldShell label="Référence PO" saving={fieldSaving.reference}>
              <EditableText value={purchase.reference} saving={fieldSaving.reference} onCommit={v => saveField('reference', v)} placeholder="PO-…" />
            </FieldShell>
            <FieldShell label="Statut" saving={fieldSaving.status}>
              <EditableSelect value={purchase.status} options={STATUS_OPTIONS} saving={fieldSaving.status} onCommit={v => saveField('status', v)} />
            </FieldShell>
            <FieldShell label="Fournisseur" saving={fieldSaving.supplier}>
              {purchase.supplier_company_id ? (
                <div className="text-sm">
                  <Link to={`/companies/${purchase.supplier_company_id}`} className="text-brand-600 hover:underline">
                    {purchase.supplier_company_name || purchase.supplier}
                  </Link>
                </div>
              ) : (
                <EditableText value={purchase.supplier} saving={fieldSaving.supplier} onCommit={v => saveField('supplier', v)} />
              )}
            </FieldShell>
            <FieldShell label="Emplacement" saving={fieldSaving.emplacement}>
              <EditableText value={purchase.emplacement} saving={fieldSaving.emplacement} onCommit={v => saveField('emplacement', v)} />
            </FieldShell>
            <FieldShell label="Qté commandée" saving={fieldSaving.qty_ordered}>
              <EditableNumber value={purchase.qty_ordered} saving={fieldSaving.qty_ordered} onCommit={v => saveField('qty_ordered', v)} />
            </FieldShell>
            <FieldShell label="Qté reçue" saving={fieldSaving.qty_received}>
              <EditableNumber value={purchase.qty_received} saving={fieldSaving.qty_received} onCommit={v => saveField('qty_received', v)} />
            </FieldShell>
            <FieldShell label="Coût unitaire" saving={fieldSaving.unit_cost}>
              <EditableNumber value={purchase.unit_cost} saving={fieldSaving.unit_cost} onCommit={v => saveField('unit_cost', v)} step="0.01" />
            </FieldShell>
            <FieldShell label="Total">
              <div className="text-sm text-slate-900 py-1">{fmtCad(subtotal)}</div>
            </FieldShell>
            <FieldShell label="Date commande" saving={fieldSaving.order_date}>
              <EditableDate value={purchase.order_date} saving={fieldSaving.order_date} onCommit={v => saveField('order_date', v)} />
            </FieldShell>
            <FieldShell label="Date prévue" saving={fieldSaving.expected_date}>
              <EditableDate value={purchase.expected_date} saving={fieldSaving.expected_date} onCommit={v => saveField('expected_date', v)} />
            </FieldShell>
            <FieldShell label="Date réception" saving={fieldSaving.received_date}>
              <EditableDate value={purchase.received_date} saving={fieldSaving.received_date} onCommit={v => saveField('received_date', v)} />
            </FieldShell>
          </div>
          <div className="border-t border-slate-100 pt-4">
            <FieldShell label="Notes" saving={fieldSaving.notes}>
              <EditableTextarea value={purchase.notes} saving={fieldSaving.notes} onCommit={v => saveField('notes', v)} />
            </FieldShell>
          </div>
          <div className="border-t border-slate-100 pt-4 flex gap-8 text-xs text-slate-400">
            {purchase.created_at && <span>Créé le {fmtDate(purchase.created_at)}</span>}
            {purchase.updated_at && <span>Mis à jour le {fmtDate(purchase.updated_at)}</span>}
          </div>
        </div>

        <div className="flex justify-start mt-5">
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="flex items-center gap-1.5 text-sm text-red-500 hover:text-red-700 hover:underline disabled:opacity-50"
          >
            <Trash2 size={14} />
            {deleting ? 'Suppression…' : 'Supprimer cet achat'}
          </button>
        </div>
      </div>
    </Layout>
  )
}
