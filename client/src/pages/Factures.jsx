import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Link, useSearchParams, useLocation, useNavigate } from 'react-router-dom'
import { X, FileText, SlidersHorizontal, RefreshCw } from 'lucide-react'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { Badge, FACTURE_STATUS_COLORS as STATUS_COLORS } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { CustomFieldModal } from '../components/CustomFieldModal.jsx'
import { StripeFieldMapModal } from '../components/StripeFieldMapModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { useEntityListRealtime } from '../lib/useRealtimeChannel.js'
import { useCustomFields } from '../lib/useCustomFields.js'
import { useToast } from '../contexts/ToastContext.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { fmtCad } from '../utils/formatters.js'
import { customFieldToColumn } from '../lib/customFieldDisplay.jsx'
import { summarizeDependents } from '../lib/customFieldDeps.js'
import { AbonnementDetailModal } from '../components/AbonnementDetailModal.jsx'
import RecordPeekDrawer from '../components/RecordPeekDrawer.jsx'
import FactureDetail from './FactureDetail.jsx'
import CompanyDetail from './CompanyDetail.jsx'



const RENDERS = {
  document_number: row => <span className="font-mono font-medium text-slate-900">{row.document_number || '—'}</span>,
  // company_name : render surchargé dans COLUMNS_WITH_CUSTOM (ouvre le
  // side-peek entreprise au lieu de naviguer) — fallback lien simple ici.
  company_name:    row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  project_name:    row => <span className="text-slate-600">{row.project_name || '—'}</span>,
  order_number:    row => row.order_id && row.order_number
    ? <Link to={`/orders/${row.order_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">#{row.order_number}</Link>
    : <span className="text-slate-400">—</span>,
  status:          row => row.status
    ? <Badge color={STATUS_COLORS[row.status] || 'gray'}>{row.status}</Badge>
    : <span className="text-slate-400">—</span>,
  document_date:   row => <span className="text-slate-500">{fmtDate(row.document_date)}</span>,
  payment_date:    row => <span className="text-slate-500">{fmtDate(row.payment_date)}</span>,
  due_date:        row => <span className="text-slate-500">{fmtDate(row.due_date)}</span>,
  invoice_id:      row => row.invoice_id
    ? <span className="font-mono text-xs text-slate-500">{row.invoice_id}</span>
    : <span className="text-slate-400">—</span>,
  payment_reference: row => row.payment_reference
    ? <span className="font-mono text-xs text-slate-500 break-all" title={row.payment_reference}>{row.payment_reference}</span>
    : <span className="text-slate-400">—</span>,
  currency:        row => row.currency
    ? <span className="font-mono text-xs text-slate-600">{row.currency}</span>
    : <span className="text-slate-400">—</span>,
  amount_before_tax_cad: row => <span className="font-medium text-slate-700">{fmtCad(row.amount_before_tax_cad)}</span>,
  total_amount:    row => <span className="font-medium text-slate-700">{fmtCad(row.total_amount)}</span>,
  balance_due:     row => {
    const val = row.balance_due
    if (!val && val !== 0) return <span className="text-slate-400">—</span>
    return <span className={`font-medium ${val > 0 ? 'text-red-600' : 'text-green-600'}`}>{fmtCad(val)}</span>
  },
  is_sent:         row => (
    <span className={row.is_sent ? 'text-slate-700' : 'text-slate-400'}>
      {row.is_sent ? 'Oui' : 'Non'}
    </span>
  ),
  deferred_revenue_state: row => {
    const v = row.deferred_revenue_state
    if (v === 'Constaté') return <Badge color="green">Constaté</Badge>
    if (v === 'En attente') return <Badge color="yellow">En attente</Badge>
    return <span className="text-slate-300">—</span>
  },
  notes: row => row.notes
    ? <span className="text-slate-600 line-clamp-2 whitespace-pre-wrap" title={row.notes}>{row.notes}</span>
    : <span className="text-slate-300">—</span>,
}

const COLUMNS = TABLE_COLUMN_META.factures.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

// Surveille les deux ré-imports qui alimentent la table factures :
//   - batch Stripe (POST /stripe-queue/batch-enrich, progression processed/total)
//   - resync Airtable du module factures (POST /connectors/sync/factures)
// Poll léger (endpoints en mémoire côté serveur) tant que la page est montée ;
// `kick()` force un poll immédiat + un second à 1,5 s (les modales lancent le
// ré-import en fire-and-forget, le premier poll peut arriver avant le POST).
// `onFinished` est appelé à la transition en cours → terminé (reload + toast).
function useReimportStatus(onFinished) {
  const [stripeBatch, setStripeBatch] = useState(null) // batchProgress serveur
  const [airtableSync, setAirtableSync] = useState(null) // { running, error, … }
  const wasRunningRef = useRef(false)

  const poll = useCallback(async () => {
    const [batch, syncs] = await Promise.all([
      api.stripeQueue.batchStatus().catch(() => null),
      api.connectors.syncStatus().catch(() => null),
    ])
    if (batch) setStripeBatch(batch)
    if (syncs) setAirtableSync(syncs.factures || null)
    const running = !!batch?.running || !!syncs?.factures?.running
    if (wasRunningRef.current && !running) onFinished?.()
    wasRunningRef.current = running
  }, [onFinished])

  useEffect(() => {
    poll()
    const id = setInterval(poll, 4000)
    return () => clearInterval(id)
  }, [poll])

  const kick = useCallback(() => {
    poll()
    const id = setTimeout(poll, 1500)
    return () => clearTimeout(id)
  }, [poll])

  return { stripeBatch, airtableSync, kick }
}

// Pills d'état affichées dans l'en-tête de /factures pendant un ré-import.
function ReimportIndicator({ stripeBatch, airtableSync }) {
  if (!stripeBatch?.running && !airtableSync?.running) return null
  return (
    <div className="flex items-center gap-2" data-testid="factures-reimport-indicator">
      {stripeBatch?.running && (
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-brand-50 border border-brand-200 text-xs font-medium text-brand-700"
          title="Toutes les factures Stripe sont en cours de ré-import — la liste se met à jour en continu"
          data-testid="factures-reimport-stripe"
        >
          <RefreshCw size={12} className="animate-spin" />
          Ré-import Stripe en cours…
          {stripeBatch.total > 0 && (
            <span className="text-brand-500 font-normal tabular-nums">
              {stripeBatch.processed}/{stripeBatch.total}
            </span>
          )}
        </span>
      )}
      {airtableSync?.running && (
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-brand-50 border border-brand-200 text-xs font-medium text-brand-700"
          title="Resynchronisation Airtable des liens projet/commande en cours"
          data-testid="factures-reimport-airtable"
        >
          <RefreshCw size={12} className="animate-spin" />
          Resync Airtable en cours…
        </span>
      )}
    </div>
  )
}

// Cellule « Abonnement » (colonne custom subscription_id) : id cliquable qui
// ouvre l'abonnement lié (AbonnementDetailModal, comme dans FactureDetail).
// L'API résout aussi bien l'id local que le stripe_id (sub_xxx).
function SubscriptionCell({ row, onOpen }) {
  const { addToast } = useToast()
  const [loading, setLoading] = useState(false)

  if (!row.subscription_id) return <span className="text-slate-400">—</span>

  async function handleClick(e) {
    e.stopPropagation()
    if (loading) return
    setLoading(true)
    try {
      const sub = await api.abonnements.get(row.subscription_id)
      onOpen(sub)
    } catch {
      addToast({ message: 'Abonnement introuvable', type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      type="button"
      data-testid="facture-subscription-link"
      onClick={handleClick}
      disabled={loading}
      title="Ouvrir l'abonnement"
      className="text-brand-600 hover:underline font-mono text-xs disabled:opacity-50 truncate"
    >
      {row.subscription_id}
    </button>
  )
}

export default function Factures() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { addToast } = useToast()
  const confirm = useConfirm()
  // Drilldown depuis le dashboard « Encaissements Stripe » :
  //   month=YYYY-MM filtre sur le mois de document_date (date de facturation)
  //   type=service|achat filtre sur la présence d'un abonnement lié
  // Côté Stripe uniquement : on ne montre que les factures sync_source='Factures Stripe'
  // au statut payé pour rester cohérent avec le widget dashboard.
  const month = searchParams.get('month')
  const typeFilter = searchParams.get('type') // 'service' | 'achat' | null

  const [factures, setFactures] = useState([])
  const [loading, setLoading] = useState(true)
  const { fields: customFields, loaded: customFieldsLoaded, reload: reloadCustomFields } = useCustomFields('factures')
  const [customFieldModal, setCustomFieldModal] = useState(null) // { editing: field|null }
  const [stripeMapOpen, setStripeMapOpen] = useState(false)
  const [subscriptionModal, setSubscriptionModal] = useState(null)
  const [companyPeek, setCompanyPeek] = useState(null) // { id, name } — side-peek entreprise

  // Ouverture du side-peek demandée par la fiche plein écran (« revenir au
  // panneau latéral ») — l'id voyage via location.state.peekId. Consommée une
  // fois le drawer ouvert, et le state d'historique est nettoyé pour qu'un
  // refresh ne rouvre pas le drawer.
  const location = useLocation()
  const navigate = useNavigate()
  const [peekOpenId, setPeekOpenId] = useState(() => location.state?.peekId ?? null)
  const consumePeekOpen = useCallback(() => {
    setPeekOpenId(null)
    navigate(location.pathname + location.search, { replace: true, state: null })
  }, [navigate, location.pathname, location.search])

  const customFieldsByColumn = useMemo(() => {
    const m = new Map()
    for (const f of customFields) m.set(f.column_name, f)
    return m
  }, [customFields])

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.factures.list({ limit, page }),
      setFactures, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])

  useEntityListRealtime('facture', setFactures)

  // Indicateur de ré-import (signalement /factures) : pill visible tant qu'un
  // batch Stripe ou une resync Airtable tourne ; à la fin, recharge la liste
  // et confirme par un toast.
  const onReimportFinished = useCallback(() => {
    load()
    addToast({ message: 'Ré-import des factures terminé', type: 'success' })
  }, [load, addToast])
  const { stripeBatch, airtableSync, kick: kickReimportPoll } = useReimportStatus(onReimportFinished)

  async function handleDeleteCustomField(field) {
    // Rapport d'usage : liste les dépendances (champs calculés, automations,
    // vues, règles de visibilité) que la suppression va affecter, avant de les
    // casser en silence (#ERROR).
    let dependents = []
    try { dependents = (await api.customFields.dependents(field.id))?.dependents || [] } catch {}
    const depMsg = summarizeDependents(dependents)
    if (!(await confirm({
      title: 'Supprimer le champ',
      message: `Supprimer le champ "${field.name}" ? Restaurable depuis la corbeille.${depMsg}`,
      confirmLabel: dependents.length ? 'Supprimer quand même' : 'Supprimer',
    }))) return
    try {
      await api.customFields.delete(field.id)
      addToast({ message: 'Champ supprimé', type: 'success' })
      await reloadCustomFields()
      load()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }

  const displayedFactures = useMemo(() => {
    if (!month && !typeFilter) return factures
    return factures.filter(f => {
      if (month) {
        if (!f.document_date || !f.document_date.startsWith(month)) return false
        // Cohérent avec les widgets « Ventes » / « Abonnements » : factures Stripe
        // payées + remboursements Stripe du même mois (peu importe leur type
        // exact, l'utilisateur veut voir les déductions à côté des ventes).
        const isPaidSale = f.sync_source === 'Factures Stripe' && f.status === 'Payé'
        const isRefund = f.sync_source === 'Remboursements Stripe'
        if (!isPaidSale && !isRefund) return false
        // Le filtre par type ne s'applique qu'aux ventes — les remboursements
        // restent visibles indépendamment puisqu'on ne peut pas les classer
        // côté client (la classification se fait au backend).
        if (isPaidSale) {
          if (typeFilter === 'service' && !f.subscription_id) return false
          if (typeFilter === 'achat' && f.subscription_id) return false
        }
        return true
      }
      if (typeFilter === 'service' && !f.subscription_id) return false
      if (typeFilter === 'achat' && f.subscription_id) return false
      return true
    })
  }, [factures, month, typeFilter])

  // Colonnes finales = COLUMNS hardcodées + champs custom dynamiques.
  // Pour les formules / lookups, le serveur retourne déjà la valeur calculée
  // dans `cf_<column_name>`, donc le render est juste un texte.
  // La colonne entreprise est surchargée ici : le clic ouvre la fiche dans un
  // side-peek (comme le clic sur la ligne pour la facture) au lieu de naviguer.
  const COLUMNS_WITH_CUSTOM = useMemo(
    () => [...COLUMNS.map(c => c.id === 'company_name'
      ? {
          ...c,
          render: row => row.company_id
            ? (
              <button
                type="button"
                data-testid="facture-company-link"
                onClick={e => { e.stopPropagation(); setCompanyPeek({ id: row.company_id, name: row.company_name }) }}
                title="Aperçu de l'entreprise"
                className="text-brand-600 hover:underline text-left"
              >{row.company_name}</button>
            )
            : <span className="text-slate-400">—</span>,
        }
      : c
    ), ...customFields.map(f => {
      const col = customFieldToColumn(f)
      // Champ « Abonnement » : rendre l'id cliquable pour ouvrir l'abonnement.
      if (f.column_name === 'subscription_id') {
        return { ...col, render: row => <SubscriptionCell row={row} onOpen={setSubscriptionModal} /> }
      }
      return col
    })],
    [customFields]
  )

  const filterLabel = (() => {
    if (!month && !typeFilter) return null
    const parts = []
    if (month) {
      const [y, mo] = month.split('-')
      const d = new Date(Number(y), Number(mo) - 1, 1)
      parts.push(`facturées en ${d.toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' })}`)
    }
    if (typeFilter === 'service') parts.push('abonnement')
    else if (typeFilter === 'achat') parts.push('vente')
    return parts.join(' · ')
  })()

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900">Factures clients</h1>
            <ReimportIndicator stripeBatch={stripeBatch} airtableSync={airtableSync} />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setStripeMapOpen(true)}
              className="btn-secondary btn-sm flex items-center gap-1.5"
              title="Choisir quels champs Stripe alimentent les colonnes des factures"
              data-testid="factures-stripe-map-open"
            >
              <SlidersHorizontal size={13} /> Sync Stripe
            </button>
          </div>
        </div>

        {filterLabel && (
          <div className="flex items-center gap-2 mb-4 px-3 py-2 bg-brand-50 border border-brand-200 rounded-lg w-fit">
            <span className="text-sm text-brand-700 font-medium">Ventes &amp; abonnements — {filterLabel}</span>
            <span className="text-xs text-brand-400">{displayedFactures.length} facture{displayedFactures.length !== 1 ? 's' : ''}</span>
            <button
              onClick={() => setSearchParams({})}
              className="text-brand-400 hover:text-brand-700 ml-1"
              title="Effacer le filtre"
              aria-label="Effacer le filtre"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <DataTable
          table="factures"
          manageViews
          columns={COLUMNS_WITH_CUSTOM}
          data={displayedFactures}
          searchFields={['document_number', 'company_name', 'project_name', 'order_number', 'total_amount', 'amount_before_tax_cad', 'balance_due', 'notes']}
          loading={loading}
          peek={{
            title: row => row.document_number || `Facture #${row.id}`,
            subtitle: row => row.company_name || '',
            to: row => `/factures/${row.id}`,
            width: 720,
            openId: peekOpenId,
            onOpenConsumed: consumePeekOpen,
            render: (row, { close }) => <FactureDetail recordId={row.id} embedded onClose={close} />,
          }}
          customFieldsByColumn={customFieldsByColumn}
          customFieldsLoaded={customFieldsLoaded}
          // Le menu d'en-tête (duplication, masquage global) crée ou masque des
          // champs sans passer par les gestionnaires de cette page : sans ce
          // rappel, sa liste de champs resterait périmée jusqu'au rechargement.
          onFieldsChanged={async () => { await reloadCustomFields(); load() }}
          onAddCustomField={() => setCustomFieldModal({ editing: null })}
          onEditCustomField={(field) => setCustomFieldModal({ editing: field })}
          onDeleteCustomField={handleDeleteCustomField}
          emptyState={{ icon: FileText, title: 'Aucune facture', description: "Aucune facture n'a encore été émise. Les factures apparaissent ici une fois créées ou synchronisées." }}
        />
      </div>

      <StripeFieldMapModal
        isOpen={stripeMapOpen}
        onClose={() => setStripeMapOpen(false)}
        onSaved={() => { load(); kickReimportPoll() }}
      />


      {/* Side-peek abonnement (clic sur la colonne « Abonnement ») */}
      <AbonnementDetailModal
        abonnement={subscriptionModal}
        onClose={() => setSubscriptionModal(null)}
        variant="peek"
      />

      {/* Side-peek entreprise (clic sur la colonne « Entreprise ») */}
      <RecordPeekDrawer
        open={!!companyPeek}
        onClose={() => setCompanyPeek(null)}
        title={companyPeek?.name || 'Entreprise'}
        to={companyPeek ? `/companies/${companyPeek.id}` : undefined}
        width={860}
      >
        {companyPeek && (
          <CompanyDetail recordId={companyPeek.id} embedded onClose={() => setCompanyPeek(null)} />
        )}
      </RecordPeekDrawer>

      <CustomFieldModal
        isOpen={!!customFieldModal}
        onClose={() => setCustomFieldModal(null)}
        erpTable="factures"
        editing={customFieldModal?.editing || null}
        onSaved={async () => { await reloadCustomFields(); load() }}
        onDeleted={async () => { await reloadCustomFields(); load() }}
      />
    </Layout>
  )
}
