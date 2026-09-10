import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import InteractionDetail, { InteractionTypePill } from './InteractionDetail.jsx'
import { interactionTitle, interactionSubtitle } from '../lib/interactionLabel.js'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDateTime } from '../lib/formatDate.js'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { fmtDurationSeconds as fmtDuration } from '../lib/duration.js'

const DIRECTION_COLORS = { in: 'green', out: 'blue' }

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Interactions() {
  const undoableDelete = useUndoableDelete()

  const { rows: items, loading, reload: load } = useListData({
    fetch: (page, limit) => api.interactions.list({ limit, offset: limit === 'all' ? 0 : (page - 1) * limit })
      .then(r => ({ data: r.interactions || [], total: r.total || 0 })),
    cacheKey: 'interactions',
    realtime: 'interaction',
  })

  const COLUMNS = useMemo(() => TABLE_COLUMN_META.interactions.map(meta => ({
    ...meta,
    render:
      meta.id === 'type' ? row => <InteractionTypePill type={row.type} /> :
      meta.id === 'direction' ? row => row.direction
        ? <Badge color={DIRECTION_COLORS[row.direction]}>{row.direction === 'in' ? 'Entrant' : 'Sortant'}</Badge>
        : <span className="text-slate-300">—</span> :
      meta.id === 'contact_name' ? row =>
        row.contact_id && row.contact_name?.trim()
          ? <Link to={`/contacts/${row.contact_id}`} onClick={e => e.stopPropagation()} className="link-record">{row.contact_name.trim()}</Link>
          : <span className="text-slate-700">{row.contact_name?.trim() || <span className="text-slate-300">—</span>}</span> :
      meta.id === 'company_name' ? row =>
        row.company_id && row.company_name
          ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="link-record">{row.company_name}</Link>
          : <span className="text-slate-700">{row.company_name || <span className="text-slate-300">—</span>}</span> :
      meta.id === 'phone_number' ? row =>
        row.phone_number
          ? <span className="font-mono text-slate-600 text-xs">{row.phone_number}</span>
          : <span className="text-slate-300">—</span> :
      meta.id === 'subject' ? row =>
        row.subject
          ? <span className="text-slate-700 truncate">{row.subject}</span>
          : <span className="text-slate-300">—</span> :
      meta.id === 'summary' ? row => {
        if (row.type === 'call' && row.callee_number) return <span className="text-slate-500 font-mono text-xs">{row.callee_number}{row.duration_seconds ? ` · ${fmtDuration(row.duration_seconds)}` : ''}</span>
        if (row.type === 'email' && row.subject) return <span className="text-slate-600 truncate">{row.subject}</span>
        if ((row.type === 'meeting' || row.type === 'note') && row.meeting_title && row.meeting_title !== 'Note') return <span className="text-slate-600 truncate">{row.meeting_title}</span>
        return <span className="text-slate-300">—</span>
      } :
      meta.id === 'timestamp' ? row => <span className="text-slate-500 text-xs">{fmtDateTime(row.timestamp)}</span> :
      meta.id === 'duration_seconds' ? row => <span className="text-slate-500">{fmtDuration(row.duration_seconds) || '—'}</span> :
      undefined
  })), [])

  return (
    <ListPage title="Interactions">
      <DataTable
        table="interactions"
        manageViews
        columns={COLUMNS}
        data={items}
        loading={loading}
        peek={{
          title: interactionTitle,
          subtitle: interactionSubtitle,
          to: row => `/interactions/${row.id}`,
          width: 720,
          render: (row, { close }) => <InteractionDetail recordId={row.id} embedded onClose={close} />,
        }}
        searchFields={['contact_name', 'company_name', 'subject', 'callee_number', 'meeting_title']}
        onBulkDelete={async (ids) => {
          await undoableDelete({
            table: 'interactions',
            ids,
            deleteFn: () => Promise.all(ids.map(id => api.interactions.delete(id))),
            label: `${ids.length} interaction${ids.length > 1 ? 's' : ''} supprimée${ids.length > 1 ? 's' : ''}`,
            onChange: load,
          })
        }}
      />
    </ListPage>
  )
}
