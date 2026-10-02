import { useState } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw, ExternalLink, Copy, Check, RotateCcw } from 'lucide-react'
import api from '../lib/api.js'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { useAutosave } from '../lib/useAutosave.js'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate, fmtDateTime } from '../lib/formatDate.js'

// Fiche d'un formulaire HubSpot : nom (renommé dans HubSpot), code
// d'intégration, champs et soumissions.

function embedCode(form) {
  const portal = form.portal_id || 'PORTAL_ID'
  if (form.embed_type === 'V3') {
    return `<script src="https://js.hsforms.net/forms/embed/${portal}.js" defer></script>\n`
      + `<div class="hs-form-frame" data-region="na1" data-form-id="${form.id}" data-portal-id="${portal}"></div>`
  }
  return '<script charset="utf-8" type="text/javascript" src="//js.hsforms.net/forms/embed/v2.js"></script>\n'
    + `<script>hbspt.forms.create({ region: "na1", portalId: "${portal}", formId: "${form.id}" });</script>`
}

const SUB_RENDERS = {
  submitted_at: row => <span className="text-slate-500">{fmtDate(row.submitted_at)}</span>,
  name: row => <span className="text-slate-800">{[row.first_name, row.last_name].filter(Boolean).join(' ') || '—'}</span>,
  email: row => row.contact_id
    ? <Link to={`/contacts/${row.contact_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.email}</Link>
    : <span className="text-slate-600">{row.email || '—'}</span>,
  company: row => <span className="text-slate-600">{row.company || '—'}</span>,
  page_url: row => row.page_url
    ? <a href={row.page_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="text-xs text-slate-500 hover:underline truncate">{row.page_url.replace(/^https?:\/\//, '')}</a>
    : <span className="text-slate-400">—</span>,
}
const SUB_COLUMNS = TABLE_COLUMN_META.marketing_form_submissions.map(meta => ({ ...meta, render: SUB_RENDERS[meta.id] }))

function statusColor(run) {
  if (!run.status_code) return 'red'
  if (run.status_code < 300) return 'green'
  if (run.status_code === 409) return 'yellow'
  return 'red'
}

function runColumns(onRetry, retrying) {
  const renders = {
    ran_at: row => <span className="text-slate-500">{fmtDateTime(row.ran_at)}</span>,
    email: row => <span className="text-slate-700">{row.email || '—'}</span>,
    status_code: row => <Badge color={statusColor(row)}>{row.status_code ?? '—'}</Badge>,
    error: row => <span className="text-xs text-red-600 truncate" title={row.error || ''}>{row.error || ''}</span>,
    output: row => <span className="text-xs font-mono text-slate-500 truncate" title={row.output || ''}>{row.output || ''}</span>,
    duration_ms: row => <span className="tabular-nums text-slate-500">{row.duration_ms != null ? `${row.duration_ms} ms` : '—'}</span>,
    retry: row => (
      <button onClick={e => { e.stopPropagation(); onRetry(row) }} disabled={retrying === row.id}
        className="text-slate-400 hover:text-slate-700" title="Relancer" data-testid="form-script-retry">
        <RotateCcw size={13} className={retrying === row.id ? 'animate-spin' : ''} />
      </button>
    ),
  }
  return TABLE_COLUMN_META.marketing_form_script_runs.map(meta => ({ ...meta, render: renders[meta.id] }))
}

export default function MarketingFormDetail({ recordId: id }) {
  const [syncing, setSyncing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [retrying, setRetrying] = useState(null)

  const { record: form, setRecord: setForm, loading, loadError, reload } = useDetailRecord(
    () => api.marketingForms.get(id), [id], { clearOnError: true })

  const { save, savingKeys } = useAutosave(form, p => api.marketingForms.update(id, p), {
    emptyToNull: false,
    onSaved: updated => setForm(f => ({ ...f, ...updated })),
  })

  async function handleSync() {
    setSyncing(true)
    try { await api.marketingForms.syncSubmissions(id); await reload() }
    finally { setSyncing(false) }
  }

  async function handleRetry(run) {
    setRetrying(run.id)
    try {
      const fresh = await api.marketingForms.retryScriptRun(id, run.id)
      setForm(f => ({ ...f, script_runs: [fresh, ...f.script_runs] }))
    } finally { setRetrying(null) }
  }

  function copyEmbed() {
    navigator.clipboard?.writeText(embedCode(form)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  const pending = detailPending({ loading, loadError, onRetry: reload, record: form, notFound: 'Formulaire introuvable.' })
  if (pending) return pending

  const editorUrl = form.portal_id ? `https://app.hubspot.com/forms/${form.portal_id}/editor/${form.id}/edit/form` : null

  return (
    <DetailShell
      header={{
        badge: form.language && <Badge color="slate">{form.language.toUpperCase()}</Badge>,
        status: form.archived ? <Badge color="gray">Archivé</Badge> : null,
        meta: <span>Modifié {fmtDate(form.hs_updated_at)}</span>,
        actions: (<>
          <button onClick={handleSync} disabled={syncing} className="btn-secondary" title="Relire les soumissions" data-testid="form-sync">
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          </button>
          {editorUrl && (
            <a href={editorUrl} target="_blank" rel="noreferrer" className="btn-secondary" data-testid="form-hubspot-link">
              <ExternalLink size={14} /> HubSpot
            </a>
          )}
        </>),
      }}
    >
      <div className="card p-5 space-y-4">
        <div>
          <label className="label" htmlFor="mf-name">Nom</label>
          <input
            id="mf-name"
            key={form.name}
            className="input"
            defaultValue={form.name}
            disabled={!!savingKeys.name}
            onBlur={e => e.target.value.trim() && save('name', e.target.value.trim())}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
          />
        </div>
        <div>
          <div className="label">Champs</div>
          <div className="flex flex-wrap gap-1.5">
            {form.fields.map(f => (
              <span key={f.name} className={`px-2 py-0.5 rounded-full text-xs border ${f.hidden ? 'border-dashed border-slate-300 text-slate-400' : 'border-slate-200 text-slate-700'}`}>
                {f.label || f.name}{f.required && <span className="text-red-500"> *</span>}
              </span>
            ))}
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <span className="label">Intégration</span>
            <button onClick={copyEmbed} className="text-xs text-slate-500 hover:text-slate-800 inline-flex items-center gap-1" data-testid="form-copy-embed">
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </div>
          <pre className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3 whitespace-pre-wrap break-all font-mono text-slate-600">{embedCode(form)}</pre>
        </div>
      </div>

      <div className="card p-5 mt-5 space-y-3" data-testid="form-submit-script">
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <input
              type="checkbox"
              checked={!!form.on_submit_enabled}
              disabled={!!savingKeys.on_submit_enabled}
              onChange={e => save('on_submit_enabled', e.target.checked ? 1 : 0)}
              data-testid="form-script-enabled"
            />
            Script à la soumission
          </label>
        </div>
        <textarea
          key={form.on_submit_script}
          rows={12}
          spellCheck={false}
          defaultValue={form.on_submit_script}
          onBlur={e => save('on_submit_script', e.target.value)}
          className="w-full border rounded-lg px-4 py-3 font-mono text-xs bg-gray-900 text-green-400 focus:outline-none focus:ring-2 focus:ring-brand-400"
          data-testid="form-script-code"
        />
        <div className="text-sm font-semibold text-slate-900">
          Déclenchements <span className="text-slate-400 font-normal">({form.script_runs.length})</span>
        </div>
        <DataTable
          table="marketing_form_script_runs"
          columns={runColumns(handleRetry, retrying)}
          data={form.script_runs}
          searchFields={['email', 'error']}
        />
      </div>

      <div className="mt-5">
        <div className="text-sm font-semibold text-slate-900 mb-2">
          Soumissions <span className="text-slate-400 font-normal">({form.submissions.length})</span>
        </div>
        <DataTable
          table="marketing_form_submissions"
          columns={SUB_COLUMNS}
          data={form.submissions}
          searchFields={['email', 'first_name', 'last_name', 'company']}
        />
      </div>
    </DetailShell>
  )
}
