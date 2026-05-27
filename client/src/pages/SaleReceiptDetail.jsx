import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, ChevronLeft, ChevronRight, ChevronDown, Search,
  RefreshCw, AlertCircle, CheckCircle, Clock, BookOpen, ReceiptText,
  Plus, Trash2,
} from 'lucide-react'
import { api } from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useEntityListRealtime } from '../lib/useRealtimeChannel.js'
import { fmtDate } from '../lib/formatDate.js'

function fmtCad(n) {
  if (n == null || n === 0 && n !== 0) return '—'
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

function StatusBadge({ status }) {
  if (status === 'done')       return <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full"><CheckCircle size={10} /> Complété</span>
  if (status === 'processing') return <span className="inline-flex items-center gap-1 text-xs text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full"><RefreshCw size={10} className="animate-spin" /> En cours</span>
  if (status === 'error')      return <span className="inline-flex items-center gap-1 text-xs text-red-700 bg-red-100 px-2 py-0.5 rounded-full"><AlertCircle size={10} /> Erreur</span>
  return <span className="inline-flex items-center gap-1 text-xs text-gray-600 bg-gray-100 px-2 py-0.5 rounded-full"><Clock size={10} /> En attente</span>
}

function SearchableSelect({ value, options, onChange, placeholder = 'Sélectionner…', testId }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 })
  const btnRef = useRef(null)
  const inputRef = useRef(null)

  const selected = options.find(o => o.value === value)
  const filtered = search
    ? options.filter(o => o.label.toLowerCase().includes(search.toLowerCase()))
    : options

  useEffect(() => {
    if (!open) return
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) setPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 280) })
    inputRef.current?.focus()
    function handler(e) {
      if (!btnRef.current?.contains(e.target) && !document.getElementById('qb-select-portal')?.contains(e.target)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        data-testid={testId}
        onClick={() => setOpen(o => !o)}
        className="input-field text-xs w-full flex items-center justify-between gap-1 text-left"
      >
        <span className={`truncate ${selected ? 'text-slate-700' : 'text-slate-400'}`}>
          {selected?.label || placeholder}
        </span>
        <ChevronDown size={12} className="flex-shrink-0 text-slate-400" />
      </button>
      {open && createPortal(
        <div
          id="qb-select-portal"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 }}
          className="bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden"
        >
          <div className="p-2 border-b border-slate-100">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                ref={inputRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400"
                placeholder="Rechercher…"
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-3">Aucun résultat</p>
            ) : filtered.map(o => (
              <button
                key={o.value}
                type="button"
                onClick={() => { onChange(o.value); setOpen(false); setSearch('') }}
                className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-50 transition-colors ${o.value === value ? 'text-brand-600 font-medium bg-brand-50' : 'text-slate-700'}`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

function QBPublishForm({ receipt, onSuccess }) {
  const [accounts, setAccounts] = useState([])
  const [vendors, setVendors] = useState([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const [type, setType] = useState('purchase')
  const [expenseAccountId, setExpenseAccountId] = useState('')
  const [paymentAccountId, setPaymentAccountId] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [vendorMode, setVendorMode] = useState('existing')
  const [vendorId, setVendorId] = useState('')
  const [newVendorName, setNewVendorName] = useState(receipt.company || '')
  useEffect(() => {
    Promise.all([api.quickbooks.accounts(), api.quickbooks.vendors()])
      .then(([accs, vends]) => {
        setAccounts(accs)
        setVendors(vends)
        if (receipt.company) {
          const match = vends.find(v => v.DisplayName.toLowerCase() === receipt.company.toLowerCase())
          if (match) { setVendorId(match.Id); setVendorMode('existing') }
          else setVendorMode('new')
        }
      })
      .catch(() => setError('Impossible de charger les données QuickBooks'))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const expenseAccounts = accounts.filter(a => ['Expense', 'Other Expense', 'Cost of Goods Sold', 'Other Current Asset'].includes(a.AccountType))
  const paymentAccounts = accounts.filter(a => ['Bank', 'Credit Card'].includes(a.AccountType))
  const accountLabel = a => (a.AcctNum ? `${a.AcctNum} — ${a.Name}` : a.Name)
  const vendorOptions  = vendors.map(v => ({ value: v.Id, label: v.DisplayName }))
  const expenseOptions = expenseAccounts.map(a => ({ value: a.Id, label: accountLabel(a) }))
  const paymentOptions = paymentAccounts.map(a => ({ value: a.Id, label: `${accountLabel(a)} (${a.AccountType})` }))

  async function handleSubmit() {
    if (receipt.receipt_date) {
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const [y, m, d] = receipt.receipt_date.slice(0, 10).split('-').map(Number)
      const rDate = new Date(y, (m || 1) - 1, d || 1)
      const diffDays = Math.round((today - rDate) / 86400000)
      if (diffDays < 0) { setError('Impossible de publier une facture datée dans le futur.'); return }
      if (diffDays > 30) { setError(`Impossible de publier une facture datée de plus de 30 jours dans le passé (${diffDays} jours).`); return }
    }
    if (!expenseAccountId) { setError('Sélectionnez un compte de dépense'); return }
    if (type === 'purchase' && !paymentAccountId) { setError('Sélectionnez un compte de paiement'); return }
    if (vendorMode === 'existing' && !vendorId) { setError('Sélectionnez un fournisseur'); return }
    if (vendorMode === 'new' && !newVendorName.trim()) { setError('Entrez le nom du fournisseur'); return }
    setSubmitting(true)
    setError(null)
    try {
      await api.saleReceipts.pushToQb(receipt.id, {
        type,
        expenseAccountId,
        paymentAccountId: type === 'purchase' ? paymentAccountId : undefined,
        vendorId: vendorMode === 'existing' ? vendorId : undefined,
        newVendorName: vendorMode === 'new' ? newVendorName.trim() : undefined,
        dueDate: type === 'bill' && dueDate ? dueDate : undefined,
      })
      const updated = await api.saleReceipts.get(receipt.id)
      onSuccess(updated)
    } catch (e) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-400 text-sm mt-3 py-2">
        <RefreshCw size={14} className="animate-spin" /> Chargement des comptes QuickBooks…
      </div>
    )
  }

  return (
    <div className="mt-3 border border-green-200 bg-green-50 rounded-xl p-4 space-y-4">
      <div>
        <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Type</label>
        <div className="flex gap-4">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="radio" data-testid="qb-type-purchase" checked={type === 'purchase'} onChange={() => setType('purchase')} />
            <span>Dépense payée (Purchase)</span>
          </label>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="radio" data-testid="qb-type-bill" checked={type === 'bill'} onChange={() => setType('bill')} />
            <span>Facture à payer (Bill → Comptes fournisseurs)</span>
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4">
        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Fournisseur</label>
          <div className="flex gap-3 mb-1.5">
            <label className="flex items-center gap-1 text-xs cursor-pointer">
              <input type="radio" checked={vendorMode === 'existing'} onChange={() => setVendorMode('existing')} /> Existant
            </label>
            <label className="flex items-center gap-1 text-xs cursor-pointer">
              <input type="radio" checked={vendorMode === 'new'} onChange={() => setVendorMode('new')} /> Nouveau
            </label>
          </div>
          {vendorMode === 'existing' ? (
            <SearchableSelect
              testId="qb-vendor-select"
              value={vendorId}
              options={vendorOptions}
              onChange={setVendorId}
              placeholder="— Aucun —"
            />
          ) : (
            <input type="text" placeholder="Nom du fournisseur" value={newVendorName} onChange={e => setNewVendorName(e.target.value)} className="input-field text-xs w-full" />
          )}
        </div>

        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Compte de dépense</label>
          <SearchableSelect
            testId="qb-expense-select"
            value={expenseAccountId}
            options={expenseOptions}
            onChange={setExpenseAccountId}
            placeholder="— Sélectionner —"
          />
        </div>

        {type === 'purchase' ? (
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Compte de paiement</label>
            <SearchableSelect
              testId="qb-payment-select"
              value={paymentAccountId}
              options={paymentOptions}
              onChange={setPaymentAccountId}
              placeholder="— Sélectionner —"
            />
          </div>
        ) : (
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Échéance</label>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className="input-field text-xs w-full" />
            <p className="text-[11px] text-slate-500 mt-1.5 leading-snug">
              Le crédit est posté automatiquement au compte <strong>Comptes fournisseurs</strong> du vendor — aucun compte de paiement à choisir.
            </p>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-600 bg-red-100 rounded-lg px-3 py-2">{error}</p>}

      <div className="flex gap-2">
        <button className="btn-primary text-xs py-1.5 px-3" onClick={handleSubmit} disabled={submitting}>
          {submitting ? <><RefreshCw size={12} className="animate-spin" /> Publication…</> : <><BookOpen size={12} /> Publier sur QuickBooks</>}
        </button>
      </div>
    </div>
  )
}

function CurrencyField({ receipt, onUpdate }) {
  const { addToast } = useToast()
  const [value, setValue] = useState(receipt.currency || '')
  const [saving, setSaving] = useState(false)

  useEffect(() => { setValue(receipt.currency || '') }, [receipt.id, receipt.currency])

  async function commit(next) {
    const normalized = (next || '').trim().toUpperCase() || null
    if (normalized === (receipt.currency || null)) return
    setSaving(true)
    try {
      const updated = await api.saleReceipts.update(receipt.id, { currency: normalized })
      onUpdate?.(updated)
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      setValue(receipt.currency || '')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">Devise</p>
      <div className="flex items-center gap-2 mt-0.5">
        <select
          className="input-field text-sm py-1 px-2"
          data-testid="receipt-currency"
          value={value}
          onChange={e => { setValue(e.target.value); commit(e.target.value) }}
          disabled={saving}
        >
          <option value="">—</option>
          <option value="CAD">CAD</option>
          <option value="USD">USD</option>
          <option value="EUR">EUR</option>
        </select>
        {saving && <RefreshCw size={12} className="animate-spin text-slate-400" />}
      </div>
    </div>
  )
}

function InfoField({ label, value }) {
  return (
    <div>
      <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">{label}</p>
      <p className="text-sm text-slate-700 mt-0.5">{value || <span className="text-slate-300">—</span>}</p>
    </div>
  )
}

function TotalRow({ label, value, bold }) {
  return (
    <div className="flex justify-between items-center">
      <span className={`text-sm ${bold ? 'font-semibold text-slate-800' : 'text-slate-600'}`}>{label}</span>
      <span className={`tabular-nums text-sm ${bold ? 'font-bold text-slate-900 text-base' : 'text-slate-700'}`}>
        {value != null ? fmtCad(value) : '—'}
      </span>
    </div>
  )
}

function EditableItems({ receipt, onUpdate }) {
  const { addToast } = useToast()
  const [items, setItems] = useState(receipt.items || [])
  const [saving, setSaving] = useState(false)
  const initialJsonRef = useRef(JSON.stringify(receipt.items || []))

  // Sync depuis le serveur uniquement quand on change de reçu — sinon les
  // updates optimistes locaux (ajout/suppression/édition en cours) seraient
  // écrasés par le re-render qui suit le PATCH.
  useEffect(() => {
    setItems(receipt.items || [])
    initialJsonRef.current = JSON.stringify(receipt.items || [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.id])

  function parseNum(x) {
    if (x === '' || x == null) return null
    const n = Number(String(x).replace(',', '.'))
    return Number.isFinite(n) && n >= 0 ? n : null
  }

  function updateItem(i, patch) {
    setItems(prev => prev.map((it, idx) => idx === i ? { ...it, ...patch } : it))
  }

  function removeItem(i) {
    setItems(prev => prev.filter((_, idx) => idx !== i))
  }

  function addItem() {
    setItems(prev => [...prev, { description: '', total: null }])
  }

  async function commit() {
    const normalized = items.map(it => ({
      description: it.description || '',
      total:       parseNum(it.total),
    }))
    const nextJson = JSON.stringify(normalized)
    if (nextJson === initialJsonRef.current) return
    setSaving(true)
    try {
      const updated = await api.saleReceipts.update(receipt.id, { items: normalized })
      onUpdate?.(updated)
      initialJsonRef.current = JSON.stringify(updated.items || [])
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      setItems(receipt.items || [])
    } finally {
      setSaving(false)
    }
  }

  // Sauvegarde à chaque suppression / ajout (la modification d'un champ texte
  // déclenche commit sur blur via l'input lui-même).
  useEffect(() => {
    const json = JSON.stringify(items.map(it => ({
      description: it.description || '',
      total:       parseNum(it.total),
    })))
    if (json !== initialJsonRef.current && items.length !== (receipt.items || []).length) {
      commit()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length])

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-slate-700">Articles</h3>
        <div className="flex items-center gap-2">
          {saving && <RefreshCw size={12} className="animate-spin text-slate-400" />}
          <button
            type="button"
            onClick={addItem}
            data-testid="receipt-item-add"
            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-brand-600 hover:bg-brand-50 rounded"
          >
            <Plus size={12} /> Ajouter une ligne
          </button>
        </div>
      </div>
      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="text-left px-3 py-2 text-slate-600 font-medium">Description</th>
              <th className="text-right px-3 py-2 text-slate-600 font-medium w-32">Total</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-4 text-center text-slate-400 text-xs">
                  Aucun article — cliquez « Ajouter une ligne ».
                </td>
              </tr>
            )}
            {items.map((item, i) => (
              <tr key={i} className="hover:bg-slate-50" data-testid={`receipt-item-row-${i}`}>
                <td className="px-1 py-1">
                  <input
                    type="text"
                    value={item.description || ''}
                    onChange={e => updateItem(i, { description: e.target.value })}
                    onBlur={commit}
                    placeholder="Description"
                    className="w-full px-2 py-1 text-sm bg-transparent border border-transparent hover:border-slate-300 focus:border-brand-500 focus:bg-white rounded outline-none"
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={item.total ?? ''}
                    onChange={e => updateItem(i, { total: e.target.value })}
                    onBlur={commit}
                    placeholder="—"
                    className="w-full px-2 py-1 text-sm text-right tabular-nums font-medium bg-transparent border border-transparent hover:border-slate-300 focus:border-brand-500 focus:bg-white rounded outline-none"
                  />
                </td>
                <td className="px-1 py-1 text-center">
                  <button
                    type="button"
                    onClick={() => removeItem(i)}
                    data-testid={`receipt-item-remove-${i}`}
                    title="Supprimer cette ligne"
                    aria-label="Supprimer cette ligne"
                    className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                  >
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function EditableAmountRow({ receipt, field, label, bold, onUpdate }) {
  const { addToast } = useToast()
  const initial = receipt[field] != null ? String(receipt[field]) : ''
  const [value, setValue] = useState(initial)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setValue(receipt[field] != null ? String(receipt[field]) : '') }, [receipt.id, receipt[field], field])

  async function commit() {
    const trimmed = value.trim()
    const parsed = trimmed === '' ? null : Number(trimmed.replace(',', '.'))
    if (parsed != null && (!Number.isFinite(parsed) || parsed < 0)) {
      addToast({ message: 'Montant invalide', type: 'error' })
      setValue(receipt[field] != null ? String(receipt[field]) : '')
      return
    }
    const current = receipt[field] ?? null
    if (parsed === current) return
    setSaving(true)
    try {
      const updated = await api.saleReceipts.update(receipt.id, { [field]: parsed })
      onUpdate?.(updated)
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      setValue(receipt[field] != null ? String(receipt[field]) : '')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex justify-between items-center gap-2">
      <span className={`text-sm ${bold ? 'font-semibold text-slate-800' : 'text-slate-600'}`}>{label}</span>
      <div className="flex items-center gap-1">
        {saving && <RefreshCw size={11} className="animate-spin text-slate-400" />}
        <input
          type="text"
          inputMode="decimal"
          data-testid={`receipt-amount-${field}`}
          value={value}
          onChange={e => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
          placeholder="—"
          disabled={saving}
          className={`tabular-nums text-right bg-transparent border border-transparent hover:border-slate-300 focus:border-brand-500 focus:bg-white rounded px-2 py-0.5 w-28 text-sm outline-none ${
            bold ? 'font-bold text-slate-900 text-base' : 'text-slate-700'
          }`}
        />
      </div>
    </div>
  )
}

export default function SaleReceiptDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [receipt, setReceipt] = useState(null)
  const [loading, setLoading] = useState(true)
  const [fileUrl, setFileUrl] = useState(null)
  const [allIds, setAllIds] = useState([])

  useEffect(() => {
    setLoading(true)
    api.saleReceipts.get(id)
      .then(setReceipt)
      .catch(() => setReceipt(null))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    // Priorité à l'ordre de la vue mémorisé dans sessionStorage (set par
    // SaleReceipts.jsx au clic sur une ligne). Fallback : ordre DB complet
    // si l'utilisateur arrive directement par URL.
    try {
      const stored = sessionStorage.getItem('sale_receipts:nav_ids')
      if (stored) {
        const arr = JSON.parse(stored)
        if (Array.isArray(arr) && arr.length) {
          setAllIds(arr.map(String))
          return
        }
      }
    } catch {}
    api.saleReceipts.list({ limit: 'all' })
      .then(res => setAllIds((res.data || []).map(r => String(r.id))))
      .catch(() => {})
  }, [])

  useEntityListRealtime('sale_receipt', (updater) => {
    setReceipt(prev => {
      if (!prev) return prev
      const next = typeof updater === 'function' ? updater([prev]) : updater
      if (Array.isArray(next)) {
        const found = next.find(r => String(r.id) === String(id))
        return found || prev
      }
      return prev
    })
  })

  // Poll while the extraction is in progress, just like the old page.
  useEffect(() => {
    if (!receipt || (receipt.status !== 'processing' && receipt.status !== 'pending')) return
    const t = setInterval(async () => {
      try {
        const fresh = await api.saleReceipts.get(id)
        setReceipt(fresh)
        if (fresh.status !== 'processing' && fresh.status !== 'pending') clearInterval(t)
      } catch {}
    }, 2000)
    return () => clearInterval(t)
  }, [receipt?.status, id])

  useEffect(() => {
    setFileUrl(null)
    if (!receipt?.id) return
    let url = null
    const token = localStorage.getItem('erp_token')
    fetch(`/erp/api/sale-receipts/${receipt.id}/file`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(r => r.ok ? r.blob() : Promise.reject())
      .then(blob => { url = URL.createObjectURL(blob); setFileUrl(url) })
      .catch(() => setFileUrl(null))
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [receipt?.id])

  const currentIdx = allIds.indexOf(String(id))
  const prevId = currentIdx > 0 ? allIds[currentIdx - 1] : null
  const nextId = currentIdx >= 0 && currentIdx < allIds.length - 1 ? allIds[currentIdx + 1] : null

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600" />
        </div>
      </Layout>
    )
  }

  if (!receipt) {
    return (
      <Layout>
        <div className="p-6 max-w-4xl mx-auto">
          <button onClick={() => navigate('/sale-receipts')} className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700">
            <ArrowLeft size={16} /> Retour à la liste
          </button>
          <div className="mt-6 text-slate-500">Reçu introuvable.</div>
        </div>
      </Layout>
    )
  }

  const isPdf = receipt.file_type === '.pdf'
  const items = receipt.items || []

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-start gap-4 mb-4">
          <button
            onClick={() => navigate('/sale-receipts')}
            className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg"
            title="Retour à la liste"
            aria-label="Retour"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <ReceiptText size={20} className="text-slate-400" />
              <h1 className="text-2xl font-bold text-slate-900 truncate">{receipt.company || receipt.original_name}</h1>
              <StatusBadge status={receipt.status} />
              {receipt.quickbooks_id && (
                receipt.quickbooks_url ? (
                  <a
                    href={receipt.quickbooks_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="qb-link"
                    className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 hover:bg-green-200 px-2 py-0.5 rounded-full"
                  >
                    <BookOpen size={10} /> QB #{receipt.quickbooks_id}
                  </a>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
                    <BookOpen size={10} /> QB #{receipt.quickbooks_id}
                  </span>
                )
              )}
            </div>
            {receipt.address && <p className="text-slate-500 text-sm mt-1">{receipt.address}</p>}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => prevId && navigate(`/sale-receipts/${prevId}`)}
              disabled={!prevId}
              className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              data-testid="receipt-prev"
              title="Reçu précédent"
              aria-label="Reçu précédent"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => nextId && navigate(`/sale-receipts/${nextId}`)}
              disabled={!nextId}
              className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              data-testid="receipt-next"
              title="Reçu suivant"
              aria-label="Reçu suivant"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>

        {receipt.status === 'processing' ? (
          <div className="flex flex-col items-center justify-center py-20 text-blue-500 gap-3">
            <RefreshCw size={48} strokeWidth={1} className="animate-spin" />
            <p className="font-medium">Extraction en cours…</p>
            <p className="text-slate-400 text-sm">Les données seront disponibles dans quelques secondes</p>
          </div>
        ) : receipt.status === 'error' ? (
          <div className="flex flex-col items-center justify-center py-20 text-red-500 gap-3">
            <AlertCircle size={48} strokeWidth={1} />
            <p className="font-medium">Erreur d'extraction</p>
            {receipt.error_message && <p className="text-slate-500 text-sm text-center max-w-sm">{receipt.error_message}</p>}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Original file preview */}
            {fileUrl && (
              <div className="bg-slate-100 rounded-xl border border-slate-200 overflow-auto p-3 flex items-start justify-center min-h-[400px]">
                {isPdf ? (
                  <iframe src={fileUrl} title="Reçu original" className="w-full h-full min-h-[600px] rounded shadow" />
                ) : (
                  <img src={fileUrl} alt="Reçu original" className="max-w-full object-contain rounded shadow" />
                )}
              </div>
            )}

            {/* Extracted data */}
            <div className="space-y-6">
              {receipt.status === 'done' && !receipt.quickbooks_id && (
                <QBPublishForm
                  receipt={receipt}
                  onSuccess={setReceipt}
                />
              )}

              <div className="grid grid-cols-2 gap-4">
                <InfoField label="Entreprise" value={receipt.company} />
                <InfoField label="Date" value={receipt.receipt_date ? fmtDate(receipt.receipt_date) : null} />
                <InfoField label="N° de reçu" value={receipt.receipt_number} />
                <InfoField label="Mode de paiement" value={receipt.payment_method} />
                <CurrencyField receipt={receipt} onUpdate={setReceipt} />
                <InfoField label="Fichier" value={receipt.original_name} />
              </div>

              <EditableItems receipt={receipt} onUpdate={setReceipt} />

              <div>
                <div className="flex items-baseline justify-between mb-2">
                  <h3 className="text-sm font-semibold text-slate-700">Montants</h3>
                  <p className="text-[11px] text-slate-400">Cliquez pour modifier — les codes de taxe QB sont déduits des valeurs TPS/TVQ.</p>
                </div>
                <div className="bg-slate-50 rounded-lg p-4 space-y-2">
                  <EditableAmountRow receipt={receipt} field="subtotal"    label="Sous-total (avant taxes)" onUpdate={setReceipt} />
                  <EditableAmountRow receipt={receipt} field="tps"         label="TPS / GST"                onUpdate={setReceipt} />
                  <EditableAmountRow receipt={receipt} field="tvq"         label="TVQ / QST / PST"          onUpdate={setReceipt} />
                  <EditableAmountRow receipt={receipt} field="other_taxes" label="Autres taxes"             onUpdate={setReceipt} />
                  <div className="border-t border-slate-200 pt-2 mt-2">
                    <EditableAmountRow receipt={receipt} field="total" label="Total" bold onUpdate={setReceipt} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </Layout>
  )
}
