import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CalendarClock, Copy, Check, Video, XCircle } from 'lucide-react'
import api from '../lib/api.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { Badge } from '../components/Badge.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDateTime } from '../lib/formatDate.js'

// Marketing → Rendez-vous : pages de réservation publiques (/rdv/:slug, à la
// HubSpot Meetings) et réservations reçues. Fiche d'une page : panneau latéral
// (MeetingTypeDetail, registre recordPeekRoutes).

export function CopyLink({ url }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title={url}
      onClick={e => {
        e.stopPropagation()
        navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
      }}
      className="text-slate-400 hover:text-slate-700"
      data-testid="meeting-copy-link"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}

const TYPE_RENDERS = {
  name: row => <span className="font-medium text-slate-800">{row.name}</span>,
  durations: row => <span className="text-slate-600">{row.durations.map(d => `${d}`).join(' / ')} min</span>,
  upcoming_count: row => <span className="tabular-nums font-medium text-slate-800">{row.upcoming_count || 0}</span>,
  booking_count: row => <span className="tabular-nums text-slate-600">{row.booking_count || 0}</span>,
  calendar: row => row.calendar ? <Badge color="green">Google</Badge> : <Badge color="yellow">Non branché</Badge>,
  active: row => row.active ? <Badge color="green">Oui</Badge> : <Badge color="gray">Non</Badge>,
  public_url: row => <CopyLink url={row.public_url} />,
}
const TYPE_COLUMNS = TABLE_COLUMN_META.meeting_types.map(meta => ({ ...meta, render: TYPE_RENDERS[meta.id] }))

export function bookingColumns(onCancel) {
  const renders = {
    start_at: row => <span className={row.status === 'cancelled' ? 'text-slate-400 line-through' : 'text-slate-700'}>{fmtDateTime(row.start_at)}</span>,
    invitee_name: row => row.contact_id
      ? <Link to={`/contacts/${row.contact_id}`} onClick={e => e.stopPropagation()} className="link-record">{row.invitee_name}</Link>
      : <span>{row.invitee_name}</span>,
    invitee_email: row => <span className="text-slate-600">{row.invitee_email}</span>,
    invitee_company: row => <span className="text-slate-600">{row.invitee_company || '—'}</span>,
    type_name: row => row.meeting_type_id
      ? <Link to={`/rendez-vous/${row.meeting_type_id}`} onClick={e => e.stopPropagation()} className="link-record">{row.type_name}</Link>
      : <span className="text-slate-400">—</span>,
    duration_minutes: row => <span className="tabular-nums text-slate-600">{row.duration_minutes} min</span>,
    status: row => row.status === 'cancelled' ? <Badge color="gray">Annulé</Badge> : <Badge color="green">Confirmé</Badge>,
    meet_url: row => row.meet_url
      ? <a href={row.meet_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="text-slate-500 hover:text-slate-800"><Video size={14} /></a>
      : null,
    notes: row => <span className="text-xs text-slate-500 truncate" title={row.notes || ''}>{row.notes || ''}</span>,
    actions: row => row.status === 'confirmed' && Date.parse(row.end_at) > Date.now()
      ? <button onClick={e => { e.stopPropagation(); onCancel(row) }} className="text-slate-400 hover:text-red-600" title="Annuler le rendez-vous" data-testid="meeting-booking-cancel"><XCircle size={14} /></button>
      : null,
  }
  return TABLE_COLUMN_META.meeting_bookings.map(meta => ({ ...meta, render: renders[meta.id] }))
}

export function useCancelBooking(onDone) {
  const confirm = useConfirm()
  return async row => {
    const ok = await confirm({
      title: 'Annuler le rendez-vous',
      message: `${row.invitee_name} — ${fmtDateTime(row.start_at)}`,
      confirmLabel: 'Annuler le rendez-vous',
    })
    if (!ok) return
    await api.meetings.cancelBooking(row.id)
    onDone?.()
  }
}

export default function Meetings() {
  const navigate = useNavigate()
  const [tab, setTab] = useState('pages')

  // Les routes renvoient un tableau nu ; loadProgressive attend { data }.
  const types = useListData({ fetch: () => api.meetings.types().then(data => ({ data })), cacheKey: 'meeting_types' })
  const bookings = useListData({ fetch: () => api.meetings.bookings().then(data => ({ data })), cacheKey: 'meeting_bookings' })
  const cancel = useCancelBooking(() => { bookings.reload(); types.reload() })

  async function handleCreate(values) {
    const created = await api.meetings.createType(values)
    await types.reload()
    navigate(`/rendez-vous/${created.id}`)
  }

  const tabs = [['pages', 'Pages'], ['bookings', 'Réservations']]

  return (
    <ListPage
      title="Rendez-vous"
      icon={CalendarClock}
      titleExtra={
        <div className="flex gap-1 bg-slate-100 rounded-lg p-0.5" data-testid="meetings-tabs">
          {tabs.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-3 py-1 text-sm rounded-md ${tab === k ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}>
              {label}
            </button>
          ))}
        </div>
      }
      create={{
        label: 'Nouvelle page',
        submitLabel: 'Créer',
        onSubmit: handleCreate,
        fields: [{ field: 'name', label: 'Nom', required: true, locked: true }],
      }}
    >
      {({ openCreate }) => tab === 'pages' ? (
        <DataTable
          table="meeting_types"
          columns={TYPE_COLUMNS}
          data={types.rows}
          loading={types.loading}
          searchFields={['name', 'owner_name']}
          onRowClick={row => navigate(`/rendez-vous/${row.id}`)}
          emptyState={{ icon: CalendarClock, title: 'Aucune page', cta: { label: 'Nouvelle page', onClick: openCreate } }}
        />
      ) : (
        <DataTable
          table="meeting_bookings"
          columns={bookingColumns(cancel)}
          data={bookings.rows}
          loading={bookings.loading}
          searchFields={['invitee_name', 'invitee_email', 'invitee_company', 'type_name']}
          onRowClick={row => row.contact_id && navigate(`/contacts/${row.contact_id}`)}
          emptyState={{ icon: CalendarClock, title: 'Aucun rendez-vous' }}
        />
      )}
    </ListPage>
  )
}

