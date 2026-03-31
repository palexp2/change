import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { Modal } from '../components/Modal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

const STATUS_COLORS = {
  'Brouillon': 'gray',
  'Reçue': 'blue',
  'Approuvée': 'indigo',
  'Payée partiellement': 'yellow',
  'Payée': 'green',
  'En retard': 'red',
  'Annulée': 'gray',
}

function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { month: 'short', day: 'numeric', year: 'numeric' })
}

const RENDERS = {
  date_facture: row => <span className="text-slate-500">{fmtDate(row.date_facture)}</span>,
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

const COLUMNS = TABLE_COLUMN_META.factures_fournisseurs.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

const CATEGORIES = ['Fournitures', 'Voyage', 'Loyer', 'Assurance', 'Services', 'Équipement', 'Marketing', 'Logiciels', 'Autre']
const EMPTY_FORM = { bill_number: '', vendor: '', vendor_invoice_number: '', date_facture: new Date().toISOString().slice(0, 10), due_date: '', category: '', amount_cad: '', tax_cad: '', amount_paid_cad: '', status: 'Reçue', notes: '' }

function FactureModal({ facture, onClose, onSaved }) {
  const [form, setForm] = useState(facture
    ? { ...facture, amount_cad: facture.amount_cad ?? '', tax_cad: facture.tax_cad ?? '', amount_paid_cad: facture.amount_paid_cad ?? '' }
    : { ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const amt = parseFloat(form.amount_cad) || 0
      const tax = parseFloat(form.tax_cad) || 0
      const payload = { ...form, amount_cad: amt, tax_cad: tax, total_cad: amt + tax, amount_paid_cad: parseFloat(form.amount_paid_cad) || 0 }
      if (facture) {
        await api.facturesFournisseurs.update(facture.id, payload)
      } else {
        await api.facturesFournisseurs.create(payload)
      }
      onSaved()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const f = (k) => (e) => setForm(p => ({ ...p, [k]: e.target.value }))

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Fournisseur *</label>
          <input type="text" value={form.vendor} onChange={f('vendor')} className="input" required />
        </div>
        <div>
          <label className="label">Statut</label>
          <select value={form.status} onChange={f('status')} className="input">
            {['Brouillon', 'Reçue', 'Approuvée', 'Payée partiellement', 'Payée', 'En retard', 'Annulée'].map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label"># Facture (interne)</label>
          <input type="text" value={form.bill_number} onChange={f('bill_number')} className="input" />
        </div>
        <div>
          <label className="label"># Facture fournisseur</label>
          <input type="text" value={form.vendor_invoice_number} onChange={f('vendor_invoice_number')} className="input" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Date facture *</label>
          <input type="date" value={form.date_facture} onChange={f('date_facture')} className="input" required />
        </div>
        <div>
          <label className="label">Date d'échéance</label>
          <input type="date" value={form.due_date} onChange={f('due_date')} className="input" />
        </div>
      </div>
      <div>
        <label className="label">Catégorie</label>
        <select value={form.category} onChange={f('category')} className="input">
          <option value="">— Choisir —</option>
          {CATEGORIES.map(c => <option key={c}>{c}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="label">Montant avant taxes</label>
          <input type="number" step="0.01" min="0" value={form.amount_cad} onChange={f('amount_cad')} className="input" />
        </div>
        <div>
          <label className="label">Taxes (CAD)</label>
          <input type="number" step="0.01" min="0" value={form.tax_cad} onChange={f('tax_cad')} className="input" />
        </div>
        <div>
          <label className="label">Montant payé</label>
          <input type="number" step="0.01" min="0" value={form.amount_paid_cad} onChange={f('amount_paid_cad')} className="input" />
        </div>
      </div>
      <div>
        <label className="label">Notes</label>
        <textarea value={form.notes} onChange={f('notes')} className="input" rows={2} />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Enregistrement…' : 'Enregistrer'}</button>
      </div>
    </form>
  )
}

export default function FacturesFournisseurs() {
  const [factures, setFactures] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.facturesFournisseurs.list({ limit, page }),
      setFactures, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])

  function handleSaved() {
    setShowModal(false)
    setEditing(null)
    load()
  }

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Factures fournisseurs</h1>
            <p className="text-sm text-slate-500 mt-1">Comptes à payer</p>
          </div>
          <div className="flex items-center gap-2">
            <TableConfigModal table="factures_fournisseurs" />
            <button onClick={() => { setEditing(null); setShowModal(true) }} className="btn-primary">+ Nouvelle facture</button>
          </div>
        </div>

        <DataTable
          table="factures_fournisseurs"
          columns={COLUMNS}
          data={factures}
          loading={loading}
          onRowClick={row => { setEditing(row); setShowModal(true) }}
          searchFields={['vendor', 'bill_number', 'vendor_invoice_number', 'category']}
        />
      </div>

      {showModal && (
        <Modal title={editing ? 'Modifier la facture fournisseur' : 'Nouvelle facture fournisseur'} onClose={() => { setShowModal(false); setEditing(null) }}>
          <FactureModal facture={editing} onClose={() => { setShowModal(false); setEditing(null) }} onSaved={handleSaved} />
        </Modal>
      )}
    </Layout>
  )
}
