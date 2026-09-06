import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Phone, Mail, MessageSquare, Users, FileText, Trash2 } from 'lucide-react'
import api from '../lib/api.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { Badge, INTERACTION_TYPE_LABELS as TYPE_LABELS } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import RecordPeekDrawer from '../components/RecordPeekDrawer.jsx'
import ContactDetail from './ContactDetail.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDateTime } from '../lib/formatDate.js'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useUndoableDelete } from '../lib/undoableDelete.js'

const TYPE_ICONS = { call: Phone, email: Mail, sms: MessageSquare, meeting: Users, note: FileText }
const TYPE_COLORS = {
  call:    'bg-blue-100 text-blue-700',
  email:   'bg-purple-100 text-purple-700',
  sms:     'bg-green-100 text-green-700',
  meeting: 'bg-amber-100 text-amber-700',
  note:    'bg-slate-100 text-slate-600',
}
const DIRECTION_COLORS = { in: 'green', out: 'blue' }


import { fmtDurationSeconds as fmtDuration } from '../lib/duration.js'

// ─── Panneau de détail ────────────────────────────────────────────────────────

function InteractionDetail({ item: stub, onNavigate, onPeekContact, onDelete }) {
  // The list endpoint omits heavy fields (body_text, transcript_formatted,
  // meeting_notes). Fetch the full record when the panel opens so the detail
  // view has everything it needs.
  const [item, setItem] = useState(stub)
  useEffect(() => {
    let cancelled = false
    setItem(stub)
    api.interactions.get(stub.id)
      .then(full => { if (!cancelled) setItem(full) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [stub.id])

  const Icon = TYPE_ICONS[item.type] || FileText

  return (
    <div className="space-y-4">
      {/* En-tête */}
      <div className="flex items-center gap-3 pb-4 border-b border-slate-100">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${TYPE_COLORS[item.type] || 'bg-slate-100 text-slate-600'}`}>
          <Icon size={18} />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-slate-900">{TYPE_LABELS[item.type] || item.type}</span>
            {item.direction && (
              <Badge color={DIRECTION_COLORS[item.direction]}>
                {item.direction === 'in' ? 'Entrant' : 'Sortant'}
              </Badge>
            )}
          </div>
          <div className="text-xs text-slate-400 mt-0.5">{fmtDateTime(item.timestamp)}</div>
        </div>
      </div>

      {/* Parties */}
      {(item.contact_name?.trim() || item.company_name) && (
        <div className="grid grid-cols-2 gap-3 text-sm">
          {item.contact_name?.trim() && (
            <div>
              <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-0.5">Contact</div>
              {item.contact_id
                ? <button onClick={() => onPeekContact(item)} className="text-blue-600 hover:underline text-left">{item.contact_name.trim()}</button>
                : <div className="text-slate-800">{item.contact_name.trim()}</div>
              }
            </div>
          )}
          {item.company_name && (
            <div>
              <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-0.5">Entreprise</div>
              {item.company_id
                ? <button onClick={() => onNavigate(`/companies/${item.company_id}`)} className="text-blue-600 hover:underline text-left">{item.company_name}</button>
                : <div className="text-slate-800">{item.company_name}</div>
              }
            </div>
          )}
        </div>
      )}

      {/* Détails appel */}
      {item.type === 'call' && (
        <div className="space-y-3">
          {(item.callee_number || item.duration_seconds) && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              {item.callee_number && (
                <div>
                  <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-0.5">Numéro</div>
                  <div className="text-slate-800 font-mono">{item.callee_number}</div>
                </div>
              )}
              {item.duration_seconds && (
                <div>
                  <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-0.5">Durée</div>
                  <div className="text-slate-800">{fmtDuration(item.duration_seconds)}</div>
                </div>
              )}
            </div>
          )}

          {item.call_id && (item.recording_path || item.drive_file_id) && (
            <div>
              <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Enregistrement</div>
              <audio controls className="w-full h-10 rounded"
                src={`/erp/api/calls/${item.call_id}/recording?token=${localStorage.getItem('erp_token')}`} />
            </div>
          )}

          {item.transcription_status && item.transcription_status !== 'done' && (
            <Badge color="yellow">
              {item.transcription_status === 'pending' ? 'Transcription en attente' :
               item.transcription_status === 'processing' ? 'Transcription en cours...' : 'Erreur transcription'}
            </Badge>
          )}

          {item.call_summary && (
            <div>
              <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Résumé</div>
              <div className="p-3 bg-slate-50 rounded-lg text-sm text-slate-700 whitespace-pre-wrap border border-slate-200">
                {item.call_summary}
              </div>
            </div>
          )}
          {item.call_next_steps && (
            <div>
              <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Prochaines étapes</div>
              <div className="p-3 bg-slate-50 rounded-lg text-sm text-slate-700 whitespace-pre-wrap border border-slate-200">
                {item.call_next_steps}
              </div>
            </div>
          )}
          {item.transcript_formatted && (
            <div>
              <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Transcription</div>
              <div className="p-3 bg-slate-50 rounded-lg text-xs text-slate-700 whitespace-pre-wrap font-mono max-h-80 overflow-y-auto border border-slate-200">
                {item.transcript_formatted}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Détails email */}
      {item.type === 'email' && (
        <div className="space-y-3">
          {item.subject && (
            <div>
              <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-0.5">Sujet</div>
              <div className="text-slate-800 font-medium">{item.subject}</div>
            </div>
          )}
          {item.from_address && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-0.5">De</div>
                <div className="text-slate-700 text-xs font-mono">{item.from_address}</div>
              </div>
              <div>
                <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-0.5">À</div>
                <div className="text-slate-700 text-xs font-mono">{item.to_address}</div>
              </div>
            </div>
          )}
          {item.body_text && (
            <div>
              <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Contenu</div>
              <div className="p-3 bg-slate-50 rounded-lg text-sm text-slate-700 whitespace-pre-wrap max-h-80 overflow-y-auto border border-slate-200">
                {item.body_text}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Détails réunion / note */}
      {(item.type === 'meeting' || item.type === 'note') && (
        <div className="space-y-3">
          {item.meeting_title && item.meeting_title !== 'Note' && (
            <div>
              <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-0.5">Titre</div>
              <div className="text-slate-800 font-medium">{item.meeting_title}</div>
            </div>
          )}
          {item.duration_minutes && (
            <div>
              <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-0.5">Durée</div>
              <div className="text-slate-700">{item.duration_minutes} min</div>
            </div>
          )}
          {item.meeting_notes && (
            <div>
              <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Notes</div>
              <div className="p-3 bg-slate-50 rounded-lg text-sm text-slate-700 whitespace-pre-wrap border border-slate-200">
                {item.meeting_notes}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Utilisateur */}
      {item.user_name && (
        <div className="pt-3 border-t border-slate-100 text-xs text-slate-400">
          Enregistré par <span className="text-slate-600 font-medium">{item.user_name}</span>
        </div>
      )}

      {/* Actions */}
      <div className="pt-3 border-t border-slate-100 flex justify-end">
        <button
          type="button"
          onClick={() => onDelete(item)}
          className="inline-flex items-center gap-1.5 text-sm text-red-500 hover:text-red-700 hover:underline"
        >
          <Trash2 size={14} /> Supprimer
        </button>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Interactions() {
  const [selected, setSelected] = useState(null)
  // Contact ouvert dans le side-peek (clic sur un nom de contact) :
  // { id, name, company } — la fiche ContactDetail est montée en mode embedded.
  const [peekContact, setPeekContact] = useState(null)
  const navigate = useNavigate()
  const confirm = useConfirm()
  const undoableDelete = useUndoableDelete()

  const { rows: items, loading, reload: load } = useListData({
    fetch: (page, limit) => api.interactions.list({ limit, offset: limit === 'all' ? 0 : (page - 1) * limit })
      .then(r => ({ data: r.interactions || [], total: r.total || 0 })),
    cacheKey: 'interactions',
    realtime: 'interaction',
  })

  async function handleDelete(item) {
    if (!(await confirm('Supprimer cette interaction ?'))) return
    setSelected(null)
    await undoableDelete({
      table: 'interactions',
      id: item.id,
      deleteFn: () => api.interactions.delete(item.id),
      label: 'Interaction supprimée',
      onChange: load,
    })
  }

  const COLUMNS = useMemo(() => TABLE_COLUMN_META.interactions.map(meta => ({
    ...meta,
    render:
      meta.id === 'type' ? row => {
        const Icon = TYPE_ICONS[row.type] || FileText
        return (
          <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium ${TYPE_COLORS[row.type] || 'bg-slate-100 text-slate-600'}`}>
            <Icon size={12} />
            {TYPE_LABELS[row.type] || row.type}
          </div>
        )
      } :
      meta.id === 'direction' ? row => row.direction
        ? <Badge color={DIRECTION_COLORS[row.direction]}>{row.direction === 'in' ? 'Entrant' : 'Sortant'}</Badge>
        : <span className="text-slate-300">—</span> :
      meta.id === 'contact_name' ? row =>
        row.contact_id && row.contact_name?.trim()
          ? <button
              onClick={e => { e.stopPropagation(); setPeekContact({ id: row.contact_id, name: row.contact_name.trim(), company: row.company_name || '' }) }}
              className="text-brand-600 hover:underline text-left"
            >{row.contact_name.trim()}</button>
          : <span className="text-slate-700">{row.contact_name?.trim() || <span className="text-slate-300">—</span>}</span> :
      meta.id === 'phone_number' ? row =>
        row.phone_number
          ? <span className="font-mono text-slate-600 text-xs">{row.phone_number}</span>
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
        onRowClick={setSelected}
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

      <Modal
        isOpen={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? (TYPE_LABELS[selected.type] || selected.type) : ''}
        size="lg"
      >
        {selected && (
          <InteractionDetail
            item={selected}
            onNavigate={path => { setSelected(null); navigate(path) }}
            onPeekContact={item => setPeekContact({ id: item.contact_id, name: item.contact_name?.trim() || 'Contact', company: item.company_name || '' })}
            onDelete={handleDelete}
          />
        )}
      </Modal>

      {/* Side-peek de la fiche contact (clic sur un nom de contact, dans la
          table ou le panneau de détail). Porté sur document.body → s'affiche
          par-dessus la modale d'interaction sans la fermer. */}
      <RecordPeekDrawer
        open={!!peekContact}
        onClose={() => setPeekContact(null)}
        title={peekContact?.name || 'Contact'}
        subtitle={peekContact?.company || ''}
        to={peekContact ? `/contacts/${peekContact.id}` : undefined}
      >
        {peekContact && <ContactDetail recordId={peekContact.id} embedded onClose={() => setPeekContact(null)} />}
      </RecordPeekDrawer>
    </ListPage>
  )
}
