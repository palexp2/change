import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

const RENDERS = {
  full_name: row => (
    <div className="font-medium text-slate-900">{row.first_name} {row.last_name}</div>
  ),
  company_name: row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-indigo-600 hover:underline">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  language: row => row.language
    ? <Badge color={row.language === 'French' ? 'blue' : 'green'}>{row.language === 'French' ? 'FR' : 'EN'}</Badge>
    : null,
}

const COLUMNS = TABLE_COLUMN_META.contacts.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

function fieldTypeInput(type) {
  if (type === 'number') return 'number'
  if (type === 'date') return 'date'
  if (type === 'url') return 'url'
  if (type === 'email') return 'email'
  return 'text'
}

function ContactForm({ initial = {}, companies = [], customFields = [], onSave, onClose }) {
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', phone: '', mobile: '',
    company_id: '', language: '',
    ...initial,
    extra_fields: { ...(initial.extra_fields || {}) }
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try { await onSave(form); onClose() }
    catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Prénom *</label>
          <input value={form.first_name} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))} className="input" required />
        </div>
        <div>
          <label className="label">Nom *</label>
          <input value={form.last_name} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))} className="input" required />
        </div>
        <div>
          <label className="label">Courriel</label>
          <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Téléphone</label>
          <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Mobile</label>
          <input value={form.mobile} onChange={e => setForm(f => ({ ...f, mobile: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Langue</label>
          <select value={form.language} onChange={e => setForm(f => ({ ...f, language: e.target.value }))} className="select">
            <option value="">—</option>
            <option value="French">Français</option>
            <option value="English">Anglais</option>
          </select>
        </div>
        <div className="col-span-2">
          <label className="label">Entreprise</label>
          <select value={form.company_id} onChange={e => setForm(f => ({ ...f, company_id: e.target.value }))} className="select">
            <option value="">— Aucune entreprise —</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        {customFields.map(cf => (
          <div key={cf.key} className="col-span-2">
            <label className="label">{cf.label}</label>
            <input type={fieldTypeInput(cf.field_type)}
              value={form.extra_fields?.[cf.key] || ''}
              onChange={e => setForm(f => ({ ...f, extra_fields: { ...f.extra_fields, [cf.key]: e.target.value } }))}
              className="input" />
          </div>
        ))}
      </div>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Enregistrement...' : 'Enregistrer'}</button>
      </div>
    </form>
  )
}

export default function Contacts() {
  const navigate = useNavigate()
  const [contacts, setContacts] = useState([])
  const [companies, setCompanies] = useState([])
  const [customFields, setCustomFields] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.contacts.list({ limit: 'all' })
      setContacts(res.data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.companies.list({ limit: 'all' }).then(r => setCompanies(r.data)).catch(() => {})
    api.fieldDefs.list('contacts').then(setCustomFields).catch(() => {})
  }, [])

  async function handleCreate(form) {
    await api.contacts.create(form)
    load()
  }

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Contacts</h1>
            <p className="text-slate-500 text-sm mt-1">{contacts.length} contacts</p>
          </div>
          <div className="flex items-center gap-2">
            <TableConfigModal table="contacts" />
            <button onClick={() => setShowModal(true)} className="btn-primary">
              <Plus size={16} /> Nouveau contact
            </button>
          </div>
        </div>

        <DataTable
          table="contacts"
          columns={COLUMNS}
          data={contacts}
          loading={loading}
          onRowClick={row => navigate(`/contacts/${row.id}`)}
          searchFields={['first_name', 'last_name', 'email', 'phone']}
        />
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nouveau contact">
        <ContactForm companies={companies} customFields={customFields} onSave={handleCreate} onClose={() => setShowModal(false)} />
      </Modal>
    </Layout>
  )
}
