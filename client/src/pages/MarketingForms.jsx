import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw, ClipboardList } from 'lucide-react'
import api from '../lib/api.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import ErrorBanner from '../components/ErrorBanner.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'

// Marketing → Formulaires : formulaires de capture de leads, miroir de HubSpot
// (synchro horaire côté serveur + bouton). La création pousse dans HubSpot.

const RENDERS = {
  name: row => <span className="font-medium text-slate-800">{row.name}</span>,
  language: row => <span className="uppercase text-xs text-slate-500">{row.language || '—'}</span>,
  field_count: row => <span className="tabular-nums text-slate-600">{row.field_count}</span>,
  submission_count: row => <span className="tabular-nums font-medium text-slate-800">{row.submission_count || 0}</span>,
  last_submission_at: row => <span className="text-slate-500">{row.last_submission_at ? fmtDate(row.last_submission_at) : '—'}</span>,
  hs_updated_at: row => <span className="text-slate-500">{fmtDate(row.hs_updated_at)}</span>,
  hs_created_at: row => <span className="text-slate-500">{fmtDate(row.hs_created_at)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.marketing_forms.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

function FieldPicker({ value, onChange, presets }) {
  const selected = value || []
  const toggle = key => onChange(selected.includes(key) ? selected.filter(k => k !== key) : [...selected, key])
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="form-field-picker">
      {presets.map(p => {
        const on = p.required || selected.includes(p.key)
        return (
          <button
            key={p.key}
            type="button"
            disabled={p.required}
            onClick={() => toggle(p.key)}
            className={`px-2.5 py-1 rounded-full text-xs border ${on
              ? 'bg-brand-50 border-brand-300 text-brand-700'
              : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'}`}
          >
            {p.label}
          </button>
        )
      })}
    </div>
  )
}

export default function MarketingForms() {
  const navigate = useNavigate()
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState(null)
  const [presets, setPresets] = useState([])

  const { rows, loading, reload } = useListData({
    fetch: () => api.marketingForms.list(),
    cacheKey: 'marketing_forms',
  })

  useEffect(() => { api.marketingForms.fieldPresets().then(setPresets).catch(() => {}) }, [])

  async function handleSync() {
    setSyncing(true)
    setError(null)
    try {
      await api.marketingForms.sync()
      await reload()
    } catch (e) {
      setError(e.message)
    } finally {
      setSyncing(false)
    }
  }

  async function handleCreate(values) {
    const created = await api.marketingForms.create(values)
    await reload()
    navigate(`/formulaires/${created.id}`)
  }

  return (
    <ListPage
      title="Formulaires"
      icon={ClipboardList}
      actions={
        <button onClick={handleSync} disabled={syncing} className="btn-secondary" title="Synchroniser avec HubSpot" data-testid="forms-sync">
          <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} /> HubSpot
        </button>
      }
      create={{
        label: 'Nouveau formulaire',
        table: 'marketing_forms',
        submitLabel: 'Créer dans HubSpot',
        onSubmit: handleCreate,
        fields: [
          { field: 'name', label: 'Nom', required: true, locked: true },
          { field: 'language', label: 'Langue', type: 'select', options: [{ value: 'fr', label: 'Français' }, { value: 'en', label: 'English' }], defaultValue: 'fr' },
          {
            field: 'fields', label: 'Champs', defaultValue: ['firstname', 'lastname', 'email'],
            input: ({ value, onChange }) => <FieldPicker value={value} onChange={onChange} presets={presets} />,
          },
          { field: 'submit_text', label: 'Bouton', visible: false },
          { field: 'thank_you', label: 'Message de remerciement', type: 'textarea', rows: 2, visible: false },
        ],
      }}
      banner={error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}
    >
      <DataTable
        table="marketing_forms"
        manageViews
        columns={COLUMNS}
        data={rows}
        loading={loading}
        searchFields={['name']}
        onRowClick={row => navigate(`/formulaires/${row.id}`)}
        emptyState={{ icon: ClipboardList, title: 'Aucun formulaire', cta: { label: 'Synchroniser HubSpot', icon: RefreshCw, onClick: handleSync } }}
      />
    </ListPage>
  )
}
