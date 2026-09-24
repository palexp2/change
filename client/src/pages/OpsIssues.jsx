import { useMemo } from 'react'
import { Plus, AlertTriangle } from 'lucide-react'
import api from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { useTable } from '../lib/dataStore.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { Badge } from '../components/Badge.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import {
  OPS_AREAS, OPS_SEVERITIES, OPS_STATUSES,
  OPS_SEVERITY_COLORS, OPS_STATUS_COLORS,
} from '../lib/opsIssues.js'
import OpsIssueDetail from './OpsIssueDetail.jsx'

const RENDERS = {
  occurred_at: row => <span className="text-slate-500">{fmtDate(row.occurred_at)}</span>,
  title: row => <span className="text-slate-800 truncate">{row.title}</span>,
  severity: row => (row.severity
    ? <Badge color={OPS_SEVERITY_COLORS[row.severity] || 'gray'}>{row.severity}</Badge>
    : <span className="text-slate-300">—</span>),
  status: row => (row.status
    ? <Badge color={OPS_STATUS_COLORS[row.status] || 'gray'}>{row.status}</Badge>
    : <span className="text-slate-300">—</span>),
  resolved_at: row => <span className="text-slate-500">{fmtDate(row.resolved_at)}</span>,
  created_at: row => <span className="text-slate-500">{fmtDate(row.created_at)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.ops_issues.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

const today = () => new Date().toISOString().slice(0, 10)

// Champs du formulaire « Nouveau problème ». `includeAllFields` y ajoute les
// champs personnalisés de la table (/champs/ops_issues), que la route de
// création sait persister.
const FORM_FIELDS = [
  { field: 'title', label: 'Problème', span: 2, locked: true, required: true },
  { field: 'occurred_at', label: 'Date', type: 'date', defaultValue: today() },
  { field: 'area', label: 'Secteur', type: 'select', options: OPS_AREAS },
  { field: 'severity', label: 'Gravité', type: 'select', options: OPS_SEVERITIES, defaultValue: 'Moyen' },
  { field: 'status', label: 'Statut', type: 'select', options: OPS_STATUSES, defaultValue: 'Ouvert' },
  { field: 'description', label: 'Détails', type: 'textarea', span: 2, rows: 3 },
]

// Journal des problèmes d'opérations : ce qui a coincé, où, et si c'est réglé.
export default function OpsIssues() {
  const { user } = useAuth()
  const undoableDelete = useUndoableDelete()
  const users = useTable('users')

  const { rows, loading, setRows, reload } = useListData({
    fetch: (page, limit) => api.opsIssues.list({ limit, offset: limit === 'all' ? 0 : (page - 1) * limit }),
    cacheKey: 'ops_issues',
    realtime: 'ops_issue',
  })

  // Le nom du signaleur vient du cache des utilisateurs — comme l'assignation
  // d'un billet : la route ne joint rien.
  const issues = useMemo(() => {
    const byId = new Map(users.map(u => [u.id, u.name]))
    return rows.map(r => ({ ...r, reported_by_name: byId.get(r.reported_by) || r.reported_by_name }))
  }, [rows, users])

  const openCount = useMemo(() => issues.filter(i => i.status !== 'Résolu').length, [issues])

  async function handleCreate(form) {
    await api.opsIssues.create({ reported_by: user?.id || null, ...form })
    await reload()
  }

  return (
    <ListPage
      title="Problèmes d'opérations"
      icon={AlertTriangle}
      titleExtra={openCount > 0 && <Badge color="red">{openCount} à régler</Badge>}
      create={{
        label: 'Nouveau problème',
        table: 'ops_issues',
        fields: FORM_FIELDS,
        includeAllFields: true,
        columns: 2,
        size: 'lg',
        onSubmit: handleCreate,
      }}
    >
      {({ openCreate }) => (
        <DataTable
          table="ops_issues"
          formulaUseColumnLabels
          manageViews
          columns={COLUMNS}
          data={issues}
          loading={loading}
          searchFields={['title', 'description', 'resolution', 'area', 'reported_by_name']}
          peek={{
            title: row => row.title || 'Problème',
            subtitle: row => [row.area, row.status].filter(Boolean).join(' · '),
            to: row => `/problemes-operations/${row.id}`,
            width: 720,
            render: (row, { close }) => <OpsIssueDetail recordId={row.id} onClose={close} />,
          }}
          onBulkDelete={async (ids) => {
            await undoableDelete({
              table: 'ops_issues',
              ids,
              deleteFn: () => Promise.all(ids.map(i => api.opsIssues.delete(i))),
              label: `${ids.length} problème${ids.length > 1 ? 's' : ''} supprimé${ids.length > 1 ? 's' : ''}`,
              onChange: () => setRows(prev => prev.filter(r => !ids.includes(r.id))),
            })
            await reload()
          }}
          emptyState={{
            icon: AlertTriangle,
            title: 'Aucun problème',
            description: "Note ici ce qui a coincé dans les opérations : pièce manquante, colis mal parti, machine arrêtée.",
            cta: { label: 'Nouveau problème', icon: Plus, onClick: openCreate },
          }}
        />
      )}
    </ListPage>
  )
}
