import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Plus, ExternalLink, Copy, Check } from 'lucide-react'
import { api } from '../lib/api.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import DiscoveryFormDetail from './DiscoveryFormDetail.jsx'
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
  const [companies, setCompanies] = useState([])
  const [showModal, setShowModal] = useState(false)
  const { addToast } = useToast()

  // La route renvoie `{ rows }` et non `{ data }`.
  const { rows: forms, loading, reload: load } = useListData({
    fetch: async (page, limit) => ({ data: (await api.discoveryForms.list({ limit, page })).rows || [] }),
  })

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
    <ListPage
      title="System builder"
      subtitle={
        <p className="text-sm text-slate-500 mt-0.5">
          {forms.length} système{forms.length !== 1 ? 's' : ''}
        </p>
      }
      actions={
        <button onClick={() => setShowModal(true)} className="btn-primary">
          <Plus size={16} /> Nouveau système
        </button>
      }
    >
      <DataTable
        table="discovery_forms"
        manageViews
        columns={COLUMNS}
        data={forms}
        loading={loading}
        peek={{
          title: row => row.company_name || 'System builder',
          subtitle: row => (row.status === 'submitted' ? 'Soumis' : 'En cours'),
          to: row => `/discovery-forms/${row.id}`,
          render: (row, { close }) => <DiscoveryFormDetail recordId={row.id} embedded onClose={close} onDeleted={load} />,
        }}
        searchFields={['company_name', 'status']}
        onBulkDelete={async (ids) => {
          // Suppression définitive (la table n'est pas soft-delete) : pas de toast « Annuler ».
          await Promise.all(ids.map(id => api.discoveryForms.delete(id)))
          await load()
          addToast({ message: `${ids.length} système${ids.length > 1 ? 's' : ''} supprimé${ids.length > 1 ? 's' : ''}`, type: 'success' })
        }}
      />

      <Modal isOpen={showModal} title="Nouveau système" onClose={() => setShowModal(false)}>
        <CreateForm companies={companies} onSave={handleCreate} onClose={() => setShowModal(false)} />
      </Modal>
    </ListPage>
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
        <strong>{total}</strong> carte{total !== 1 ? 's' : ''} de serre. Un lien public court sera
        généré et s'ouvrira dans un nouvel onglet.
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
