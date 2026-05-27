import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Plus, ExternalLink, Copy, Check } from 'lucide-react'
import { api } from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { useToast } from '../contexts/ToastContext.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'

function CopyLinkButton({ url }) {
  const [copied, setCopied] = useState(false)
  if (!url) return <span className="text-slate-400">—</span>
  return (
    <div className="inline-flex items-center gap-1">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="text-brand-600 hover:underline inline-flex items-center gap-1 text-sm"
      >
        <ExternalLink size={12} /> Ouvrir
      </a>
      <button
        onClick={(e) => {
          e.stopPropagation()
          navigator.clipboard.writeText(url).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
        className="text-slate-500 hover:text-slate-700 p-1 rounded"
        title="Copier le lien"
      >
        {copied ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
      </button>
    </div>
  )
}

const RENDERS = {
  company_name: (row) => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline text-sm">{row.company_name || row.company_id}</Link>
    : <span className="text-slate-400">—</span>,
  status: (row) => (
    <Badge color={row.status === 'submitted' ? 'green' : 'blue'} size="sm">
      {row.status === 'submitted' ? 'Soumis' : 'En cours'}
    </Badge>
  ),
  submitted_at: (row) => row.submitted_at ? fmtDate(row.submitted_at) : <span className="text-slate-400">—</span>,
  created_at: (row) => fmtDate(row.created_at),
  public_link: (row) => <CopyLinkButton url={row.public_url} />,
}

const COLUMNS = TABLE_COLUMN_META.discovery_forms.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function DiscoveryForms() {
  const [forms, setForms] = useState([])
  const [companies, setCompanies] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const undoableDelete = useUndoableDelete()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.discoveryForms.list({ limit: 'all' })
      setForms(data.rows || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    api.companies.lookup().then(setCompanies).catch(() => {})
  }, [])

  async function handleCreate({ company_id, helper_count, chief_count }) {
    const created = await api.discoveryForms.create({
      company_id,
      helper_count: Number(helper_count) || 0,
      chief_count: Number(chief_count) || 0,
    })
    setShowModal(false)
    await load()
    if (created?.public_url) {
      window.open(created.public_url, '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Formulaires de découverte</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {forms.length} formulaire{forms.length !== 1 ? 's' : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <TableConfigModal table="discovery_forms" bulkDelete />
            <button onClick={() => setShowModal(true)} className="btn-primary">
              <Plus size={16} /> Nouveau formulaire
            </button>
          </div>
        </div>

        <DataTable
          table="discovery_forms"
          columns={COLUMNS}
          data={forms}
          loading={loading}
          searchFields={['company_name', 'status']}
          onBulkDelete={async (ids) => {
            await undoableDelete({
              table: 'discovery_forms',
              ids,
              deleteFn: () => Promise.all(ids.map(id => api.discoveryForms.delete(id))),
              label: `${ids.length} formulaire${ids.length > 1 ? 's' : ''} supprimé${ids.length > 1 ? 's' : ''}`,
              onChange: load,
            })
          }}
        />
      </div>

      <Modal isOpen={showModal} title="Nouveau formulaire de découverte" onClose={() => setShowModal(false)}>
        <CreateForm companies={companies} onSave={handleCreate} onClose={() => setShowModal(false)} />
      </Modal>
    </Layout>
  )
}

function CreateForm({ companies, onSave, onClose }) {
  const { addToast } = useToast()
  const [companyId, setCompanyId] = useState('')
  const [helperCount, setHelperCount] = useState(0)
  const [chiefCount, setChiefCount] = useState(0)
  const [saving, setSaving] = useState(false)

  const total = (Number(helperCount) || 0) + (Number(chiefCount) || 0)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!companyId) { addToast({ message: 'Entreprise requise', type: 'error' }); return }
    if (total <= 0) { addToast({ message: 'Au moins une serre (Helper ou Chief) requise', type: 'error' }); return }
    setSaving(true)
    try {
      await onSave({ company_id: companyId, helper_count: helperCount, chief_count: chiefCount })
    } catch (err) {
      addToast({ message: err.message || 'Erreur lors de la création', type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Entreprise *</label>
        <LinkedRecordField
          name="discovery_company_id"
          value={companyId}
          options={companies}
          labelFn={c => c.name}
          getHref={c => `/companies/${c.id}`}
          placeholder="Rechercher une entreprise…"
          onChange={setCompanyId}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Nombre de Chief Grower</label>
          <input
            type="number" min={0} max={50}
            value={chiefCount}
            onChange={e => setChiefCount(e.target.value)}
            className="input"
          />
          <p className="text-xs text-slate-500 mt-1">1 carte serre par Chief.</p>
        </div>
        <div>
          <label className="label">Nombre de Helper</label>
          <input
            type="number" min={0} max={50}
            value={helperCount}
            onChange={e => setHelperCount(e.target.value)}
            className="input"
          />
          <p className="text-xs text-slate-500 mt-1">1 carte serre par Helper.</p>
        </div>
      </div>
      <div className="text-sm text-slate-600 bg-slate-50 rounded-lg p-3">
        Le formulaire générera <strong>{total}</strong> carte{total !== 1 ? 's' : ''} de serre.
        À la création, un lien public court sera généré et le formulaire s'ouvrira dans un nouvel onglet.
      </div>
      <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
        <button type="button" onClick={onClose} className="btn-ghost">Annuler</button>
        <button type="submit" disabled={saving || !companyId || total <= 0} className="btn-primary">
          {saving ? 'Création…' : 'Créer et ouvrir'}
        </button>
      </div>
    </form>
  )
}
