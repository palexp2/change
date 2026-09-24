import DiscoveryFormOptions, { CountStepper } from '../components/DiscoveryFormOptions.jsx'
import DiscoveryExtrasTable, { additionalEquipment } from '../components/DiscoveryExtrasTable.jsx'
import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Plus, ExternalLink, Copy, Check, Pencil } from 'lucide-react'
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
  const { addToast } = useToast()
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  if (!url) return <span className="text-slate-400">—</span>
  return (
    <div className="inline-flex items-center gap-1">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="link-record inline-flex items-center gap-1 text-sm"
      >
        <ExternalLink size={12} /> Ouvrir
      </a>
      <button
        onClick={(e) => {
          e.stopPropagation()
          navigator.clipboard.writeText(url).then(() => {
            setCopied(true)
            clearTimeout(timer.current)
            timer.current = setTimeout(() => setCopied(false), 1500)
          }).catch(() => addToast({ message: 'Copie impossible. Utilisez le lien Ouvrir.', type: 'error' }))
        }}
        className="text-slate-500 hover:text-slate-700 p-1 rounded"
        title={copied ? 'Lien copié' : 'Copier le lien'}
        aria-label={copied ? 'Lien copié' : 'Copier le lien du formulaire'}
      >
        {copied ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
      </button>
    </div>
  )
}

const RENDERS = {
  form_number: (row) => row.sys_number ? <span className="tabular-nums">{row.sys_number}</span> : <span className="text-slate-400">—</span>,
  company_name: (row) => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="link-record text-sm">{row.company_name || row.company_id}</Link>
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
    fetch: async (page, limit) => ({ data: ((await api.discoveryForms.list({ limit, page })).rows || []).map(r => ({ ...r, sys_number: r.form_number ? `SYS-${r.form_number}` : '' })) }),
  })

  useEffect(() => {
    api.companies.lookup().then(setCompanies).catch(() => {})
  }, [])

  async function handleCreate({ company_id, helper_count, chief_count, form_options }) {
    const created = await api.discoveryForms.create({
      company_id,
      form_options,
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
        <>
          <Link to="/discovery-form-editor" className="btn-ghost" title="Produits associés">
            <Pencil size={16} /> Produits associés
          </Link>
          <button onClick={() => setShowModal(true)} className="btn-primary">
            <Plus size={16} /> Nouveau formulaire
          </button>
        </>
      }
    >
      <DataTable
        table="discovery_forms"
        manageViews
        columns={COLUMNS}
        data={forms}
        loading={loading}
        peek={{
          title: row => [row.form_number && `SYS-${row.form_number}`, row.company_name].filter(Boolean).join(' · ') || 'System builder',
          subtitle: row => (row.status === 'submitted' ? 'Soumis' : 'En cours'),
          to: row => `/discovery-forms/${row.id}`,
          render: (row, { close }) => <DiscoveryFormDetail recordId={row.id} embedded onClose={close} onDeleted={load} />,
        }}
        searchFields={['sys_number', 'company_name', 'status']}
        onBulkDelete={async (ids) => {
          // Suppression définitive (la table n'est pas soft-delete) : pas de toast « Annuler ».
          await Promise.all(ids.map(id => api.discoveryForms.delete(id)))
          await load()
          addToast({ message: `${ids.length} système${ids.length > 1 ? 's' : ''} supprimé${ids.length > 1 ? 's' : ''}`, type: 'success' })
        }}
      />

      <Modal isOpen={showModal} title="Nouveau formulaire" onClose={() => setShowModal(false)}>
        <CreateForm companies={companies} onSave={handleCreate} onClose={() => setShowModal(false)} />
      </Modal>
    </ListPage>
  )
}

function CreateForm({ companies, onSave, onClose }) {
  const { addToast } = useToast()
  const [companyId, setCompanyId] = useState('')
  const [options, setOptions] = useState({ sensors: {} })
  const [helperCount, setHelperCount] = useState(0)
  const [chiefCount, setChiefCount] = useState(0)
  // Quantités supplémentaires par serre, clé stable par type (c0, h0…) pour
  // survivre à un changement du nombre de serres de l'autre type.
  const [extras, setExtras] = useState({})
  const [saving, setSaving] = useState(false)

  const chiefs = Math.max(0, Number(chiefCount) || 0)
  const total = (Number(helperCount) || 0) + chiefs
  const cards = Array.from({ length: Math.max(0, total) }, (_, i) => (i < chiefs ? { key: `c${i}`, helper: false } : { key: `h${i - chiefs}`, helper: true }))

  async function handleSubmit(e) {
    e.preventDefault()
    if (!companyId) { addToast({ message: 'Entreprise requise', type: 'error' }); return }
    if (total <= 0) { addToast({ message: 'Au moins une serre (Helper ou Chef de culture) requise', type: 'error' }); return }
    setSaving(true)
    try {
      const additional_equipment = additionalEquipment(extras, cards)
      await onSave({ company_id: companyId, helper_count: helperCount, chief_count: chiefCount, form_options: { ...options, additional_equipment } })
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
          <label htmlFor="system-chief-count" className="label">Nombre de Chef de culture</label>
          <CountStepper id="system-chief-count" label="Chef de culture" max={50} value={chiefCount} onChange={setChiefCount} />
        </div>
        <div>
          <label htmlFor="system-helper-count" className="label">Nombre de Helper</label>
          <CountStepper id="system-helper-count" label="Helper" max={50} value={helperCount} onChange={setHelperCount} />
        </div>
      </div>
      <DiscoveryExtrasTable cards={cards} values={extras} onChange={setExtras} disabled={saving} title="Permissions supplémentaires" stepper />
      <DiscoveryFormOptions value={options} onChange={setOptions} disabled={saving} />
      <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
        <button type="button" onClick={onClose} className="btn-ghost">Annuler</button>
        <button type="submit" disabled={saving || !companyId || total <= 0} className="btn-primary">
          {saving ? 'Création…' : 'Créer et ouvrir'}
        </button>
      </div>
    </form>
  )
}
