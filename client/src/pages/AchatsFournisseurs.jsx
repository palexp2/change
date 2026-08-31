import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { X, BookOpen, Plus, ShoppingCart, ExternalLink } from 'lucide-react'
import { api } from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { VendorTabs } from '../components/VendorTabs.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import RecordPeekDrawer from '../components/RecordPeekDrawer.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { useEntityListRealtime } from '../lib/useRealtimeChannel.js'
import { VendorSelect } from '../components/VendorSelect.jsx'
import { LineItemsTable } from '../components/LineItemsTable.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { fmtDate, localISODate } from '../lib/formatDate.js'
import { fmtCad, formatBytes } from '../utils/formatters.js'

const NO_TAX = '__none__'

const STATUS_COLORS = {
  'Brouillon': 'gray',
  'Soumis': 'blue',
  'Approuvé': 'green',
  'Refusé': 'red',
  'Remboursé': 'purple',
  'Reçue': 'blue',
  'Approuvée': 'indigo',
  'Payée partiellement': 'yellow',
  'Payée': 'green',
  'En retard': 'red',
  'Annulée': 'gray',
}

const BILL_STATUS = ['Brouillon', 'Reçue', 'Approuvée', 'Payée partiellement', 'Payée', 'En retard', 'Annulée']
const PURCHASE_STATUS = ['Brouillon', 'Soumis', 'Approuvé', 'Refusé', 'Remboursé']
const CATEGORIES = ['Fournitures', 'Voyage', 'Repas', 'Loyer', 'Assurance', 'Services', 'Équipement', 'Marketing', 'Logiciels', 'Autre']
const PAYMENT_METHODS = ['Carte de crédit', 'Chèque', 'Virement', 'Comptant', 'Autre']

const RENDERS = {
  type: row => row.type === 'bill'
    ? <Badge color="indigo">Facture</Badge>
    : <Badge color="slate">Dépense</Badge>,
  vendor: row => row.vendor_id
    ? <Link to={`/companies/${row.vendor_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.vendor}</Link>
    : <span>{row.vendor || <span className="text-slate-400">—</span>}</span>,
  date_achat: row => <span className="text-slate-500">{fmtDate(row.date_achat)}</span>,
  due_date: row => {
    if (!row.due_date) return <span className="text-slate-400">—</span>
    const overdue = row.status !== 'Payée' && row.status !== 'Annulée' && new Date(row.due_date) < new Date()
    return <span className={overdue ? 'text-red-600 font-medium' : 'text-slate-500'}>{fmtDate(row.due_date)}</span>
  },
  status: row => <Badge color={STATUS_COLORS[row.status] || 'gray'}>{row.status}</Badge>,
  total_cad: row => <span className="font-medium tabular-nums">{fmtCad(row.total_cad)}</span>,
  amount_paid_cad: row => <span className="text-slate-400 tabular-nums">{fmtCad(row.amount_paid_cad)}</span>,
  balance_due_cad: row => {
    const v = row.balance_due_cad ?? (row.total_cad - row.amount_paid_cad)
    return <span className={v > 0 ? 'text-red-600 font-medium tabular-nums' : 'text-green-600 tabular-nums'}>{fmtCad(v)}</span>
  },
  qb: row => row.qb_url
    ? <a href={row.qb_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
        className="inline-flex items-center gap-1 text-brand-600 hover:underline" title="Ouvrir dans QuickBooks">
        <ExternalLink size={12} /> #{row.quickbooks_id}
      </a>
    : <span className="text-slate-400">—</span>,
}

const COLUMNS = TABLE_COLUMN_META.achats_fournisseurs.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

function emptyForm(type) {
  const today = localISODate()
  return type === 'bill'
    ? { type: 'bill', date_achat: today, due_date: '', vendor: '', vendor_id: null, vendor_invoice_number: '', bill_number: '', category: '', amount_cad: '', tax_cad: '', amount_paid_cad: '', status: 'Reçue', notes: '' }
    : { type: 'purchase', date_achat: today, vendor: '', vendor_id: null, reference: '', description: '', category: '', payment_method: '', amount_cad: '', tax_cad: '', status: 'Brouillon', notes: '' }
}

function AchatModal({ achat, initialType, onClose, onSaved }) {
  const [form, setForm] = useState(achat
    ? { ...achat, amount_cad: achat.amount_cad ?? '', tax_cad: achat.tax_cad ?? '', amount_paid_cad: achat.amount_paid_cad ?? '' }
    : emptyForm(initialType))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const isBill = form.type === 'bill'
  const f = (k) => (e) => setForm(p => ({ ...p, [k]: e.target.value }))

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const amt = parseFloat(form.amount_cad) || 0
      const tax = parseFloat(form.tax_cad) || 0
      const payload = {
        ...form,
        amount_cad: amt,
        tax_cad: tax,
        total_cad: amt + tax,
        amount_paid_cad: parseFloat(form.amount_paid_cad) || 0,
        vendor_id: form.vendor_id || null,
      }
      if (achat) await api.achatsFournisseurs.update(achat.id, payload)
      else       await api.achatsFournisseurs.create(payload)
      onSaved()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <p className="text-red-600 text-sm">{error}</p>}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Fournisseur {isBill && '*'}</label>
          <VendorSelect
            value={form.vendor || ''}
            vendorId={form.vendor_id}
            onChange={({ vendor, vendor_id }) => setForm(p => ({ ...p, vendor, vendor_id }))}
            required={isBill}
          />
        </div>
        <div>
          <label className="label">Statut</label>
          <select value={form.status} onChange={f('status')} className="input">
            {(isBill ? BILL_STATUS : PURCHASE_STATUS).map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {isBill ? (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label"># Facture (interne)</label>
            <input type="text" value={form.bill_number || ''} onChange={f('bill_number')} className="input" />
          </div>
          <div>
            <label className="label"># Facture fournisseur</label>
            <input type="text" value={form.vendor_invoice_number || ''} onChange={f('vendor_invoice_number')} className="input" />
          </div>
        </div>
      ) : (
        <div>
          <label className="label">Description *</label>
          <input type="text" value={form.description || ''} onChange={f('description')} className="input" required />
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Date *</label>
          <input type="date" value={form.date_achat} onChange={f('date_achat')} className="input" required />
        </div>
        {isBill ? (
          <div>
            <label className="label">Date d'échéance</label>
            <input type="date" value={form.due_date || ''} onChange={f('due_date')} className="input" />
          </div>
        ) : (
          <div>
            <label className="label">Référence</label>
            <input type="text" value={form.reference || ''} onChange={f('reference')} className="input" />
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Catégorie</label>
          <select value={form.category || ''} onChange={f('category')} className="input">
            <option value="">— Choisir —</option>
            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        {!isBill && (
          <div>
            <label className="label">Mode de paiement</label>
            <select value={form.payment_method || ''} onChange={f('payment_method')} className="input">
              <option value="">— Choisir —</option>
              {PAYMENT_METHODS.map(m => <option key={m}>{m}</option>)}
            </select>
          </div>
        )}
      </div>

      <div className={`grid ${isBill ? 'grid-cols-3' : 'grid-cols-2'} gap-4`}>
        <div>
          <label className="label">Montant avant taxes</label>
          <input type="number" step="0.01" min="0" value={form.amount_cad} onChange={f('amount_cad')} className="input" />
        </div>
        <div>
          <label className="label">Taxes (CAD)</label>
          <input type="number" step="0.01" min="0" value={form.tax_cad} onChange={f('tax_cad')} className="input" />
        </div>
        {isBill && (
          <div>
            <label className="label">Montant payé</label>
            <input type="number" step="0.01" min="0" value={form.amount_paid_cad} onChange={f('amount_paid_cad')} className="input" />
          </div>
        )}
      </div>

      <div>
        <label className="label">Notes</label>
        <textarea value={form.notes || ''} onChange={f('notes')} className="input" rows={2} />
      </div>

      <LineItemsTable lines={form.lines} />

      {achat?.id && (
        <AchatAccountingSection achat={achat} form={form} setForm={setForm} onSaved={onSaved} />
      )}

      {achat?.id && achat?.quickbooks_id && (
        <QBAttachmentsSection achatId={achat.id} />
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>
    </form>
  )
}

// Comptabilisation QuickBooks d'un achat : choix mémorisé par fournisseur (compte de
// dépense, compte de paiement, code de taxe), pré-rempli depuis le dernier achat publié
// du même vendor. Chaque champ s'autosauvegarde (règle autosave). Le type (dépense/
// facture) est intrinsèque à l'achat — pas repris de l'historique. Le code de taxe
// n'est PAS auto-rempli depuis l'historique (déduction par achat conservée).
function AchatAccountingSection({ achat, form, setForm, onSaved }) {
  const { addToast } = useToast()
  const confirm = useConfirm()
  const [accounts, setAccounts] = useState([])
  const [taxCodes, setTaxCodes] = useState([])
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [savingField, setSavingField] = useState(null)
  const [error, setError] = useState('')
  // Champ signalé par la validation serveur — la section fautive est encadrée en rouge.
  const [errorField, setErrorField] = useState(null)
  const fieldFrame = f => (errorField === f ? 'ring-2 ring-red-400 rounded-lg bg-red-50 p-2 -m-2' : '')
  const [pushing, setPushing] = useState(false)
  const [autoAppliedFrom, setAutoAppliedFrom] = useState(null)

  const autoAppliedRef = useRef(false)
  const userTouchedRef = useRef(false)

  const isPurchase = form.type === 'purchase'
  const published = !!achat.quickbooks_id

  useEffect(() => {
    let cancelled = false
    Promise.all([api.quickbooks.accounts(), api.quickbooks.taxCodes()])
      .then(([accs, codes]) => {
        if (cancelled) return
        setAccounts(accs || [])
        setTaxCodes(codes || [])
      })
      .catch(() => { if (!cancelled) setError('Impossible de charger les comptes QuickBooks') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    api.achatsFournisseurs.vendorHistory(achat.id)
      .then(r => { if (!cancelled) setHistory(r.data || []) })
      .catch(() => { if (!cancelled) setHistory([]) })
    return () => { cancelled = true }
  }, [achat.id])

  // Autosave d'un champ comptable (+ maintien du form parent en phase pour que le
  // bouton « Enregistrer » ne réécrase pas la valeur autosauvegardée).
  const saveField = useCallback(async (key, value) => {
    setForm(p => ({ ...p, [key]: value }))
    setSavingField(key)
    setError('')
    try {
      await api.achatsFournisseurs.update(achat.id, { [key]: value })
    } catch (e) {
      setError(e.message)
    } finally {
      setSavingField(null)
    }
  }, [achat.id, setForm])

  // Pré-remplissage auto depuis le dernier achat publié du même fournisseur — une fois,
  // jamais sur un achat déjà publié, jamais après édition manuelle, uniquement les
  // champs encore vides. Le code de taxe est volontairement exclu.
  useEffect(() => {
    if (loading || autoAppliedRef.current || userTouchedRef.current || published) return
    if (history.length === 0) return
    const txn = history.find(t => t.expense_account_id || t.payment_account_id)
    if (!txn) return
    const patch = {}
    if (!form.expense_account_id && txn.expense_account_id) patch.expense_account_id = txn.expense_account_id
    if (isPurchase && !form.payment_account_id && txn.payment_account_id) patch.payment_account_id = txn.payment_account_id
    if (Object.keys(patch).length === 0) return
    autoAppliedRef.current = true
    setAutoAppliedFrom(txn)
    setForm(p => ({ ...p, ...patch }))
    // Persiste le pré-remplissage pour qu'il survive sans clic « Enregistrer ».
    api.achatsFournisseurs.update(achat.id, patch).catch(e => setError(e.message || 'Échec de la sauvegarde du pré-remplissage'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, history])

  const onChangeField = key => value => { userTouchedRef.current = true; saveField(key, value === NO_TAX ? null : value) }

  async function handlePush() {
    const label = isPurchase ? 'une dépense' : 'une facture'
    const ok = await confirm({
      title: 'Comptabiliser sur QuickBooks',
      message: `Cette action crée ${label} dans QuickBooks pour ${fmtCad(form.total_cad ?? (parseFloat(form.amount_cad) || 0) + (parseFloat(form.tax_cad) || 0))} (fournisseur « ${form.vendor || '—'} »). Continuer ?`,
      confirmLabel: 'Comptabiliser',
    })
    if (!ok) return
    setPushing(true)
    setError('')
    setErrorField(null)
    try {
      await api.achatsFournisseurs.pushToQb(achat.id)
      addToast({ message: 'Achat comptabilisé sur QuickBooks.', type: 'success' })
      onSaved()
    } catch (e) {
      setError(e.message)
      setErrorField(e.details?.field || null)
    } finally {
      setPushing(false)
    }
  }

  const expenseAccounts = accounts.filter(a => ['Expense', 'Other Expense', 'Cost of Goods Sold', 'Other Current Asset'].includes(a.AccountType))
  const paymentAccounts = accounts.filter(a => ['Bank', 'Credit Card'].includes(a.AccountType))
  const accountLabel = a => (a.AcctNum ? `${a.AcctNum} — ${a.Name}` : a.Name)
  const expenseOptions = expenseAccounts.map(a => ({ value: a.Id, label: accountLabel(a) }))
  const paymentOptions = paymentAccounts.map(a => ({ value: a.Id, label: `${accountLabel(a)} (${a.AccountType})` }))
  const taxCodeOptions = [{ value: NO_TAX, label: '— Aucune taxe —' }, ...taxCodes.map(c => ({ value: c.Id, label: c.Name }))]

  return (
    <div className="border border-green-200 bg-green-50 rounded-xl p-4 space-y-3" data-testid="achat-accounting">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Comptabilisation QuickBooks</h3>
        {published && (
          achat.qb_url ? (
            <a href={achat.qb_url} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-green-700 hover:underline" title="Ouvrir dans QuickBooks">
              <BookOpen size={12} /> Publié (#{achat.quickbooks_id}) <ExternalLink size={11} />
            </a>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-green-700"><BookOpen size={12} /> Publié (#{achat.quickbooks_id})</span>
          )
        )}
      </div>

      {loading ? (
        <p className="text-xs text-slate-400">Chargement des comptes QuickBooks…</p>
      ) : (
        <>
          {autoAppliedFrom && !userTouchedRef.current && (
            <p data-testid="achat-prefill-note" className="text-[11px] text-brand-700 bg-brand-50 border border-brand-100 rounded px-2 py-1 leading-snug">
              Pré-rempli depuis la dernière compta de ce fournisseur{autoAppliedFrom.date_achat ? ` — ${fmtDate(autoAppliedFrom.date_achat)}` : ''}.
            </p>
          )}

          <div className={fieldFrame('expense_account')}>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">
              Compte de dépense{savingField === 'expense_account_id' && <span className="ml-2 text-slate-400 normal-case">enregistrement…</span>}
            </label>
            <SearchableSelect
              testId="achat-expense-select"
              value={form.expense_account_id || ''}
              options={expenseOptions}
              onChange={onChangeField('expense_account_id')}
              placeholder="— Sélectionner —"
            />
          </div>

          {isPurchase && (
            <div className={fieldFrame('payment_account')}>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">
                Compte de paiement{savingField === 'payment_account_id' && <span className="ml-2 text-slate-400 normal-case">enregistrement…</span>}
              </label>
              <SearchableSelect
                testId="achat-payment-select"
                value={form.payment_account_id || ''}
                options={paymentOptions}
                onChange={onChangeField('payment_account_id')}
                placeholder="— Sélectionner —"
              />
            </div>
          )}

          <div className={fieldFrame('tax_code')}>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">
              Code de taxe{savingField === 'tax_code_id' && <span className="ml-2 text-slate-400 normal-case">enregistrement…</span>}
            </label>
            <SearchableSelect
              testId="achat-taxcode-select"
              value={form.tax_code_id || NO_TAX}
              options={taxCodeOptions}
              onChange={onChangeField('tax_code_id')}
              placeholder="— Aucune taxe —"
            />
          </div>

          {error && <p className="text-xs text-red-600 bg-red-100 rounded-lg px-3 py-2">{error}</p>}

          {!published && (
            <button type="button" onClick={handlePush} disabled={pushing} className="btn-primary text-xs py-1.5 px-3">
              <BookOpen size={12} /> {pushing ? 'Comptabilisation…' : 'Comptabiliser sur QuickBooks'}
            </button>
          )}

          {history.length > 0 && (
            <div className="border-t border-green-200 pt-3" data-testid="achat-vendor-history">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Comptabilisations passées de ce fournisseur — modèles à réutiliser</p>
              <ul className="space-y-1.5">
                {history.map(txn => {
                  const acc = txn.expense_account_id ? accounts.find(a => a.Id === txn.expense_account_id) : null
                  return (
                    <li key={txn.id} className="flex items-center gap-2 text-xs bg-white border border-slate-200 rounded-lg px-2.5 py-1.5">
                      <span className="text-slate-500 w-24 shrink-0">{txn.date_achat ? fmtDate(txn.date_achat) : '—'}</span>
                      <span className="tabular-nums font-medium text-slate-700 w-20 shrink-0 text-right">{fmtCad(txn.total_cad)}</span>
                      <span className="text-slate-500 truncate flex-1 min-w-0">{acc ? accountLabel(acc) : <span className="text-slate-300">compte non enregistré</span>}</span>
                      {acc && !published && (
                        <button
                          type="button"
                          data-testid="achat-use-template"
                          onClick={() => {
                            userTouchedRef.current = true
                            if (txn.expense_account_id) saveField('expense_account_id', txn.expense_account_id)
                            if (isPurchase && txn.payment_account_id) saveField('payment_account_id', txn.payment_account_id)
                            if (txn.tax_code_id) saveField('tax_code_id', txn.tax_code_id)
                            addToast({ message: 'Réglages copiés depuis la transaction passée.', type: 'success' })
                          }}
                          className="shrink-0 text-[11px] font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 border border-brand-200 rounded px-2 py-0.5"
                        >
                          Utiliser
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function QBAttachmentsSection({ achatId }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [fetching, setFetching] = useState(false)
  const [msg, setMsg] = useState('')
  const confirm = useConfirm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.achatsFournisseurs.attachments.list(achatId)
      setItems(data)
    } catch (e) { setMsg(e.message) }
    finally { setLoading(false) }
  }, [achatId])

  useEffect(() => { load() }, [load])

  async function handleFetch() {
    setFetching(true)
    setMsg('')
    try {
      const r = await api.achatsFournisseurs.attachments.fetchFromQB(achatId)
      setMsg(`${r.added} ajoutée(s), ${r.skipped} ignorée(s), ${r.total} sur QB${r.errors?.length ? ` — ${r.errors.length} erreur(s)` : ''}`)
      await load()
    } catch (e) { setMsg(e.message) }
    finally { setFetching(false) }
  }

  async function handleDelete(attId) {
    if (!(await confirm('Supprimer cette pièce jointe ?'))) return
    try {
      await api.achatsFournisseurs.attachments.delete(achatId, attId)
      await load()
    } catch (e) { setMsg(e.message) }
  }

  async function handleOpen(attId) {
    try {
      const { blob } = await api.achatsFournisseurs.attachments.download(achatId, attId)
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (e) { setMsg(e.message) }
  }

  return (
    <div className="border rounded-lg p-3 bg-slate-50">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-medium text-sm">Pièces jointes QuickBooks</h3>
        <button type="button" onClick={handleFetch} disabled={fetching} className="btn-secondary text-xs">
          {fetching ? 'Récupération…' : 'Récupérer depuis QuickBooks'}
        </button>
      </div>
      {msg && <p className="text-xs text-slate-600 mb-2">{msg}</p>}
      {loading ? (
        <p className="text-xs text-slate-400">Chargement…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-slate-400">Aucune pièce jointe.</p>
      ) : (
        <ul className="divide-y divide-slate-200 text-sm">
          {items.map(it => (
            <li key={it.id} className="py-1.5 flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                {it.file_name ? (
                  <button
                    type="button"
                    onClick={() => handleOpen(it.id)}
                    className="text-brand-600 hover:underline truncate block text-left"
                  >
                    {it.file_name}
                  </button>
                ) : (
                  <span className="text-slate-500 italic">Note</span>
                )}
                {it.note && <p className="text-xs text-slate-500 truncate">{it.note}</p>}
              </div>
              <span className="text-xs text-slate-400 tabular-nums whitespace-nowrap">{it.file_size ? formatBytes(it.file_size) : '—'}</span>
              <button type="button" onClick={() => handleDelete(it.id)} className="text-xs text-red-600 hover:underline">
                Suppr.
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function AchatsFournisseurs() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const confirm = useConfirm()

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.achatsFournisseurs.list({ limit, page }),
      setRows, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])

  useEntityListRealtime('achat_fournisseur', setRows)

  useEffect(() => {
    const openId = searchParams.get('id')
    if (!openId || rows.length === 0) return
    const row = rows.find(r => r.id === openId)
    if (row) setEditing(row)
  }, [rows, searchParams])

  // Filtre venant du tableau de bord (clic sur une barre du graphique « Coûts d'expédition »).
  const fromParam = searchParams.get('from')
  const toParam = searchParams.get('to')
  const accountParam = searchParams.get('account')
  const filterActive = !!(fromParam && toParam && accountParam)

  const filteredRows = useMemo(() => {
    if (!filterActive) return rows
    const accountQuery = accountParam.toLowerCase()
    return rows.filter(r => {
      if (!r.date_achat) return false
      if (r.date_achat < fromParam || r.date_achat > toParam) return false
      if (!r.lines) return false
      let lines
      try { lines = JSON.parse(r.lines) } catch { return false }
      return Array.isArray(lines) && lines.some(l => (l.account_name || '').toLowerCase().includes(accountQuery))
    })
  }, [rows, filterActive, fromParam, toParam, accountParam])

  const clearDashboardFilter = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('from'); next.delete('to'); next.delete('account')
    setSearchParams(next, { replace: true })
  }

  async function handleQBImport() {
    const ok = await confirm({
      title: 'Importer depuis QuickBooks ?',
      message:
        'Cette opération va interroger QuickBooks et créer ou mettre à jour en cascade des enregistrements dans cet ERP :\n\n' +
        '• Factures fournisseurs (bills) — création des nouvelles, mise à jour de celles déjà importées\n' +
        '• Dépenses — création des nouvelles, mise à jour de celles déjà importées\n\n' +
        'Les enregistrements importés depuis QuickBooks seront alignés sur les données de QuickBooks. Continuer ?',
      confirmLabel: 'Importer depuis QB',
      danger: false,
    })
    if (!ok) return
    setSyncing(true)
    setSyncResult(null)
    try {
      const result = await api.connectors.importQB()
      setSyncResult(result)
      load()
    } catch (e) {
      setSyncResult({ error: e.message })
    } finally {
      setSyncing(false)
    }
  }

  function handleSaved() {
    setEditing(null)
    setCreating(null)
    load()
  }

  const modalOpen = !!editing || !!creating
  const modalTitle = editing
    ? (editing.type === 'bill' ? 'Modifier la facture fournisseur' : 'Modifier la dépense')
    : (creating === 'bill' ? 'Nouvelle facture fournisseur' : 'Nouvelle dépense')

  return (
    <Layout>
      <div className="p-6">
        <VendorTabs active="achats" />
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Achats fournisseurs</h1>
            <p className="text-sm text-slate-500 mt-1">Dépenses et factures fournisseurs</p>
          </div>
          <div className="flex items-center gap-2">
            {syncResult && !syncResult.error && (
              <span className="text-sm text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1">
                Factures : {syncResult.bills?.inserted ?? 0}+{syncResult.bills?.updated ?? 0}
                {' · '}
                Dépenses : {syncResult.depenses?.inserted ?? 0}+{syncResult.depenses?.updated ?? 0}
              </span>
            )}
            {syncResult?.error && (
              <span className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">{syncResult.error}</span>
            )}
            <button onClick={handleQBImport} disabled={syncing} className="btn-secondary" data-testid="qb-import-btn">
              {syncing ? 'Importation…' : 'Importer depuis QB'}
            </button>
          </div>
        </div>

        {filterActive && (
          <div
            className="mb-3 flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900"
            data-testid="dashboard-filter-banner"
          >
            <span>
              Filtré depuis le tableau de bord — compte <strong>{accountParam}</strong> du <strong>{fmtDate(fromParam)}</strong> au <strong>{fmtDate(toParam)}</strong>
              <span className="ml-2 text-amber-700/70">({filteredRows.length} ligne{filteredRows.length !== 1 ? 's' : ''})</span>
            </span>
            <button
              onClick={clearDashboardFilter}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-amber-900 hover:bg-amber-100"
              data-testid="dashboard-filter-clear"
            >
              <X size={14} /> Effacer
            </button>
          </div>
        )}

        <DataTable
          table="achats_fournisseurs"
          manageViews
          columns={COLUMNS}
          data={filteredRows}
          loading={loading}
          onRowClick={row => setEditing(row)}
          searchFields={['vendor', 'description', 'reference', 'vendor_invoice_number', 'bill_number', 'category', 'total_cad', 'amount_paid_cad', 'balance_due_cad']}
          emptyState={{ icon: ShoppingCart, title: 'Aucun achat fournisseur', description: "Aucune facture ni dépense fournisseur n'est enregistrée. Crée-en une pour suivre les coûts.", cta: { label: 'Nouvelle facture fournisseur', icon: Plus, onClick: () => setCreating('bill') } }}
        />
      </div>

      <RecordPeekDrawer
        open={modalOpen}
        onClose={() => { setCreating(null); setEditing(null) }}
        title={modalTitle}
        width={640}
      >
        <div className="px-5 py-4">
          <AchatModal
            achat={editing}
            initialType={creating}
            onClose={() => { setCreating(null); setEditing(null) }}
            onSaved={handleSaved}
          />
        </div>
      </RecordPeekDrawer>
    </Layout>
  )
}
