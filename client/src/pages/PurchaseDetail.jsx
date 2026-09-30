import { useState, useEffect } from 'react'
import { ShoppingBag, Trash2 } from 'lucide-react'
import api from '../lib/api.js'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { useRecordDeleteAllowed } from '../lib/detailFieldLayout.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { DetailFieldGrid, DetailField } from '../components/DetailFieldGrid.jsx'
import ExpenseLineLinks, { fmtUnitPrice } from '../components/ExpenseLineLinks.jsx'
import { useFieldOverrides } from '../lib/fieldOverrides.jsx'
import { InlineDate } from '../components/InlineFields.jsx'

const inp = 'w-full border border-slate-200 rounded-lg px-2 py-1 text-sm text-slate-900 focus:outline-none focus:border-brand-400 bg-white'

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

// EditableDate / EditableTextarea retirés avec les champs qu'ils servaient
// (dates de commande et de réception, notes) — colonnes droppées, migration 035.
// EditableNumber est parti avec « Qté reçue » (036) : le seul champ natif
// éditable qui reste est un texte.

// Fournisseur = le champ lié synchronisé avec Airtable (le même que la liste),
// posé d'office dans la carte.
const SHOWN_SYNCED = ['fournisseur']
const RECEIVED_KEY = 'cf_date_de_reception_complete'

// `onClose` ferme le panneau après suppression du record.
export default function PurchaseDetail({ recordId: id, onClose }) {
  const leaveRecord = () => onClose?.()
  // « Suppression permise » : case du mode de personnalisation de la fiche.
  const canDelete = useRecordDeleteAllowed('purchases')
  const { record: purchase, setRecord: setPurchase, loading, loadError, reload: load } =
    useDetailRecord(() => api.purchases.get(id), [id], { clearOnError: true })
  const [expense, setExpense] = useState(null)
  const [fieldSaving, setFieldSaving] = useState({})
  const [deleting, setDeleting] = useState(false)
  const confirm = useConfirm()
  const { addToast } = useToast()
  // Décimales de « Prix payé » : réglage du champ dans la liste des achats.
  const { overrides } = useFieldOverrides('purchases')
  const invoiceLinked = !!(expense?.lines?.length || expense?.airtable_links?.length)
  const paidDecimals = overrides.get('unit_price_paid_cad')?.decimals ?? 2

  // Lignes de facture fournisseur reliées + prix unitaire payé.
  useEffect(() => {
    setExpense(null)
    if (id) api.purchases.expenseLines(id).then(r => setExpense(r?.[id] || null)).catch(() => {})
  }, [id])

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
    const label = purchase?.at_id || 'cet achat'
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

  const pending = detailPending({ loading, loadError, onRetry: load, record: purchase, notFound: 'Achat introuvable.' })
  if (pending) return pending

  return (
      <DetailShell
        header={{
          leading: <ShoppingBag size={20} className="text-slate-400 mt-0.5" />,
          // La pièce achetée ne figure plus en en-tête : le lien vers le produit
          // a été droppé (migration 035). Reste le code LIA du record Airtable.
          meta: purchase.at_id && <span className="font-mono text-slate-400">{purchase.at_id}</span>,
        }}
      >
        <div className="card p-5 space-y-5">
          {/* Carte de champs commune : ordre, retrait et ajout d'un champ de la
              table se règlent depuis la fiche (bouton « Personnaliser les
              champs »). Les champs personnalisés de /champs/purchases s'y
              posent seuls — d'où `record`.
              Référence PO, quantité commandée, coût unitaire, total, dates et
              notes : colonnes droppées sur demande (migration 035), « Qté
              reçue » à son tour (036). */}
          <DetailFieldGrid entityType="purchases" record={purchase} onSaveCustom={saveField} savingKeys={fieldSaving} shownSynced={SHOWN_SYNCED} className="" testId="purchase-fields">
            {/* Réception complète : seulement une fois la facture liée. */}
            <DetailField id={RECEIVED_KEY} label="Date de réception complète" saving={fieldSaving[RECEIVED_KEY]}>
              {invoiceLinked
                ? <InlineDate value={purchase[RECEIVED_KEY]} saving={fieldSaving[RECEIVED_KEY]} onSave={v => saveField(RECEIVED_KEY, v)} testId="purchase-received-date" />
                : (
                  <span className="text-sm text-slate-400" title="Liez d'abord la facture" data-testid="purchase-received-date-locked">
                    {purchase[RECEIVED_KEY] ? fmtDate(purchase[RECEIVED_KEY]) : 'Facture non liée'}
                  </span>
                )}
            </DetailField>
            <DetailField id="emplacement" label="Emplacement" saving={fieldSaving.emplacement}>
              <EditableText value={purchase.emplacement} saving={fieldSaving.emplacement} onCommit={v => saveField('emplacement', v)} />
            </DetailField>
          </DetailFieldGrid>
          <div className="grid grid-cols-2 gap-4 text-sm" data-testid="purchase-expense-lines">
            <div>
              <div className="text-xs text-slate-400 mb-1">Factures</div>
              <ExpenseLineLinks info={expense} />
            </div>
            <div>
              <div className="text-xs text-slate-400 mb-1">Prix payé</div>
              <span className="tabular-nums">{fmtUnitPrice(expense?.unit_price_paid_cad, paidDecimals)}</span>
            </div>
          </div>
          <div className="border-t border-slate-100 pt-4 flex gap-8 text-xs text-slate-400">
            {purchase.created_at && <span>Créé le {fmtDate(purchase.created_at)}</span>}
            {purchase.updated_at && <span>Mis à jour le {fmtDate(purchase.updated_at)}</span>}
          </div>
        </div>

        {canDelete && (
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
        )}
      </DetailShell>
  )
}
