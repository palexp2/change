import { useState, useEffect, useRef, useCallback } from 'react'
import { Upload, FileText, Trash2, RefreshCw, AlertCircle, CheckCircle, Clock, X, ReceiptText, BookOpen } from 'lucide-react'
import { api } from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Modal } from '../components/Modal.jsx'

function fmtCad(n) {
  if (n == null || n === 0 && n !== 0) return '—'
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d + 'T12:00:00').toLocaleDateString('fr-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

function StatusBadge({ status }) {
  if (status === 'done')       return <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full"><CheckCircle size={10} /> Complété</span>
  if (status === 'processing') return <span className="inline-flex items-center gap-1 text-xs text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full"><RefreshCw size={10} className="animate-spin" /> En cours</span>
  if (status === 'error')      return <span className="inline-flex items-center gap-1 text-xs text-red-700 bg-red-100 px-2 py-0.5 rounded-full"><AlertCircle size={10} /> Erreur</span>
  return <span className="inline-flex items-center gap-1 text-xs text-gray-600 bg-gray-100 px-2 py-0.5 rounded-full"><Clock size={10} /> En attente</span>
}

function UploadZone({ onUpload, uploading }) {
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef()

  function handleFiles(files) {
    if (!files?.length) return
    const file = files[0]
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']
    const ext = file.name.split('.').pop().toLowerCase()
    if (!allowed.includes(file.type) && !['jpg','jpeg','png','gif','webp','pdf'].includes(ext)) {
      alert('Formats acceptés : JPG, PNG, GIF, WEBP, PDF')
      return
    }
    const fd = new FormData()
    fd.append('file', file)
    onUpload(fd)
  }

  return (
    <div
      className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer
        ${dragOver ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 bg-white hover:border-indigo-400 hover:bg-slate-50'}
        ${uploading ? 'opacity-60 pointer-events-none' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files) }}
      onClick={() => inputRef.current?.click()}
    >
      <input ref={inputRef} type="file" accept=".jpg,.jpeg,.png,.gif,.webp,.pdf" className="hidden" onChange={e => handleFiles(e.target.files)} />
      {uploading ? (
        <div className="flex flex-col items-center gap-3">
          <RefreshCw size={32} className="text-indigo-500 animate-spin" />
          <p className="text-slate-600 font-medium">Téléversement en cours…</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 bg-indigo-100 rounded-full flex items-center justify-center">
            <Upload size={24} className="text-indigo-600" />
          </div>
          <div>
            <p className="text-slate-700 font-semibold">Glissez un fichier ici</p>
            <p className="text-slate-400 text-sm mt-1">ou cliquez pour parcourir</p>
            <p className="text-slate-400 text-xs mt-2">JPG, PNG, GIF, WEBP, PDF — max 20 Mo</p>
          </div>
        </div>
      )}
    </div>
  )
}

function ReceiptItem({ receipt, selected, onClick, onDelete }) {
  const label = receipt.company || receipt.original_name || '—'
  const amount = receipt.total ? fmtCad(receipt.total) : null

  return (
    <div
      onClick={onClick}
      className={`flex items-start gap-3 px-3 py-3 rounded-lg cursor-pointer transition-colors group
        ${selected ? 'bg-indigo-600 text-white' : 'hover:bg-slate-100 text-slate-700'}`}
    >
      <div className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center mt-0.5
        ${selected ? 'bg-indigo-500' : 'bg-slate-200'}`}>
        <ReceiptText size={14} className={selected ? 'text-white' : 'text-slate-500'} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-medium text-sm truncate">{label}</span>
          <StatusBadge status={receipt.status} />
        </div>
        {receipt.receipt_date && (
          <p className={`text-xs mt-0.5 ${selected ? 'text-indigo-200' : 'text-slate-400'}`}>{fmtDate(receipt.receipt_date)}</p>
        )}
        {amount && (
          <p className={`text-sm font-semibold mt-0.5 ${selected ? 'text-white' : 'text-slate-900'}`}>{amount}</p>
        )}
      </div>
      <button
        onClick={e => { e.stopPropagation(); onDelete() }}
        className={`opacity-0 group-hover:opacity-100 p-1 rounded transition-all flex-shrink-0
          ${selected ? 'hover:bg-indigo-500 text-indigo-200 hover:text-white' : 'hover:bg-red-100 text-slate-400 hover:text-red-600'}`}
        title="Supprimer"
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}

function QBPublishForm({ receipt, onSuccess }) {
  const [accounts, setAccounts] = useState([])
  const [vendors, setVendors] = useState([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const [expenseAccountId, setExpenseAccountId] = useState('')
  const [paymentAccountId, setPaymentAccountId] = useState('')
  const [vendorMode, setVendorMode] = useState('existing')
  const [vendorId, setVendorId] = useState('')
  const [newVendorName, setNewVendorName] = useState(receipt.company || '')
  const [vendorSearch, setVendorSearch] = useState('')
  const [expenseSearch, setExpenseSearch] = useState('')
  const [paymentSearch, setPaymentSearch] = useState('')

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
  }, [])

  const expenseAccounts = accounts.filter(a => ['Expense', 'Other Expense'].includes(a.AccountType))
  const paymentAccounts = accounts.filter(a => ['Bank', 'Credit Card'].includes(a.AccountType))
  const filteredVendors  = vendorSearch  ? vendors.filter(v => v.DisplayName.toLowerCase().includes(vendorSearch.toLowerCase()))  : vendors
  const filteredExpense  = expenseSearch ? expenseAccounts.filter(a => a.Name.toLowerCase().includes(expenseSearch.toLowerCase())) : expenseAccounts
  const filteredPayment  = paymentSearch ? paymentAccounts.filter(a => a.Name.toLowerCase().includes(paymentSearch.toLowerCase())) : paymentAccounts

  async function handleSubmit() {
    if (!expenseAccountId) { setError('Sélectionnez un compte de dépense'); return }
    if (!paymentAccountId) { setError('Sélectionnez un compte de paiement'); return }
    if (vendorMode === 'existing' && !vendorId) { setError('Sélectionnez un fournisseur'); return }
    if (vendorMode === 'new' && !newVendorName.trim()) { setError('Entrez le nom du fournisseur'); return }
    setSubmitting(true)
    setError(null)
    try {
      await api.saleReceipts.pushToQb(receipt.id, {
        expenseAccountId,
        paymentAccountId,
        vendorId: vendorMode === 'existing' ? vendorId : undefined,
        newVendorName: vendorMode === 'new' ? newVendorName.trim() : undefined,
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* Fournisseur */}
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
            <>
              <input type="text" placeholder="Rechercher…" value={vendorSearch} onChange={e => setVendorSearch(e.target.value)} className="input-field text-xs w-full mb-1" />
              <select value={vendorId} onChange={e => setVendorId(e.target.value)} className="input-field text-xs w-full" size={4}>
                <option value="">— Aucun —</option>
                {filteredVendors.map(v => <option key={v.Id} value={v.Id}>{v.DisplayName}</option>)}
              </select>
            </>
          ) : (
            <input type="text" placeholder="Nom du fournisseur" value={newVendorName} onChange={e => setNewVendorName(e.target.value)} className="input-field text-xs w-full" />
          )}
        </div>

        {/* Compte de dépense */}
        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Compte de dépense</label>
          <input type="text" placeholder="Rechercher…" value={expenseSearch} onChange={e => setExpenseSearch(e.target.value)} className="input-field text-xs w-full mb-1" />
          <select value={expenseAccountId} onChange={e => setExpenseAccountId(e.target.value)} className="input-field text-xs w-full" size={4}>
            <option value="">— Sélectionner —</option>
            {filteredExpense.map(a => <option key={a.Id} value={a.Id}>{a.Name}</option>)}
          </select>
        </div>

        {/* Compte de paiement */}
        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Compte de paiement</label>
          <input type="text" placeholder="Rechercher…" value={paymentSearch} onChange={e => setPaymentSearch(e.target.value)} className="input-field text-xs w-full mb-1" />
          <select value={paymentAccountId} onChange={e => setPaymentAccountId(e.target.value)} className="input-field text-xs w-full" size={4}>
            <option value="">— Sélectionner —</option>
            {filteredPayment.map(a => <option key={a.Id} value={a.Id}>{a.Name} ({a.AccountType})</option>)}
          </select>
        </div>
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

function ReceiptDetail({ receipt, onUpdate }) {
  const [fileUrl, setFileUrl] = useState(null)

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

  if (!receipt) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-3">
        <ReceiptText size={48} strokeWidth={1} />
        <p className="text-sm">Sélectionnez un reçu dans la liste</p>
      </div>
    )
  }

  if (receipt.status === 'processing') {
    return (
      <div className="flex flex-col items-center justify-center h-full text-blue-500 gap-3">
        <RefreshCw size={48} strokeWidth={1} className="animate-spin" />
        <p className="font-medium">Extraction en cours…</p>
        <p className="text-slate-400 text-sm">Les données seront disponibles dans quelques secondes</p>
      </div>
    )
  }

  if (receipt.status === 'error') {
    return (
      <div className="flex flex-col items-center justify-center h-full text-red-500 gap-3">
        <AlertCircle size={48} strokeWidth={1} />
        <p className="font-medium">Erreur d'extraction</p>
        {receipt.error_message && <p className="text-slate-500 text-sm text-center max-w-sm">{receipt.error_message}</p>}
      </div>
    )
  }

  const isPdf = receipt.file_type === '.pdf'
  const items = receipt.items || []

  return (
    <div className="flex h-full overflow-hidden">
      {/* Original file preview */}
      {fileUrl && (
        <div className="w-1/2 border-r border-slate-200 bg-slate-100 overflow-auto flex items-start justify-center p-4">
          {isPdf ? (
            <iframe src={fileUrl} title="Reçu original" className="w-full h-full min-h-[600px] rounded shadow" />
          ) : (
            <img src={fileUrl} alt="Reçu original" className="max-w-full object-contain rounded shadow" />
          )}
        </div>
      )}

      {/* Extracted data */}
      <div className={`${fileUrl ? 'w-1/2' : 'w-full'} p-6 overflow-y-auto space-y-6`}>
        {/* Header */}
        <div>
          <h2 className="text-xl font-bold text-slate-900">{receipt.company || receipt.original_name}</h2>
          {receipt.address && <p className="text-slate-500 text-sm mt-0.5">{receipt.address}</p>}
          <div className="flex items-center gap-4 mt-2 flex-wrap">
            <StatusBadge status={receipt.status} />
            {receipt.receipt_date && <span className="text-sm text-slate-500">{fmtDate(receipt.receipt_date)}</span>}
            {receipt.receipt_number && <span className="text-sm text-slate-500">#{receipt.receipt_number}</span>}
            {receipt.quickbooks_id && (
              <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
                <BookOpen size={10} /> QB #{receipt.quickbooks_id}
              </span>
            )}
          </div>
          {receipt.status === 'done' && !receipt.quickbooks_id && (
            <QBPublishForm
              receipt={receipt}
              onSuccess={updated => onUpdate?.(updated)}
            />
          )}
        </div>

        {/* General info */}
        <div className="grid grid-cols-2 gap-4">
          <InfoField label="Entreprise" value={receipt.company} />
          <InfoField label="Date" value={receipt.receipt_date ? fmtDate(receipt.receipt_date) : null} />
          <InfoField label="N° de reçu" value={receipt.receipt_number} />
          <InfoField label="Mode de paiement" value={receipt.payment_method} />
          <InfoField label="Devise" value={receipt.currency} />
          <InfoField label="Fichier" value={receipt.original_name} />
        </div>

        {/* Items */}
        {items.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-slate-700 mb-2">Articles</h3>
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="text-left px-3 py-2 text-slate-600 font-medium">Description</th>
                    <th className="text-right px-3 py-2 text-slate-600 font-medium w-16">Qté</th>
                    <th className="text-right px-3 py-2 text-slate-600 font-medium w-24">Prix unit.</th>
                    <th className="text-right px-3 py-2 text-slate-600 font-medium w-24">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((item, i) => (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="px-3 py-2 text-slate-700">{item.description || '—'}</td>
                      <td className="px-3 py-2 text-right text-slate-600 tabular-nums">{item.quantity ?? '—'}</td>
                      <td className="px-3 py-2 text-right text-slate-600 tabular-nums">{item.unit_price ? fmtCad(item.unit_price) : '—'}</td>
                      <td className="px-3 py-2 text-right text-slate-700 font-medium tabular-nums">{item.total ? fmtCad(item.total) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Totals */}
        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Montants</h3>
          <div className="bg-slate-50 rounded-lg p-4 space-y-2">
            <TotalRow label="Sous-total (avant taxes)" value={receipt.subtotal} />
            {(receipt.tps > 0) && <TotalRow label="TPS / GST" value={receipt.tps} />}
            {(receipt.tvq > 0) && <TotalRow label="TVQ / QST / PST" value={receipt.tvq} />}
            {(receipt.other_taxes > 0) && <TotalRow label="Autres taxes" value={receipt.other_taxes} />}
            <div className="border-t border-slate-200 pt-2 mt-2">
              <TotalRow label="Total" value={receipt.total} bold />
            </div>
          </div>
        </div>
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

export default function SaleReceipts() {
  const [receipts, setReceipts]       = useState([])
  const [loading, setLoading]         = useState(true)
  const [selected, setSelected]       = useState(null)
  const [uploading, setUploading]     = useState(false)
  const [toDelete, setToDelete]       = useState(null)
  const pollingRef                    = useRef(null)

  const load = useCallback(async () => {
    try {
      const { data } = await api.saleReceipts.list({ limit: 'all' })
      setReceipts(data || [])
      setLoading(false)
    } catch {}
  }, [])

  useEffect(() => { load() }, [load])

  // Refresh selected receipt when it's in processing state
  useEffect(() => {
    const processing = receipts.some(r => r.status === 'processing' || r.status === 'pending')
    if (processing) {
      pollingRef.current = setInterval(async () => {
        try {
          const { data } = await api.saleReceipts.list({ limit: 'all' })
          setReceipts(data || [])
          const stillProcessing = data.some(r => r.status === 'processing' || r.status === 'pending')
          if (!stillProcessing) clearInterval(pollingRef.current)
          // Refresh selected if it changed
          if (selected) {
            const updated = data.find(r => r.id === selected.id)
            if (updated) setSelected(updated)
          }
        } catch {}
      }, 2000)
    } else {
      clearInterval(pollingRef.current)
    }
    return () => clearInterval(pollingRef.current)
  }, [receipts, selected])

  async function handleUpload(formData) {
    setUploading(true)
    try {
      const { id } = await api.saleReceipts.upload(formData)
      await load()
      const receipt = (await api.saleReceipts.get(id))
      setSelected(receipt)
    } catch (err) {
      alert('Erreur: ' + err.message)
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete(id) {
    try {
      await api.saleReceipts.delete(id)
      if (selected?.id === id) setSelected(null)
      await load()
    } catch (err) {
      alert('Erreur: ' + err.message)
    }
    setToDelete(null)
  }

  function handleSelect(receipt) {
    setSelected(r => r?.id === receipt.id ? null : receipt)
  }

  return (
    <Layout>
      <div className="flex h-full overflow-hidden">
        {/* Left sidebar */}
        <div className="w-72 flex-shrink-0 bg-white border-r border-slate-200 flex flex-col overflow-hidden">
          <div className="px-4 pt-5 pb-4 border-b border-slate-100">
            <h1 className="text-base font-bold text-slate-900">Reçus de vente</h1>
            <p className="text-xs text-slate-400 mt-0.5">Extraction automatique par IA</p>
          </div>

          <div className="p-3 border-b border-slate-100">
            <UploadZone onUpload={handleUpload} uploading={uploading} />
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {loading ? (
              <div className="text-center py-8 text-slate-400 text-sm">Chargement…</div>
            ) : receipts.length === 0 ? (
              <div className="text-center py-8 text-slate-400 text-sm">
                <FileText size={24} className="mx-auto mb-2 opacity-40" />
                <p>Aucun reçu importé</p>
              </div>
            ) : (
              receipts.map(r => (
                <ReceiptItem
                  key={r.id}
                  receipt={r}
                  selected={selected?.id === r.id}
                  onClick={() => handleSelect(r)}
                  onDelete={() => setToDelete(r)}
                />
              ))
            )}
          </div>

          <div className="px-3 py-2 border-t border-slate-100">
            <p className="text-xs text-slate-400">{receipts.length} reçu{receipts.length !== 1 ? 's' : ''}</p>
          </div>
        </div>

        {/* Main detail area */}
        <div className="flex-1 bg-slate-50 overflow-hidden">
          <ReceiptDetail receipt={selected} onUpdate={updated => { setSelected(updated); setReceipts(rs => rs.map(r => r.id === updated.id ? updated : r)) }} />
        </div>
      </div>

      {/* Delete confirmation */}
      {toDelete && (
        <Modal title="Supprimer ce reçu" onClose={() => setToDelete(null)} size="sm">
          <p className="text-slate-600 text-sm">Voulez-vous supprimer le reçu <strong>{toDelete.company || toDelete.original_name}</strong> ? Cette action est irréversible.</p>
          <div className="flex justify-end gap-2 mt-4">
            <button className="btn-secondary" onClick={() => setToDelete(null)}>Annuler</button>
            <button className="btn-danger" onClick={() => handleDelete(toDelete.id)}>Supprimer</button>
          </div>
        </Modal>
      )}
    </Layout>
  )
}
