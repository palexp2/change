// Tableau partagé pour les events d'abonnement (creation/upgrade/downgrade/churn/
// reactivation). Utilisé par :
//   - la page /abonnements/mouvements (liste plate, toutes les vues)
//   - le panel "Mouvements d'abonnements" du dashboard (filtré au mois, groupé
//     par catégorie via initialGroupBy + forceAllView).
//
// Encapsule DataTable + les renderers + la modale d'abonnement pour qu'aucun
// renderer ne soit dupliqué côté pages.

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { DataTable } from './DataTable.jsx'
import { Badge } from './Badge.jsx'
import { AbonnementDetailModal } from './AbonnementDetailModal.jsx'
import { RachatPicker } from './RachatPicker.jsx'
import api from '../lib/api.js'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { CATEGORY_LABELS, CATEGORY_COLORS } from '../lib/subscriptionEvents.js'
import { fmtDate } from '../lib/formatDate.js'

function fmtCad(n) {
  if (n == null) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

// Affichage humain d'un YYYY-MM ("2026-05" → "mai 2026").
function fmtMonth(m) {
  if (!m) return '—'
  const [y, mm] = String(m).split('-')
  const d = new Date(Number(y), Number(mm) - 1, 1)
  if (isNaN(d.getTime())) return m
  return d.toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' })
}

export function AbonnementEventsTable({
  data,
  loading,
  initialGroupBy = null,
  initialGroupOrder = null,
  forceAllView = false,
  height,
  searchFields = ['company_name', 'stripe_subscription_id', 'amount_cad_delta', 'previous_amount_cad', 'new_amount_cad'],
}) {
  // Synthétise `month` depuis `event_date` quand absent — nécessaire pour le
  // groupage à deux niveaux mois/catégorie sur les données venant du
  // /api/projets/abonnement-events (qui ne renvoie pas le champ).
  const normalizedData = useMemo(() => {
    if (!Array.isArray(data)) return data
    return data.map(d => d.month ? d : { ...d, month: d.event_date ? String(d.event_date).slice(0, 7) : null })
  }, [data])
  const [selectedAbo, setSelectedAbo] = useState(null)
  const [loadingAboId, setLoadingAboId] = useState(null)

  async function openAbo(subscriptionId) {
    if (!subscriptionId || loadingAboId) return
    setLoadingAboId(subscriptionId)
    try {
      const sub = await api.abonnements.get(subscriptionId)
      setSelectedAbo(sub)
    } catch {
      // sub introuvable — silencieux côté UI
    } finally {
      setLoadingAboId(null)
    }
  }

  const RENDERS = {
    event_date: row => <span className="text-slate-500 whitespace-nowrap">{fmtDate(row.event_date)}</span>,
    month: row => <span className="text-slate-500 capitalize whitespace-nowrap">{fmtMonth(row.month)}</span>,
    category: row => row.category
      ? <Badge color={CATEGORY_COLORS[row.category] || 'gray'}>{CATEGORY_LABELS[row.category] || row.category}</Badge>
      : <span className="text-slate-400">—</span>,
    company_name: row => row.company_id
      ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.company_name || '—'}</Link>
      : <span className="text-slate-400">—</span>,
    subscription_link: row => row.subscription_id
      ? (
        <button
          type="button"
          data-testid={`abo-event-open-${row.id}`}
          onClick={e => { e.stopPropagation(); openAbo(row.subscription_id) }}
          disabled={loadingAboId === row.subscription_id}
          className="text-brand-600 hover:underline font-mono text-xs disabled:opacity-50"
        >
          {row.stripe_subscription_id || row.subscription_id.slice(0, 8)}
        </button>
      )
      : <span className="text-slate-400">—</span>,
    amount_cad_delta: row => {
      if (row.amount_cad_delta == null && !row.interval_type) {
        return <span className="text-slate-400">—</span>
      }
      const cls = row.amount_cad_delta > 0
        ? 'text-emerald-700'
        : row.amount_cad_delta < 0 ? 'text-rose-700' : 'text-slate-500'
      return (
        <div className="leading-tight">
          {row.amount_cad_delta != null && (
            <div className={`tabular-nums font-medium ${cls}`}>
              {row.amount_cad_delta > 0 ? '+' : ''}{fmtCad(row.amount_cad_delta)}
            </div>
          )}
          {row.interval_type && (
            <div
              data-testid={`sub-event-interval-${row.id}`}
              className={`text-[10px] ${row.interval_type === 'year' ? 'text-amber-600' : 'text-slate-400'}`}
            >
              {row.interval_type === 'year'
                ? (row.amount_cad_delta != null
                    ? `(${(row.amount_cad_delta * 12) > 0 ? '+' : ''}${fmtCad(row.amount_cad_delta * 12)}/an)`
                    : 'Annuel')
                : 'Mensuel'}
            </div>
          )}
        </div>
      )
    },
    rachat: row => row.category === 'churn'
      ? <RachatPicker event={row} />
      : <span className="text-slate-300">—</span>,
    previous_amount_cad: row => <span className="tabular-nums text-slate-600">{fmtCad(row.previous_amount_cad)}</span>,
    new_amount_cad:      row => <span className="tabular-nums text-slate-600">{fmtCad(row.new_amount_cad)}</span>,
  }

  // formatGroupKey : utilisé par DataTable pour rendre l'en-tête de groupe
  // de façon lisible (ex. "mai 2026" au lieu de "2026-05", "Upgrade" au lieu
  // de "upgrade") quand l'utilisateur groupe sur ces colonnes.
  const GROUP_KEY_FORMATTERS = {
    month: k => fmtMonth(k),
    category: k => CATEGORY_LABELS[k] || k,
  }

  const COLUMNS = TABLE_COLUMN_META.abonnement_events.map(meta => ({
    ...meta,
    render: RENDERS[meta.id],
    formatGroupKey: GROUP_KEY_FORMATTERS[meta.id],
  }))

  return (
    <>
      <DataTable
        table="abonnement_events"
        columns={COLUMNS}
        data={normalizedData}
        loading={loading}
        searchFields={searchFields}
        onRowClick={row => openAbo(row.subscription_id)}
        initialGroupBy={initialGroupBy}
        initialGroupOrder={initialGroupOrder}
        forceAllView={forceAllView}
        {...(height ? { height } : {})}
      />
      <AbonnementDetailModal abonnement={selectedAbo} onClose={() => setSelectedAbo(null)} />
    </>
  )
}
