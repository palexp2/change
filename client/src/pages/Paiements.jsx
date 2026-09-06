import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Banknote, ArrowDownCircle, ArrowUpCircle } from 'lucide-react'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { fmtCad, fmtNumber } from '../utils/formatters.js'
import { METHOD_LABELS } from '../components/FacturePaymentsSection.jsx'

// Les colonnes « Montant » et « Montant (CAD) » sont de type nombre : on les
// affiche en nombre brut (pas de symbole de devise). La devise est déjà portée
// par la colonne « Devise » dédiée et par le libellé « (CAD) ».
const fmtNum = n => fmtNumber(n, { decimals: 2 })

// Badge de statut QuickBooks dérivé des refs QB de la ligne :
//   - synthétique Stripe → l'écriture QB est posée au payout, pas par paiement
//   - au moins une ref QB posée → « Publié »
//   - skip volontaire → « Ignoré »
//   - sinon → « À publier »
function qbStatus(row) {
  if (row.synthetic) return { label: 'Au payout', color: 'blue' }
  if (row.qb_deposit_id || row.qb_journal_entry_id || row.qb_payment_id) return { label: 'Publié', color: 'green' }
  if (row.qb_skipped) return { label: 'Ignoré', color: 'gray' }
  return { label: 'À publier', color: 'yellow' }
}

const RENDERS = {
  received_at: row => <span className="text-slate-500">{fmtDate(row.received_at)}</span>,
  direction: row => row.direction === 'out'
    ? <Badge color="purple"><ArrowUpCircle size={12} className="inline -mt-0.5 mr-1" />Remboursement</Badge>
    : <Badge color="green"><ArrowDownCircle size={12} className="inline -mt-0.5 mr-1" />Encaissement</Badge>,
  method: row => <span className="text-slate-700">{METHOD_LABELS[row.method] || row.method || '—'}</span>,
  company_name: row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  document_number: row => row.facture_id && row.document_number
    ? <Link to={`/factures/${row.facture_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline font-mono">{row.document_number}</Link>
    : <span className="text-slate-400">—</span>,
  amount: row => {
    const val = row.direction === 'out' ? -Math.abs(row.amount) : row.amount
    return <span className={`tabular-nums font-medium ${row.direction === 'out' ? 'text-purple-600' : 'text-slate-800'}`}>{fmtNum(val)}</span>
  },
  currency: row => <span className="font-mono text-xs text-slate-600">{row.currency || '—'}</span>,
  amount_cad: row => row.amount_cad != null
    ? <span className="tabular-nums text-slate-700">{fmtNum(row.direction === 'out' ? -Math.abs(row.amount_cad) : row.amount_cad)}</span>
    : <span className="text-slate-300">—</span>,
  qb_status: row => {
    const s = qbStatus(row)
    const url = row.qb_deposit_url || row.qb_journal_entry_url || row.qb_payment_url
    return url ? (
      <a href={url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
        title="Ouvrir la transaction dans QuickBooks">
        <Badge color={s.color}>{s.label} ↗</Badge>
      </a>
    ) : <Badge color={s.color}>{s.label}</Badge>
  },
  notes: row => row.notes
    ? <span className="text-slate-600 line-clamp-2 whitespace-pre-wrap" title={row.notes}>{row.notes}</span>
    : <span className="text-slate-300">—</span>,
}

const COLUMNS = TABLE_COLUMN_META.payments.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function Paiements() {
  const { addToast } = useToast()
  const [payments, setPayments] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.payments.list({ limit, page }),
      setPayments, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])

  // Édition inline (mode tableur) d'une valeur de champ personnalisé. Seules les
  // colonnes custom sont éditables (les colonnes natives n'ont pas de flag
  // `editable`). Les lignes Stripe synthétiques n'ont pas de row payments réelle
  // → pas de valeur custom stockable.
  const updateCustomField = useCallback(async (row, col, value) => {
    if (row.synthetic) {
      addToast({ message: 'Paiement Stripe automatique — champ personnalisé non éditable sur cette ligne.', type: 'error' })
      return
    }
    try {
      const updated = await api.payments.update(row.id, { [col.field]: value })
      // Patch optimiste : on remplace la ligne par la version renvoyée (champs
      // virtuels recalculés inclus), sans reload complet.
      setPayments(prev => prev.map(p => p.id === row.id ? { ...p, ...updated } : p))
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }, [addToast])

  // Total encaissé net (CAD) sur les lignes chargées, pour un repère rapide en
  // en-tête. Encaissements comptés positifs, remboursements négatifs. On ignore
  // les lignes sans amount_cad (encaissements Stripe convertis au payout).
  const netCad = useMemo(
    () => payments.reduce((sum, p) => {
      if (p.amount_cad == null) return sum
      return sum + (p.direction === 'out' ? -Math.abs(p.amount_cad) : Math.abs(p.amount_cad))
    }, 0),
    [payments]
  )

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <PageTitle>Paiements</PageTitle>
          <div className="text-sm text-slate-500" data-testid="paiements-net-cad">
            Net saisi (CAD) : <span className="font-medium text-slate-800">{fmtCad(netCad)}</span>
          </div>
        </div>

        <DataTable
          table="payments"
          manageViews
          columns={COLUMNS}
          data={payments}
          searchFields={['company_name', 'document_number', 'method', 'notes', 'amount']}
          loading={loading}
          onCellEdit={updateCustomField}
          emptyState={{
            icon: Banknote,
            title: 'Aucun paiement',
            description: 'Les encaissements et remboursements apparaissent ici : paiements Stripe, chèques, virements, Interac et remboursements enregistrés sur les factures.',
          }}
        />
      </div>
    </Layout>
  )
}
