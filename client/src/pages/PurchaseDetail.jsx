import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, ShoppingBag, Trash2 } from 'lucide-react'
import api from '../lib/api.js'
import { PageTitle } from '../components/PageTitle.jsx'
import Spinner from '../components/Spinner.jsx'
import { Badge, PURCHASE_STATUS_COLORS as STATUS_COLORS } from '../components/Badge.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { fmtDate } from '../lib/formatDate.js'
import { fmtCad } from '../utils/formatters.js'
import { DetailLoadError } from '../components/DetailLoadError.jsx'
import { Field } from '../components/Field.jsx'
import { CustomDetailFields } from '../components/CustomDetailFields.jsx'

const STATUS_OPTIONS = ['Commandé', 'Reçu partiellement', 'Reçu', 'Annulé']


const inp = 'w-full border border-slate-200 rounded-lg px-2 py-1 text-sm text-slate-900 focus:outline-none focus:border-brand-400 bg-white'

const SHELL_LABEL = 'text-xs font-medium text-slate-400 uppercase tracking-wide mb-0.5'

// Champ de la table `purchases` : passe par <Field>, donc par le portier des
// champs supprimés — le bloc disparaît d'ici dès qu'on supprime le champ dans
// /champs/purchases. `id` est l'identifiant du champ, pas un libellé.
function FieldShell({ id, label, saving, children }) {
  return (
    <Field table="purchases" id={id} label={label} saving={saving} labelClassName={SHELL_LABEL}>
      {children}
    </Field>
  )
}

// Valeur CALCULÉE (pas une colonne de la table) : rien à garder ni à renommer.
function DerivedShell({ label, children }) {
  return (
    <div>
      <div className={SHELL_LABEL}>{label}</div>
      {children}
    </div>
  )
}

function EditableText({ value, saving, onCommit, type = 'text' }) {
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

// `recordId` + `embedded` : monte la fiche dans un RecordPeekDrawer (side-peek)
// sans le chrome de page (Layout, bouton retour). `onClose` ferme le panneau
// après suppression du record.
export default function PurchaseDetail({ recordId, embedded = true, onClose }) {
  const { id: paramId } = useParams()
  const id = recordId ?? paramId
  const navigate = useNavigate()
  // Le cadre vient toujours du panneau latéral : une fiche ne s'affiche jamais
  // en pleine page (voir components/RecordRoutePanel.jsx).
  const shell = (content) => content
  const leaveRecord = () => { if (embedded) onClose?.(); else navigate('/purchases') }
  const { record: purchase, setRecord: setPurchase, loading, loadError, reload: load } =
    useDetailRecord(() => api.purchases.get(id), [id], { clearOnError: true })
  const [companies, setCompanies] = useState([])
  const [fieldSaving, setFieldSaving] = useState({})
  const [deleting, setDeleting] = useState(false)
  const confirm = useConfirm()
  const { addToast } = useToast()

  // Liste minimale (id + name) des entreprises pour le picker Fournisseur.
  useEffect(() => {
    api.companies.lookup().then(setCompanies).catch(() => setCompanies([]))
  }, [])

  useRealtimeChannel(id ? `purchase:${id}` : null, (msg) => {
    if (msg.type === 'purchase:updated') setPurchase(p => p ? { ...p, ...msg.payload } : p)
    else if (msg.type === 'purchase:deleted') leaveRecord()
  })

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
      leaveRecord()
    } catch (e) {
      addToast({ message: `Erreur lors de la suppression : ${e.message}`, type: 'error' })
      setDeleting(false)
    }
  }

  if (loading) {
    return shell(<Spinner center />)
  }
  if (loadError && !purchase) {
    return shell(<DetailLoadError message={loadError} onRetry={load} />)
  }
  if (!purchase) {
    return shell(<div className="p-6 text-slate-500">Achat introuvable.</div>)
  }

  const subtotal = (Number(purchase.qty_ordered) || 0) * (Number(purchase.unit_cost) || 0)

  return shell(
      <div className={embedded ? 'p-6' : 'p-6 max-w-2xl mx-auto'}>
        <div className="flex items-start gap-4 mb-6">
          {!embedded && (
            <button onClick={() => navigate(-1)} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <ShoppingBag size={20} className="text-slate-400" />
              <PageTitle>
                {purchase.reference || <span className="text-slate-400 font-normal">Sans référence</span>}
              </PageTitle>
              {purchase.status && <Badge color={STATUS_COLORS[purchase.status] || 'gray'}>{purchase.status}</Badge>}
            </div>
            {purchase.product_name && (
              <div className="text-sm text-slate-500 mt-1 flex items-center gap-1.5 flex-wrap">
                <LinkedRecordField
                  name="product_id"
                  value={purchase.product_id || purchase.product_name}
                  options={[{ id: purchase.product_id || purchase.product_name, name: purchase.product_name }]}
                  getHref={purchase.product_id ? p => `/products/${p.id}` : undefined}
                  disabled
                  allowClear={false}
                />
                {purchase.sku && <span className="font-mono text-slate-400">({purchase.sku})</span>}
              </div>
            )}
          </div>
        </div>

        <div className="card p-5 space-y-5">
          <div className="grid grid-cols-2 gap-5">
            <FieldShell id="reference" label="Référence PO" saving={fieldSaving.reference}>
              <EditableText value={purchase.reference} saving={fieldSaving.reference} onCommit={v => saveField('reference', v)} />
            </FieldShell>
            <FieldShell id="status" label="Statut" saving={fieldSaving.status}>
              <EditableSelect value={purchase.status} options={STATUS_OPTIONS} saving={fieldSaving.status} onCommit={v => saveField('status', v)} />
            </FieldShell>
            <FieldShell id="supplier" label="Fournisseur" saving={fieldSaving.supplier_company_id || fieldSaving.supplier}>
              {/* Règle FK (CLAUDE.md) : sélection (picker recherchable) ET
                  navigation (lien) — les deux dans la MÊME pastille de lien que
                  partout ailleurs, plutôt qu'une liste doublée d'un lien. */}
              <div className="space-y-1.5">
                <LinkedRecordField
                  name="supplier_company_id"
                  value={purchase.supplier_company_id || ''}
                  options={companies}
                  getHref={c => `/companies/${c.id}`}
                  saving={!!fieldSaving.supplier_company_id}
                  onChange={v => saveField('supplier_company_id', v || null)}
                />
                {!purchase.supplier_company_id && (
                  <EditableText value={purchase.supplier} saving={fieldSaving.supplier} onCommit={v => saveField('supplier', v)} />
                )}
              </div>
            </FieldShell>
            <FieldShell id="emplacement" label="Emplacement" saving={fieldSaving.emplacement}>
              <EditableText value={purchase.emplacement} saving={fieldSaving.emplacement} onCommit={v => saveField('emplacement', v)} />
            </FieldShell>
            <FieldShell id="qty_ordered" label="Qté commandée" saving={fieldSaving.qty_ordered}>
              <EditableNumber value={purchase.qty_ordered} saving={fieldSaving.qty_ordered} onCommit={v => saveField('qty_ordered', v)} />
            </FieldShell>
            <FieldShell id="qty_received" label="Qté reçue" saving={fieldSaving.qty_received}>
              <EditableNumber value={purchase.qty_received} saving={fieldSaving.qty_received} onCommit={v => saveField('qty_received', v)} />
            </FieldShell>
            <FieldShell id="unit_cost" label="Coût unitaire" saving={fieldSaving.unit_cost}>
              <EditableNumber value={purchase.unit_cost} saving={fieldSaving.unit_cost} onCommit={v => saveField('unit_cost', v)} step="0.01" />
            </FieldShell>
            <DerivedShell label="Total">
              <div className="text-sm text-slate-900 py-1">{fmtCad(subtotal)}</div>
            </DerivedShell>
            <FieldShell id="order_date" label="Date commande" saving={fieldSaving.order_date}>
              <EditableDate value={purchase.order_date} saving={fieldSaving.order_date} onCommit={v => saveField('order_date', v)} />
            </FieldShell>
            <FieldShell id="received_date" label="Date réception" saving={fieldSaving.received_date}>
              <EditableDate value={purchase.received_date} saving={fieldSaving.received_date} onCommit={v => saveField('received_date', v)} />
            </FieldShell>
            <CustomDetailFields table="purchases" record={purchase} labelClassName={SHELL_LABEL} />
          </div>
          <div className="border-t border-slate-100 pt-4">
            <FieldShell id="notes" label="Notes" saving={fieldSaving.notes}>
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
  )
}
