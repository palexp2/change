import { useState } from 'react'
import { ExternalLink, Plus, Trash2 } from 'lucide-react'
import api from '../lib/api.js'
import { InlineText, InlineUrl, InlineNumber, InlineTextarea } from '../components/InlineFields.jsx'
import ErrorBanner from '../components/ErrorBanner.jsx'
import ImageSlot from '../components/ImageSlot.jsx'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { Modal } from '../components/Modal.jsx'
import { RecordForm } from '../components/RecordForm.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { Field } from '../components/Field.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { fmtMoney, fmtNumber } from '../utils/formatters.js'

// Fiche d'une fourniture (miroir Airtable « Fournitures ») : tous ses champs se
// modifient sur place (réécrits dans Airtable), de même que les cellules de
// l'historique de ses achats (miroir « Achats fournitures »).
const DASH = <span className="text-slate-300">—</span>
const money = n => fmtMoney(n, 'CAD', { fallback: DASH })

const HISTORY_COLUMNS = [
  { id: 'purchased_at', label: 'Date',          field: 'purchased_at', type: 'date', editable: true, render: r => fmtDate(r.purchased_at) },
  { id: 'qty',          label: 'Quantité',      field: 'qty',          type: 'number', editable: true, render: r => fmtNumber(r.qty, { fallback: DASH }) },
  { id: 'unit_price',   label: 'Prix unitaire', field: 'unit_price',   type: 'number', editable: true, render: r => money(r.unit_price) },
  { id: 'total',        label: 'Total av. tx.', field: 'total',        type: 'number', render: r => <span className="font-medium">{money(r.total)}</span> },
]

// Champs que POST /api/fournitures/achats sait créer ; la fourniture est celle de la fiche.
const achatFields = f => [
  { field: 'purchased_at', label: 'Date',       type: 'date', locked: true, required: true, defaultValue: new Date().toISOString().slice(0, 10) },
  { field: 'qty',          label: 'Quantité',   type: 'number', min: 0, step: 'any', required: true, defaultValue: 1 },
  { field: 'unit_price',   label: 'Prix unit.', type: 'currency', min: 0, step: '0.01', defaultValue: f.reference_price ?? '' },
]

const byDateDesc = (a, b) => String(b.purchased_at || '').localeCompare(String(a.purchased_at || ''))

// `id` = champ de la table : bloc gardé par le portier (supprimé → masqué,
// renommé → libellé de l'utilisateur). Sans `id` : valeur calculée.
function Info({ id, label, children, span2 }) {
  const value = <div className="text-sm text-slate-900 mt-0.5">{children ?? DASH}</div>
  const cls = span2 ? 'col-span-2' : ''
  if (id) return <Field table="fournitures" id={id} label={label} className={cls} labelClassName="text-xs text-slate-500">{value}</Field>
  return (
    <div className={cls}>
      <div className="text-xs text-slate-500">{label}</div>
      {value}
    </div>
  )
}

export default function FournitureDetail({ recordId: id, onClose, onChanged }) {
  const { record: f, setRecord, loading, loadError, reload } = useDetailRecord(() => api.fournitures.get(id), [id], { clearOnError: true })
  const [saving, setSaving] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [showAchat, setShowAchat] = useState(false)
  const confirm = useConfirm()

  // Autosave au blur : écrit dans Airtable puis ici.
  async function save(field, value) {
    setSaving(field); setSaveError(null)
    try { const next = await api.fournitures.update(id, { [field]: value }); setRecord(r => ({ ...r, ...next })); onChanged?.({ fourniture: next }) }
    catch (e) { setSaveError(e.message) }
    finally { setSaving(null) }
  }

  async function saveImage(call) {
    setSaving('image'); setSaveError(null)
    try { const next = await call(); setRecord(r => ({ ...r, ...next })); onChanged?.({ fourniture: next }) }
    catch (e) { setSaveError(e.message) }
    finally { setSaving(null) }
  }

  async function saveAchat(row, col, value) {
    setSaveError(null)
    try {
      const next = await api.fournitures.updateAchat(row.id, { [col.field]: value })
      const total = Math.round((next.qty || 0) * (next.unit_price || 0) * 100) / 100
      setRecord(r => ({
        ...r,
        achats: r.achats
          .map(a => (a.id === row.id ? { ...a, ...next, total } : a))
          .sort(byDateDesc),
      }))
      onChanged?.({ achat: { ...next, total } })
    } catch (e) { setSaveError(e.message); throw e }
  }

  async function createAchat(form) {
    const next = await api.fournitures.createAchat({ ...form, fourniture_id: id })
    const achat = { ...next, total: Math.round((next.qty || 0) * (next.unit_price || 0) * 100) / 100 }
    setRecord(r => ({ ...r, achats: [achat, ...(r.achats || [])].sort(byDateDesc) }))
    onChanged?.({ created: achat })
  }

  // Suppression définitive (Airtable compris) : ses achats restent, sans fourniture.
  async function remove() {
    if (!(await confirm(`Supprimer « ${f.name || 'cette fourniture'} » ?`))) return
    setSaveError(null)
    try { await api.fournitures.delete(id); onChanged?.({ deleted: id }); onClose?.() }
    catch (e) { setSaveError(e.message) }
  }

  const pending = detailPending({ loading, loadError, onRetry: reload, record: f, notFound: 'Fourniture introuvable.' })
  if (pending) return pending

  const achats = f.achats || []
  const spent = achats.reduce((s, a) => s + (a.total || 0), 0)
  const inline = field => ({ value: f[field], saving: saving === field, onSave: v => save(field, v), testId: `fourniture-${field}` })

  return (
    <DetailShell
      header={{
        leading: (
          <ImageSlot testId="fourniture-image" src={f.image_url} alt={f.name || ''} size="w-16 h-16"
            busy={saving === 'image'} onPick={file => saveImage(() => api.fournitures.uploadImage(id, file))}
            onRemove={() => saveImage(() => api.fournitures.deleteImage(id))} />
        ),
        actions: (
          <>
            {f.web_url && (
              <a href={f.web_url} target="_blank" rel="noreferrer" data-testid="fourniture-buy" className="btn-primary inline-flex items-center gap-1.5">
                <ExternalLink size={14} /> Acheter
              </a>
            )}
            <button type="button" onClick={remove} data-testid="fourniture-delete"
              className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
              title="Supprimer" aria-label="Supprimer la fourniture">
              <Trash2 size={16} />
            </button>
          </>
        ),
      }}
    >
      {saveError && <ErrorBanner>{saveError}</ErrorBanner>}
      <div className="card p-5 grid grid-cols-2 gap-4">
        <Info id="name" label="Nom" span2><InlineText {...inline('name')} required /></Info>
        <Info id="supplier" label="Fournisseur"><InlineText {...inline('supplier')} /></Info>
        <Info id="unit" label="Unité"><InlineText {...inline('unit')} /></Info>
        <Info label="Lien d'achat" span2><InlineUrl {...inline('web_url')} /></Info>
        <Info id="reference_price" label="Prix de réf."><InlineNumber {...inline('reference_price')} min={0} step="0.01" suffix="$" /></Info>
        <Info id="last_purchased_at" label="Dernier achat">{achats[0]?.purchased_at ? fmtDate(achats[0].purchased_at) : null}</Info>
        <Info label="Total dépensé">{achats.length ? money(spent) : null}</Info>
        <Info label="Notes" span2><InlineTextarea {...inline('notes')} /></Info>
      </div>

      <div className="mt-6 mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">
          Achats <span className="text-xs font-normal text-slate-400">({achats.length})</span>
        </h2>
        <button type="button" onClick={() => setShowAchat(true)} data-testid="fourniture-new-achat" className="btn-primary inline-flex items-center gap-1.5">
          <Plus size={14} /> Nouvel achat
        </button>
      </div>
      <Modal isOpen={showAchat} onClose={() => setShowAchat(false)} title="Nouvel achat">
        <RecordForm
          table="achats_fournitures" fields={achatFields(f)} columns={2}
          onSubmit={createAchat}
          onClose={() => setShowAchat(false)}
          submitLabel="Ajouter" savingLabel="Ajout…"
        />
      </Modal>
      <DataTable
        table="fourniture_achats"
        columns={HISTORY_COLUMNS}
        data={achats}
        onCellEdit={saveAchat}
        height={`${Math.min(520, Math.max(160, 44 + achats.length * 32))}px`}
      />
    </DetailShell>
  )
}
