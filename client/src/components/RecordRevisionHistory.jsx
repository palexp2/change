import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Hourglass, X } from 'lucide-react'
import api from '../lib/api.js'
import { TABLE_COLUMN_META, TABLE_RECORD_LABELS } from '../lib/tableDefs.js'
import Spinner from './Spinner.jsx'
import { fmtDate, fmtDateTime } from '../lib/formatDate.js'

// Historique des révisions d'une fiche, à la Airtable : une barre au bas du
// panneau, qui se déplie vers le haut sur la liste des changements champ par
// champ (ancienne valeur barrée en rouge, nouvelle en vert). Données :
// GET /records/:table/:id/revisions (server/src/services/recordRevisions.js).
//
// Monté par RecordPeekDrawer pour toute fiche ouverte en panneau, et par les
// fiches pleine page (variant="page").
//
// showSource : une révision « Système » nomme l'automatisation qui l'a faite.
// Activé par fiche via `historySource` dans lib/recordPeekRoutes.jsx.

// Premier segment de l'URL d'une fiche → table SQL.
const RESOURCE_TABLE = {
  products: 'products', projects: 'projects', serials: 'serial_numbers',
  factures: 'factures', envois: 'shipments', adresses: 'adresses',
  retours: 'returns', purchases: 'purchases', tickets: 'tickets',
  soumissions: 'soumissions', 'sale-receipts': 'sale_receipts',
  'problemes-operations': 'ops_issues', fournitures: 'fournitures',
  formulaires: 'marketing_forms', employees: 'employees', orders: 'orders',
  companies: 'companies', contacts: 'contacts', tasks: 'tasks', paies: 'paies',
}

// « /orders/42?x » → { table: 'orders', id: '42' }, ou null.
export function revisionTarget(to) {
  if (typeof to !== 'string') return null
  const [res, id, extra] = to.split(/[?#]/)[0].split('/').filter(Boolean)
  const table = RESOURCE_TABLE[res]
  return table && id && !extra ? { table, id: decodeURIComponent(id) } : null
}

const humanize = c => c.replace(/^cf_/, '').replace(/_/g, ' ').replace(/^./, m => m.toUpperCase())

function fieldLabel(table, ch, fields) {
  return fields?.[ch.column]?.label
    || TABLE_COLUMN_META[table]?.find(c => (c.field || c.id) === ch.column)?.label
    || TABLE_RECORD_LABELS[ch.link_table]
    || humanize(ch.column)
}

const RTF = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' })
const STEPS = [['year', 31536e6], ['month', 2592e6], ['week', 6048e5], ['day', 864e5], ['hour', 36e5], ['minute', 6e4]]
function ago(iso) {
  const d = Date.now() - Date.parse(iso)
  for (const [unit, ms] of STEPS) if (d >= ms) return RTF.format(-Math.floor(d / ms), unit)
  return 'à l’instant'
}

export default function RecordRevisionHistory({ table, id, variant = 'drawer', showSource = false }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState(null)
  const listRef = useRef(null)

  useEffect(() => { setOpen(false); setState(null) }, [table, id])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const load = () => api.records.revisions(table, id)
      .then(d => { if (!cancelled) setState(d) })
      .catch(() => { if (!cancelled) setState(s => s || { data: [], fields: {} }) })
    load()
    const t = setInterval(load, 5000)
    return () => { cancelled = true; clearInterval(t) }
  }, [open, table, id])

  // Le plus récent en bas, comme Airtable : on arrive dessus.
  const count = state?.data?.length || 0
  useLayoutEffect(() => {
    if (open && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [open, count])

  const page = variant === 'page'

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        data-testid="record-history-open"
        className={`${page ? 'sticky bottom-0 mt-6' : ''} w-full flex items-center gap-2 px-6 py-2.5 border-t border-slate-200 bg-slate-100/80 text-sm text-slate-500 hover:text-slate-700 hover:bg-slate-100 flex-shrink-0`}
      >
        <Hourglass size={14} />
        Historique
      </button>
    )
  }

  return (
    <div
      data-testid="record-history"
      className={`${page ? 'fixed right-0 bottom-0 w-full max-w-[720px] h-[65vh]' : 'absolute left-0 right-0 bottom-0 h-[65%]'} z-30 flex flex-col bg-white border-t border-slate-200 shadow-[0_-8px_24px_rgba(0,0,0,0.08)] animate-slide-in-up`}
    >
      <div className="flex items-center px-6 py-3 border-b border-slate-200 flex-shrink-0">
        <div className="flex-1 text-sm text-slate-600">Historique</div>
        <button onClick={() => setOpen(false)} aria-label="Fermer" className="p-1 text-slate-400 hover:text-slate-600 rounded">
          <X size={16} />
        </button>
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
        {!state && <Spinner size="xs" />}
        {state && !count && <div className="text-sm text-slate-400">Aucun changement</div>}
        {state?.data?.map(rev => <Revision key={rev.id} rev={rev} table={table} fields={state.fields} showSource={showSource} />)}
      </div>
    </div>
  )
}

const VERB = { created: 'a créé', deleted: 'a supprimé', updated: 'a modifié' }

function Revision({ rev, table, fields, showSource }) {
  const source = showSource && !rev.user_name && rev.source_name
  return (
    <div>
      <div className="flex items-baseline gap-2 text-xs text-slate-500 mb-1.5">
        <span className="flex-1 truncate">
          <span className="font-medium text-slate-700">{rev.user_name || 'Système'}</span>
          {source && <> · <span className="font-medium text-slate-700" title="Automatisation">{source}</span></>}
          {' '}{VERB[rev.kind] || rev.kind}
        </span>
        <span className="tabular-nums" title={ago(rev.changed_at)}>{fmtDateTime(rev.changed_at)}</span>
      </div>
      {rev.changes.length > 0 && (
        <div className="rounded-lg bg-slate-100 px-4 py-3 space-y-3">
          {rev.changes.map(ch => (
            <div key={ch.column}>
              <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{fieldLabel(table, ch, fields)}</div>
              <ChangeValue ch={ch} field={fields?.[ch.column]} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const OLD = 'bg-rose-100 text-rose-800 line-through decoration-rose-500'
const NEW = 'bg-emerald-100 text-emerald-900'
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

function display(v, label, field) {
  if (label) return label
  if (v == null || v === '') return null
  if (field?.type === 'checkbox') return Number(v) ? '☑' : '☐'
  // Dates en ISO, comme partout : minuit UTC (date Airtable) → jour seul.
  if (typeof v === 'string' && (field?.type === 'date' || ISO_TS.test(v))) {
    return /^\d{4}-\d{2}-\d{2}(T00:00:00(\.0+)?Z)?$/.test(v) ? fmtDate(v) : fmtDateTime(v)
  }
  if (typeof v === 'string' && /^\[.*\]$/s.test(v)) {
    try { const a = JSON.parse(v); if (Array.isArray(a)) return a.map(x => (typeof x === 'object' ? x?.name || x?.filename || x?.label || JSON.stringify(x) : x)).join(', ') } catch { /* pas du JSON */ }
  }
  return String(v)
}

function ChangeValue({ ch, field }) {
  const o = display(ch.old, ch.old_label, field)
  const n = display(ch.new, ch.new_label, field)
  const long = field?.type === 'long_text' || [o, n].some(s => s && (s.length > 80 || s.includes('\n')))
  if (long && o && n) return <TextDiff a={o} b={n} />
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-sm">
      {o && <span className={`rounded px-1.5 py-0.5 whitespace-pre-wrap break-words ${OLD}`}>{o}</span>}
      {n && <span className={`rounded px-1.5 py-0.5 whitespace-pre-wrap break-words ${NEW}`}>{n}</span>}
      {!o && !n && <span className="text-slate-400">—</span>}
    </div>
  )
}

// ── Diff de texte : lignes, puis mots à l'intérieur des lignes remplacées ──────

function lcs(a, b) {
  const m = a.length, n = b.length
  // Garde-fou : texte énorme → remplacement en bloc plutôt qu'un O(n·m) qui fige.
  if (m * n > 400_000) return [...a.map(v => ['-', v]), ...b.map(v => ['+', v])]
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1))
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  }
  const out = []
  let i = 0, j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push(['=', a[i]]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['-', a[i++]])
    else out.push(['+', b[j++]])
  }
  while (i < m) out.push(['-', a[i++]])
  while (j < n) out.push(['+', b[j++]])
  return out
}

const words = s => s.split(/(\s+)/).filter(Boolean)

function TextDiff({ a, b }) {
  const ops = lcs(a.split('\n'), b.split('\n'))
  // Regroupe les blocs -/+ consécutifs : une ligne retirée suivie d'une ajoutée
  // = une ligne modifiée, diffée au mot.
  const rows = []
  for (let k = 0; k < ops.length;) {
    if (ops[k][0] === '=') { rows.push({ t: '=', text: ops[k][1] }); k++; continue }
    const del = [], add = []
    while (k < ops.length && ops[k][0] !== '=') (ops[k][0] === '-' ? del : add).push(ops[k++][1])
    const pairs = Math.min(del.length, add.length)
    for (let p = 0; p < pairs; p++) rows.push({ t: '~', parts: lcs(words(del[p]), words(add[p])) })
    for (const d of del.slice(pairs)) rows.push({ t: '-', text: d })
    for (const x of add.slice(pairs)) rows.push({ t: '+', text: x })
  }
  // Contexte : une ligne inchangée de part et d'autre d'un changement, le reste en « … ».
  const changed = r => r && r.t !== '='
  const near = rows.map((r, i) => changed(r) || changed(rows[i - 1]) || changed(rows[i + 1]))
  const out = []
  rows.forEach((r, i) => {
    if (!near[i]) { if (out[out.length - 1] !== '…') out.push('…'); return }
    out.push(r)
  })
  return (
    <div className="text-sm text-slate-700 space-y-0.5">
      {out.map((r, i) => {
        if (r === '…') return <div key={i} className="text-slate-400 leading-none">…</div>
        if (r.t === '=') return <div key={i} className="whitespace-pre-wrap break-words">{r.text || ' '}</div>
        if (r.t === '-') return <div key={i} className={`whitespace-pre-wrap break-words ${OLD}`}>{r.text || ' '}</div>
        if (r.t === '+') return <div key={i} className={`whitespace-pre-wrap break-words ${NEW}`}>{r.text || ' '}</div>
        return (
          <div key={i} className="whitespace-pre-wrap break-words">
            {r.parts.map(([op, w], j) => (
              op === '=' ? <span key={j}>{w}</span>
                : <span key={j} className={op === '-' ? OLD : NEW}>{w}</span>
            ))}
          </div>
        )
      })}
    </div>
  )
}
