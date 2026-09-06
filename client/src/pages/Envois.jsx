import { useCallback } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { X, Truck } from 'lucide-react'
import api from '../lib/api.js'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import EnvoisDetail from './EnvoisDetail.jsx'
import { usePeekOpenId } from '../lib/usePeekOpenId.js'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { weekStartOf, fmtWeekStart } from '../lib/isoWeek.js'
import { LinkedRecordsValue } from '../lib/customFieldDisplay.jsx'
import { shipmentTitle, shipmentSubtitle } from '../lib/shipmentLabel.js'


const RENDERS = {
  order_number: row => row.order_id
    ? <Link to={`/orders/${row.order_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline font-medium">#{row.order_number}</Link>
    : <span className="text-slate-400">—</span>,
  company_name: row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  // Champs lien : la colonne porte un id. Libellé pris sur la ligne quand la
  // requête le joint (# de commande, adresse) ; sinon résolu par
  // /api/record-links, qui sait retrouver une fiche depuis son id Boréal.
  order_id: row => {
    if (!row.order_id) return <span className="text-slate-400">—</span>
    return row.order_number
      ? <Link to={`/orders/${row.order_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline font-medium">#{row.order_number}</Link>
      : <LinkedRecordsValue field={{ record_link_target: 'orders' }} value={row.order_id} />
  },
  address_id: row => {
    if (!row.address_id) return <span className="text-slate-400">—</span>
    const label = fmtAdresse({
      line1: row.address_line1, city: row.address_city, province: row.address_province,
      postal_code: row.address_postal_code, country: row.address_country,
    })
    return label
      ? <Link to={`/adresses/${row.address_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{label}</Link>
      : <LinkedRecordsValue field={{ record_link_target: 'adresses' }} value={row.address_id} />
  },
  tracking_number: row => <span className="font-mono text-xs text-slate-700">{row.tracking_number || '—'}</span>,
  carrier: row => <span className="text-slate-700">{row.carrier || '—'}</span>,
  pays: row => <span className="text-slate-700">{row.pays || '—'}</span>,
  shipped_at: row => <span className="text-slate-500">{fmtDate(row.shipped_at)}</span>,
  created_at: row => <span className="text-slate-500">{fmtDate(row.created_at)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.shipments.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

import { fmtAddress as fmtAdresse } from '../utils/formatters.js'

export default function Envois() {
  const { peekOpenId, consumePeekOpen } = usePeekOpenId()
  const [searchParams, setSearchParams] = useSearchParams()
  const weekFilter = searchParams.get('week') // 'YYYY-MM-DD' (lundi) ou null

  const undoableDelete = useUndoableDelete()
  const { rows: envois, setRows: setEnvois, loading, reload: load } = useListData({
    fetch: (page, limit) => api.shipments.list({ limit, page }),
    realtime: 'shipment',
  })

  // Suppression d'un envoi depuis la liste. Pas de modale de confirmation :
  // le soft delete est réversible (toast « Annuler » 8 s + corbeille), donc la
  // ligne disparaît immédiatement et l'appel réseau suit.
  const deleteEnvois = useCallback(async (ids) => {
    const targets = ids.map(String)
    setEnvois(prev => prev.filter(e => !targets.includes(String(e.id))))
    await undoableDelete({
      table: 'shipments',
      ids,
      deleteFn: () => Promise.all(ids.map(id => api.shipments.delete(id))),
      label: `${ids.length} envoi${ids.length > 1 ? 's' : ''} supprimé${ids.length > 1 ? 's' : ''}`,
      onChange: load,
    })
  }, [undoableDelete, load, setEnvois])

  // Filtre « semaine du … » posé par un clic sur une barre du graphique
  // « Livraisons » (dashboard). Le graphique compte les envois par semaine de
  // `shipped_at` : on filtre sur le même champ et avec le même bucketing (lundi
  // en UTC), sinon la liste ne montre pas les records de la barre cliquée.
  const displayedEnvois = weekFilter
    ? envois.filter(e => weekStartOf(e.shipped_at) === weekFilter)
    : envois

  const weekLabel = weekFilter ? fmtWeekStart(weekFilter) : null

  return (
    <ListPage
      title="Envois"
      subtitle={<p className="text-sm text-slate-500 mt-0.5">{displayedEnvois.length} envoi{displayedEnvois.length !== 1 ? 's' : ''}</p>}
      banner={weekLabel && (
        <div className="flex items-center gap-2 mb-4 px-3 py-2 bg-brand-50 border border-brand-200 rounded-lg w-fit" data-testid="envois-week-filter">
          <span className="text-sm text-brand-700 font-medium">Envois expédiés — semaine du {weekLabel}</span>
          <button
            onClick={() => setSearchParams({})}
            className="text-brand-400 hover:text-brand-700 ml-1"
            title="Effacer le filtre"
            data-testid="envois-week-clear"
          >
            <X size={14} />
          </button>
        </div>
      )}
    >
      <DataTable
        table="shipments"
        manageViews
        columns={COLUMNS}
        data={displayedEnvois}
        loading={loading}
        forceAllView={!!weekFilter}
        onBulkDelete={deleteEnvois}
        peek={{
          title: shipmentTitle,
          subtitle: shipmentSubtitle,
          to: row => `/envois/${row.id}`,
          width: 860,
          openId: peekOpenId,
          onOpenConsumed: consumePeekOpen,
          render: (row, { close }) => <EnvoisDetail recordId={row.id} embedded onClose={close} />,
        }}
        searchFields={['d_envoi', 'order_number', 'tracking_number', 'company_name', 'carrier', 'pays']}
        emptyState={{ icon: Truck, title: 'Aucun envoi', description: "Aucune expédition n'a encore été créée. Un envoi se crée depuis la fiche de la commande à expédier." }}
      />
    </ListPage>
  )
}
