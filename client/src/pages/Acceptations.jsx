import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { FileSignature } from 'lucide-react'
import api from '../lib/api.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDateTime } from '../lib/formatDate.js'
import { RecordOps } from '../lib/recordOps.js'

// Acceptations des pages hébergées (Fichiers publics avec bloc
// data-orisha-accept) — remplace l'outil Contrats (2026-10-09).

const pageLink = row => (
  <a href={`/erp/p/${row.page_token}`} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="link-record">{row.page_name}</a>
)

const ACCEPT_COLUMNS = TABLE_COLUMN_META.page_acceptances.map(meta => ({ ...meta, render: {
  at: row => <span className="text-slate-700">{fmtDateTime(row.at)}</span>,
  page_name: pageLink,
  // Contact reconnu par le lien (?contact=…) ; sinon visiteur non identifié.
  contact: row => row.contact_id
    ? <Link to={`/contacts/${row.contact_id}`} onClick={e => e.stopPropagation()} className="link-record">{row.contact_name || row.email || 'Contact'}</Link>
    : <span className="text-slate-400">—</span>,
  // Aperçu ; texte complet dans la fiche (panneau latéral).
  text: row => <span className="text-slate-600 truncate">{row.text ? row.text.slice(0, 120) : '—'}</span>,
  name: row => <span className="text-slate-800">{row.name}</span>,
  ip: row => <span className="text-xs text-slate-500 tabular-nums">{row.ip || ''}</span>,
  hash: row => <span className="text-xs text-slate-500 font-mono" title={row.hash}>{row.hash?.slice(0, 12)}</span>,
}[meta.id] }))

export default function Acceptations() {
  const acceptances = useListData({ fetch: () => api.publicFiles.allAcceptances(), cacheKey: 'page_acceptances', realtime: 'page_acceptances' })
  const navigate = useNavigate()
  const { setRows } = acceptances
  // Clic droit → « Supprimer l'acceptation ».
  const ops = useMemo(() => new RecordOps({
    labels: { delete: "Supprimer l'acceptation", deleted: 'Acceptation supprimée' },
    remove: async row => {
      await api.publicFiles.deleteAcceptance(row.id)
      setRows(prev => prev.filter(x => x.id !== row.id))
    },
    deleteConfirm: row => `Supprimer l'acceptation de ${row.contact_name || row.name || 'ce visiteur'} ?`,
  }), [setRows])
  return (
    <ListPage title="Acceptations" icon={FileSignature}>
      {() => (
        <DataTable table="page_acceptances" columns={ACCEPT_COLUMNS} data={acceptances.rows} loading={acceptances.loading}
          onRowClick={row => navigate(`/acceptations/${row.id}`)} recordOps={ops}
          searchFields={['page_name', 'contact_name', 'name', 'ip', 'text']} emptyState={{ icon: FileSignature, title: 'Aucune acceptation' }} />
      )}
    </ListPage>
  )
}
