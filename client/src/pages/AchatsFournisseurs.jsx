import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { Modal } from '../components/Modal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { VendorSelect } from '../components/VendorSelect.jsx'
import { LineItemsTable } from '../components/LineItemsTable.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { fmtDate } from '../lib/formatDate.js'

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

function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

const RENDERS = {
  type: row => row.type === 'bill'
    ? <Badge color="indigo">Facture</Badge>
    : <Badge color="slate">Dépense</Badge>,
  vendor: row => row.vendor_id
    ? <Link to={`/companies/${row.vendor_id}`} onClick={e => e.stopPropagation()} className="text-indigo-600 hover:underline">{row.vendor}</Link>
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
}

const COLUMNS = TABLE_COLUMN_META.achats_fournisseurs.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

function emptyForm(type) {
  const today = new Date().toISOString().slice(0, 10)
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

  function fmtSize(n) {
    if (!n) return '—'
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(1)} MB`
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
                    className="text-indigo-600 hover:underline truncate block text-left"
                  >
                    {it.file_name}
                  </button>
                ) : (
                  <span className="text-slate-500 italic">Note</span>
                )}
                {it.note && <p className="text-xs text-slate-500 truncate">{it.note}</p>}
              </div>
              <span className="text-xs text-slate-400 tabular-nums whitespace-nowrap">{fmtSize(it.file_size)}</span>
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

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.achatsFournisseurs.list({ limit, page }),
      setRows, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const openId = p.get('id')
    if (!openId || rows.length === 0) return
    const row = rows.find(r => r.id === openId)
    if (row) setEditing(row)
  }, [rows])

  async function handleQBImport() {
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
      <div className="p-6 max-w-7xl mx-auto">
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
            <button onClick={handleQBImport} disabled={syncing} className="btn-secondary">
              {syncing ? 'Importation…' : 'Importer depuis QB'}
            </button>
            <TableConfigModal table="achats_fournisseurs" />
          </div>
        </div>

        <DataTable
          table="achats_fournisseurs"
          columns={COLUMNS}
          data={rows}
          loading={loading}
          onRowClick={row => setEditing(row)}
          searchFields={['vendor', 'description', 'reference', 'vendor_invoice_number', 'bill_number', 'category']}
        />
      </div>

      <Modal isOpen={modalOpen} title={modalTitle} onClose={() => { setCreating(null); setEditing(null) }}>
        <AchatModal
          achat={editing}
          initialType={creating}
          onClose={() => { setCreating(null); setEditing(null) }}
          onSaved={handleSaved}
        />
      </Modal>
    </Layout>
  )
}
