import { useMemo } from 'react'
import { Trash2 } from 'lucide-react'
import api from '../lib/api.js'
import { Badge } from '../components/Badge.jsx'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { DetailFieldGrid, DetailField } from '../components/DetailFieldGrid.jsx'
import { InlineText, InlineTextarea, InlineDate } from '../components/InlineFields.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useTable } from '../lib/dataStore.js'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { useRecordDeleteAllowed } from '../lib/detailFieldLayout.jsx'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { useAutosave } from '../lib/useAutosave.js'
import { fmtDate } from '../lib/formatDate.js'
import {
  OPS_AREA_OPTIONS, OPS_SEVERITY_OPTIONS, OPS_STATUS_OPTIONS,
  OPS_SEVERITY_COLORS, OPS_STATUS_COLORS,
} from '../lib/opsIssues.js'

// Fiche d'un problème d'opérations — toujours en panneau latéral (registre
// lib/recordPeekRoutes.jsx). Autosave champ par champ : la réponse du PATCH est
// fusionnée, ce qui rapatrie aussi la date de résolution posée par le serveur
// quand le statut passe à « Résolu ».
export default function OpsIssueDetail({ recordId: id, onClose }) {
  // « Suppression permise » : case du mode de personnalisation de la fiche.
  const canDelete = useRecordDeleteAllowed('ops_issues')
  const undoableDelete = useUndoableDelete()
  const { addToast } = useToast()
  const users = useTable('users')

  const { record: issue, setRecord: setIssue, loading, loadError, reload } =
    useDetailRecord(() => api.opsIssues.get(id), [id], { clearOnError: true })

  const { save, savingKeys } = useAutosave(issue, patch => api.opsIssues.update(id, patch), {
    onSaved: (updated) => setIssue(prev => (prev ? { ...prev, ...updated } : prev)),
    onError: () => reload(),
  })

  const userOptions = useMemo(
    () => users.map(u => ({ value: u.id, label: u.name })),
    [users],
  )

  // Suppression réversible (toast « Annuler » 8 s) : pas de confirmation à
  // cliquer avant.
  async function handleDelete() {
    try {
      await undoableDelete({
        table: 'ops_issues',
        id,
        deleteFn: () => api.opsIssues.delete(id),
        label: 'Problème supprimé',
      })
      onClose?.()
    } catch (e) {
      addToast({ message: e.message || 'Suppression échouée', type: 'error' })
    }
  }

  const pending = detailPending({ loading, loadError, onRetry: reload, record: issue, notFound: 'Problème introuvable.' })
  if (pending) return pending

  return (
    <DetailShell
      header={{
        badge: issue.status && <Badge color={OPS_STATUS_COLORS[issue.status] || 'gray'}>{issue.status}</Badge>,
        status: issue.severity && <Badge color={OPS_SEVERITY_COLORS[issue.severity] || 'gray'}>{issue.severity}</Badge>,
        meta: (
          <>
            {issue.area && <span>{issue.area}</span>}
            <span>{fmtDate(issue.occurred_at)}</span>
            {issue.reported_by_name && <span>{issue.reported_by_name}</span>}
          </>
        ),
        actions: canDelete && (
          <button
            onClick={handleDelete}
            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
            title="Supprimer ce problème"
            aria-label="Supprimer ce problème"
            data-testid="delete-ops-issue"
          >
            <Trash2 size={16} />
          </button>
        ),
      }}
    >
      <DetailFieldGrid
        entityType="ops_issues"
        record={issue}
        onSaveCustom={save}
        savingKeys={savingKeys}
        className="card p-5"
        testId="ops-issue-fields"
      >
        <DetailField id="title" label="Problème" span2 saving={savingKeys.title}>
          <InlineText value={issue.title} required saving={savingKeys.title} onSave={v => save('title', v)} testId="ops-issue-title" />
        </DetailField>
        <DetailField id="occurred_at" label="Date" saving={savingKeys.occurred_at}>
          <InlineDate value={issue.occurred_at} saving={savingKeys.occurred_at} onSave={v => save('occurred_at', v)} testId="ops-issue-occurred-at" />
        </DetailField>
        <DetailField id="area" label="Secteur" saving={savingKeys.area}>
          <SearchableSelect
            value={issue.area || ''}
            options={OPS_AREA_OPTIONS}
            emptyOption="—"
            onChange={v => save('area', v)}
            className="input text-sm w-full"
            size="sm"
            testId="ops-issue-area"
          />
        </DetailField>
        <DetailField id="severity" label="Gravité" saving={savingKeys.severity}>
          <SearchableSelect
            value={issue.severity || ''}
            options={OPS_SEVERITY_OPTIONS}
            emptyOption="—"
            onChange={v => save('severity', v)}
            className="input text-sm w-full"
            size="sm"
            testId="ops-issue-severity"
          />
        </DetailField>
        <DetailField id="status" label="Statut" saving={savingKeys.status}>
          <SearchableSelect
            value={issue.status || ''}
            options={OPS_STATUS_OPTIONS}
            onChange={v => save('status', v)}
            className="input text-sm w-full"
            size="sm"
            testId="ops-issue-status"
          />
        </DetailField>
        <DetailField id="reported_by_name" label="Signalé par" saving={savingKeys.reported_by}>
          <SearchableSelect
            value={issue.reported_by || ''}
            options={userOptions}
            emptyOption="—"
            onChange={v => save('reported_by', v)}
            className="input text-sm w-full"
            size="sm"
            testId="ops-issue-reported-by"
          />
        </DetailField>
        <DetailField id="description" label="Détails" span2 saving={savingKeys.description}>
          <InlineTextarea value={issue.description} saving={savingKeys.description} onSave={v => save('description', v)} testId="ops-issue-description" />
        </DetailField>
        <DetailField id="resolution" label="Correctif" span2 saving={savingKeys.resolution}>
          <InlineTextarea value={issue.resolution} saving={savingKeys.resolution} onSave={v => save('resolution', v)} testId="ops-issue-resolution" />
        </DetailField>
        {/* Posée par le serveur au passage à « Résolu » — jamais saisie. */}
        <DetailField id="resolved_at" label="Résolu le">
          <div className="text-sm text-slate-700">{issue.resolved_at ? fmtDate(issue.resolved_at) : '—'}</div>
        </DetailField>
      </DetailFieldGrid>
    </DetailShell>
  )
}
