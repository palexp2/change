import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { Plus, FileDown, Trash2, ChevronUp, ChevronDown } from 'lucide-react'
import { fmtDate } from '../lib/formatDate.js'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { useToast } from '../contexts/ToastContext.jsx'

function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}


const STATUS_COLORS = {
  'Brouillon': 'gray',
  'Envoyée': 'blue',
  'Acceptée': 'green',
  'Refusée': 'red',
  'Expirée': 'orange',
}

// ── Create modal ──────────────────────────────────────────────────────────────

function CreateModal({ onClose, onCreated }) {
  const { addToast } = useToast()
  const [catalog, setCatalog] = useState([])
  const [companies, setCompanies] = useState([])
  const [contacts, setContacts] = useState([])
  const [form, setForm] = useState({
    company_id: '',
    contact_id: '',
    language: 'French',
    status: 'Brouillon',
    title: '',
    notes: '',
    expiration_date: '',
  })
  const [items, setItems] = useState([])
  const [saving, setSaving] = useState(false)
  const [step, setStep] = useState(1) // 1: info, 2: items

  useEffect(() => {
    api.catalog.list().then(setCatalog).catch(console.error)
    api.companies.lookup().then(setCompanies).catch(console.error)
  }, [])

  useEffect(() => {
    if (form.company_id) {
      api.contacts.list({ company_id: form.company_id, limit: 'all' })
        .then(r => setContacts(r.data || []))
        .catch(console.error)
    } else {
      setContacts([])
      setForm(f => ({ ...f, contact_id: '' }))
    }
  }, [form.company_id])

  const addItem = (product) => {
    setItems(prev => {
      const existing = prev.find(i => i.catalog_product_id === product.id)
      if (existing) {
        return prev.map(i => i.catalog_product_id === product.id ? { ...i, qty: i.qty + 1 } : i)
      }
      return [...prev, {
        catalog_product_id: product.id,
        name_fr: product.name_fr,
        name_en: product.name_en,
        description_fr: product.name_fr,
        description_en: product.name_en,
        qty: 1,
        unit_price_cad: product.unit_price_cad || 0,
      }]
    })
  }

  const removeItem = (idx) => setItems(prev => prev.filter((_, i) => i !== idx))
  const updateItem = (idx, key, val) => setItems(prev => prev.map((it, i) => i === idx ? { ...it, [key]: val } : it))

  const subtotal = items.reduce((sum, it) => sum + (it.qty || 1) * (it.unit_price_cad || 0), 0)

  const moveItem = (idx, dir) => {
    setItems(prev => {
      const arr = [...prev]
      const target = idx + dir
      if (target < 0 || target >= arr.length) return arr
      ;[arr[idx], arr[target]] = [arr[target], arr[idx]]
      return arr
    })
  }

  const save = async () => {
    setSaving(true)
    try {
      const result = await api.documents.soumissions.create({
        ...form,
        company_id: form.company_id || null,
        contact_id: form.contact_id || null,
        expiration_date: form.expiration_date || null,
        items: items.map(it => ({
          catalog_product_id: it.catalog_product_id,
          qty: it.qty,
          unit_price_cad: it.unit_price_cad,
          description_fr: it.description_fr,
          description_en: it.description_en,
        })),
      })
      onCreated(result)
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const isFr = form.language !== 'English'

  return (
    <Modal onClose={onClose} title="Nouvelle soumission" size="xl">
      <div className="flex gap-4 mb-6">
        {[{ n: 1, label: 'Informations' }, { n: 2, label: 'Articles' }].map(s => (
          <button key={s.n} onClick={() => setStep(s.n)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${step === s.n ? 'bg-indigo-100 text-indigo-700' : 'text-slate-500 hover:text-slate-700'}`}>
            {s.n}. {s.label}
          </button>
        ))}
      </div>

      {step === 1 && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Entreprise</label>
              <LinkedRecordField
                name="soumission_company_id"
                value={form.company_id}
                options={companies}
                labelFn={c => c.name}
                placeholder="Entreprise"
                onChange={v => setForm(f => ({ ...f, company_id: v }))}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Contact</label>
              <LinkedRecordField
                name="soumission_contact_id"
                value={form.contact_id}
                options={contacts}
                labelFn={c => `${c.first_name || ''} ${c.last_name || ''}`.trim()}
                placeholder="Contact"
                onChange={v => setForm(f => ({ ...f, contact_id: v }))}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Titre</label>
            <input className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="Titre de la soumission"
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Langue du client</label>
              <select className="w-full border rounded-lg px-3 py-2 text-sm"
                value={form.language}
                onChange={e => setForm(f => ({ ...f, language: e.target.value }))}>
                <option value="French">Français</option>
                <option value="English">English</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Statut</label>
              <select className="w-full border rounded-lg px-3 py-2 text-sm"
                value={form.status}
                onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                {Object.keys(STATUS_COLORS).map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Date d'expiration</label>
              <input type="date" className="w-full border rounded-lg px-3 py-2 text-sm"
                value={form.expiration_date}
                onChange={e => setForm(f => ({ ...f, expiration_date: e.target.value }))} />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Notes</label>
            <textarea className="w-full border rounded-lg px-3 py-2 text-sm" rows={3}
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>

          <div className="flex justify-end">
            <button onClick={() => setStep(2)}
              className="bg-indigo-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700">
              Suivant : Articles →
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          {/* Catalog picker */}
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Catalogue</p>
            <div className="grid grid-cols-2 gap-2">
              {catalog.filter(p => p.active !== 0).map(p => (
                <button key={p.id} onClick={() => addItem(p)}
                  className="text-left border rounded-lg p-3 hover:border-indigo-400 hover:bg-indigo-50 transition-colors">
                  <div className="font-medium text-sm text-slate-900">{isFr ? p.name_fr : p.name_en}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{fmtCad(p.unit_price_cad)}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Items list */}
          {items.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Articles sélectionnés</p>
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b">
                      <th className="px-3 py-2 text-left text-xs text-slate-500">Description</th>
                      <th className="px-3 py-2 text-center text-xs text-slate-500 w-20">Qté</th>
                      <th className="px-3 py-2 text-right text-xs text-slate-500 w-28">Prix unit.</th>
                      <th className="px-3 py-2 text-right text-xs text-slate-500 w-24">Total</th>
                      <th className="w-16"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, idx) => (
                      <tr key={idx} className="border-b last:border-0">
                        <td className="px-3 py-2">
                          <input className="w-full text-sm border-0 outline-none"
                            value={isFr ? it.description_fr : it.description_en}
                            onChange={e => updateItem(idx, isFr ? 'description_fr' : 'description_en', e.target.value)} />
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" min="1" className="w-16 text-center border rounded px-2 py-0.5 text-sm"
                            value={it.qty}
                            onChange={e => updateItem(idx, 'qty', parseInt(e.target.value) || 1)} />
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" min="0" step="0.01" className="w-24 text-right border rounded px-2 py-0.5 text-sm"
                            value={it.unit_price_cad}
                            onChange={e => updateItem(idx, 'unit_price_cad', parseFloat(e.target.value) || 0)} />
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-slate-700">
                          {fmtCad((it.qty || 1) * (it.unit_price_cad || 0))}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1">
                            <button onClick={() => moveItem(idx, -1)} className="text-slate-300 hover:text-slate-500"><ChevronUp size={14} /></button>
                            <button onClick={() => moveItem(idx, 1)} className="text-slate-300 hover:text-slate-500"><ChevronDown size={14} /></button>
                            <button onClick={() => removeItem(idx)} className="text-slate-300 hover:text-red-500 ml-1"><Trash2 size={14} /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-50">
                      <td colSpan={3} className="px-3 py-2 text-right text-sm font-semibold text-slate-700">
                        {isFr ? 'Sous-total (avant taxes)' : 'Subtotal (before tax)'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-slate-900">{fmtCad(subtotal)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            <button onClick={() => setStep(1)} className="text-slate-500 text-sm hover:text-slate-700">
              ← Retour
            </button>
            <button onClick={save} disabled={saving}
              className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
              {saving ? 'Génération du PDF…' : 'Créer et générer PDF'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

const RENDERS = {
  title: row => (
    <div>
      <div className="font-medium text-slate-900">{row.title || <span className="text-slate-400 italic">Sans titre</span>}</div>
      {row.contact_name && <div className="text-xs text-slate-500">{row.contact_name}</div>}
    </div>
  ),
  company_name: row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-indigo-600 hover:underline text-sm">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  status: row => row.status
    ? <Badge color={STATUS_COLORS[row.status] || 'gray'}>{row.status}</Badge>
    : <span className="text-slate-400">—</span>,
  created_at: row => <span className="text-sm text-slate-600">{fmtDate(row.created_at)}</span>,
  expiration_date: row => <span className="text-sm text-slate-600">{fmtDate(row.expiration_date)}</span>,
  pdf: row => row.generated_pdf_path
    ? <a
        href={`/erp/api/documents/soumissions/${row.id}/pdf`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}
        className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800 text-sm"
      >
        <FileDown size={15} /> PDF
      </a>
    : <span className="text-slate-300">—</span>,
}

const COLUMNS = TABLE_COLUMN_META.soumissions.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function Soumissions() {
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const navigate = useNavigate()

  const load = useCallback(async () => {
    try {
      const res = await api.documents.soumissions.list({ limit: 'all' })
      setRows(res.data || [])
      setTotal(res.total || (res.data || []).length)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <Layout>
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Soumissions</h1>
            <p className="text-sm text-slate-500 mt-1">{total} soumission{total !== 1 ? 's' : ''}</p>
          </div>
          <div className="flex items-center gap-2">
            <TableConfigModal table="soumissions" />
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700"
            >
              <Plus size={16} /> Nouvelle soumission
            </button>
          </div>
        </div>

        <DataTable
          table="soumissions"
          columns={COLUMNS}
          data={rows}
          loading={loading}
          onRowClick={row => navigate(`/soumissions/${row.id}`)}
          searchFields={['title', 'company_name', 'contact_name']}
        />

        {showCreate && (
          <CreateModal
            onClose={() => setShowCreate(false)}
            onCreated={(result) => {
              setShowCreate(false)
              navigate(`/soumissions/${result.id}`)
            }}
          />
        )}
      </div>
    </Layout>
  )
}
