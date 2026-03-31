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
  'Soumis': 'blue',
  'Approuvé': 'green',
  'Refusé': 'red',
  'Remboursé': 'purple',
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
  date_depense: row => <span className="text-slate-500">{fmtDate(row.date_depense)}</span>,
  status: row => <Badge color={STATUS_COLORS[row.status] || 'gray'}>{row.status}</Badge>,
  amount_cad: row => <span className="tabular-nums">{fmtCad(row.amount_cad)}</span>,
  tax_cad: row => <span className="text-slate-400 tabular-nums">{fmtCad(row.tax_cad)}</span>,
  total_cad: row => <span className="font-medium tabular-nums">{fmtCad(row.total_cad)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.depenses.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

const CATEGORIES = ['Fournitures', 'Voyage', 'Repas', 'Loyer', 'Assurance', 'Services', 'Équipement', 'Marketing', 'Logiciels', 'Autre']
const PAYMENT_METHODS = ['Carte de crédit', 'Chèque', 'Virement', 'Comptant', 'Autre']

const EMPTY_FORM = { date_depense: new Date().toISOString().slice(0, 10), category: '', description: '', vendor: '', reference: '', amount_cad: '', tax_cad: '', payment_method: '', status: 'Brouillon', notes: '' }

function DepenseModal({ depense, onClose, onSaved }) {
  const [form, setForm] = useState(depense ? { ...depense, amount_cad: depense.amount_cad ?? '', tax_cad: depense.tax_cad ?? '' } : { ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const payload = { ...form, amount_cad: parseFloat(form.amount_cad) || 0, tax_cad: parseFloat(form.tax_cad) || 0 }
      if (depense) {
        await api.depenses.update(depense.id, payload)
      } else {
        await api.depenses.create(payload)
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
          <label className="label">Date *</label>
          <input type="date" value={form.date_depense} onChange={f('date_depense')} className="input" required />
        </div>
        <div>
          <label className="label">Statut</label>
          <select value={form.status} onChange={f('status')} className="input">
            {['Brouillon', 'Soumis', 'Approuvé', 'Refusé', 'Remboursé'].map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="label">Description *</label>
        <input type="text" value={form.description} onChange={f('description')} className="input" required />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Catégorie</label>
          <select value={form.category} onChange={f('category')} className="input">
            <option value="">— Choisir —</option>
            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Mode de paiement</label>
          <select value={form.payment_method} onChange={f('payment_method')} className="input">
            <option value="">— Choisir —</option>
            {PAYMENT_METHODS.map(m => <option key={m}>{m}</option>)}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Fournisseur</label>
          <input type="text" value={form.vendor} onChange={f('vendor')} className="input" />
        </div>
        <div>
          <label className="label">Référence</label>
          <input type="text" value={form.reference} onChange={f('reference')} className="input" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Montant (CAD)</label>
          <input type="number" step="0.01" min="0" value={form.amount_cad} onChange={f('amount_cad')} className="input" />
        </div>
        <div>
          <label className="label">Taxes (CAD)</label>
          <input type="number" step="0.01" min="0" value={form.tax_cad} onChange={f('tax_cad')} className="input" />
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

export default function Depenses() {
  const [depenses, setDepenses] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.depenses.list({ limit, page }),
      setDepenses, setLoading
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
            <h1 className="text-2xl font-bold text-slate-900">Dépenses</h1>
          </div>
          <div className="flex items-center gap-2">
            <TableConfigModal table="depenses" />
            <button onClick={() => { setEditing(null); setShowModal(true) }} className="btn-primary">+ Nouvelle dépense</button>
          </div>
        </div>

        <DataTable
          table="depenses"
          columns={COLUMNS}
          data={depenses}
          loading={loading}
          onRowClick={row => { setEditing(row); setShowModal(true) }}
          searchFields={['description', 'vendor', 'reference', 'category']}
        />
      </div>

      {showModal && (
        <Modal title={editing ? 'Modifier la dépense' : 'Nouvelle dépense'} onClose={() => { setShowModal(false); setEditing(null) }}>
          <DepenseModal depense={editing} onClose={() => { setShowModal(false); setEditing(null) }} onSaved={handleSaved} />
        </Modal>
      )}
    </Layout>
  )
}
