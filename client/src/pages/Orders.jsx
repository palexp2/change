import { useState, useMemo, useEffect } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { Plus, Package } from 'lucide-react'
import api from '../lib/api.js'
import { useTable } from '../lib/dataStore.js'
import { useListData } from '../lib/useListData.js'
import { ListPage, FilterBanner } from '../components/ListPage.jsx'
import { Badge, orderStatusColor } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { useOrderFormFields } from '../components/OrderCreateModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { weekStartOf, fmtWeekStart } from '../lib/isoWeek.js'
import { ENVOI_PILL_LABEL, hasItemsToShip } from '../lib/ordersToShip.js'


const RENDERS = {
  order_number: row => <span className="font-bold text-slate-900">#{row.order_number}</span>,
  company_name: row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="link-record font-medium">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  date_commande: row => <span className="text-slate-600">{fmtDate(row.date_commande)}</span>,
  status: row => <Badge color={orderStatusColor(row.status)}>{row.status}</Badge>,
  // Priorité : champ perso — son rendu (pastille colorée) vient de sa config.
}

const COLUMNS = TABLE_COLUMN_META.orders.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

// Les champs du formulaire « Nouvelle commande » vivent dans
// components/OrderCreateModal.jsx : la fiche projet ouvre le MÊME formulaire.

export default function Orders() {
  const navigate = useNavigate()
  const [formOpen, setFormOpen] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  // Filtre temporaire posé par un clic sur une barre du graphique « Revenus
  // expédiés » (vue globale du dashboard) : lundi de la semaine, 'YYYY-MM-DD'.
  const shippedWeek = searchParams.get('shippedWeek')
  // Vue active : useTableView l'écrit toujours dans l'URL (`?vue=<id>`).
  const activeViewId = searchParams.get('vue')
  const [envoiViewId, setEnvoiViewId] = useState(null)

  // Cache global : hydraté au login par /api/bootstrap, rafraîchi par delta
  // polling toutes les 10s. Pas de WS direct ici — lag max ~10s acceptable
  // pour une liste de commandes.
  const { rows: ordersRaw, loading, reload } = useListData({ table: 'orders' })
  const companies = useTable('companies')
  const orderItems = useTable('order_items')
  const shipments = useTable('shipments')

  const formFields = useOrderFormFields(formOpen)

  // Id du pill « À envoyer » — on ne le code pas en dur, il est éditable.
  useEffect(() => {
    let cancelled = false
    api.views.get('orders')
      .then(({ pills }) => {
        if (cancelled) return
        setEnvoiViewId((pills || []).find(p => p.label === ENVOI_PILL_LABEL)?.id || null)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Enrichissement : company_name, items_count — joints côté client depuis les
  // autres tables en cache (vs server-side LEFT JOIN). Le nom de l'assigné n'y
  // est plus : son champ a été supprimé des commandes le 2026-09-03, la colonne
  // sort du snapshot et plus rien ne l'affiche.
  const orders = useMemo(() => {
    const cById = new Map(companies.map(c => [c.id, c.name]))
    const itemCountByOrder = new Map()
    for (const it of orderItems) {
      itemCountByOrder.set(it.order_id, (itemCountByOrder.get(it.order_id) || 0) + 1)
    }
    return ordersRaw.map(r => ({
      ...r,
      company_name: cById.get(r.company_id) || r.company_name,
      items_count: itemCountByOrder.get(r.id) || 0,
    }))
  }, [ordersRaw, companies, orderItems])

  // Semaine d'expédition : mêmes règles que la barre « Revenus expédiés » du
  // dashboard (voir weeklyProfitability dans server/src/routes/dashboard.js) —
  // commande au statut « Envoyé », semaine du DERNIER envoi, et au moins un
  // article facturable (les commandes 100 % remplacement ne portent pas de
  // revenu et ne sont donc pas dans la barre).
  const displayedOrders = useMemo(() => {
    if (!shippedWeek) {
      // Vue « À envoyer » : les commandes sans article n'ont rien à expédier.
      if (envoiViewId && activeViewId === envoiViewId) return orders.filter(hasItemsToShip)
      return orders
    }
    const lastShippedByOrder = new Map()
    for (const s of shipments) {
      if (!s.order_id || !s.shipped_at) continue
      const prev = lastShippedByOrder.get(s.order_id)
      if (!prev || String(s.shipped_at) > String(prev)) lastShippedByOrder.set(s.order_id, s.shipped_at)
    }
    const billable = new Set()
    for (const it of orderItems) {
      if (it.item_type === 'Facturable') billable.add(it.order_id)
    }
    return orders.filter(o =>
      o.status === 'Envoyé' &&
      billable.has(o.id) &&
      weekStartOf(lastShippedByOrder.get(o.id)) === shippedWeek
    )
  }, [orders, orderItems, shipments, shippedWeek, activeViewId, envoiViewId])

  async function handleCreate(form) {
    const order = await api.orders.create(form)
    await reload()
    navigate(`/orders/${order.id}`)
  }

  return (
    <ListPage
      title="Commandes"
      create={{
        label: 'Nouvelle commande', table: 'orders', fields: formFields, includeAllFields: true,
        onSubmit: handleCreate, submitLabel: 'Créer la commande', savingLabel: 'Création...',
        onOpenChange: setFormOpen,
      }}
      banner={shippedWeek && (
        <FilterBanner onClear={() => setSearchParams({})} testId="orders-shipped-week-filter">
          Commandes expédiées — semaine du {fmtWeekStart(shippedWeek)} ({displayedOrders.length})
        </FilterBanner>
      )}
    >
      {({ openCreate }) => (
        <DataTable
          table="orders"
          manageViews
          columns={COLUMNS}
          data={displayedOrders}
          loading={loading}
          forceAllView={!!shippedWeek}
          // Fiche commande en pleine page (comme entreprise et contact), pas
          // en panneau latéral — route /orders/:id dans App.jsx.
          onRowClick={row => navigate(`/orders/${row.id}`)}
          searchFields={['order_number', 'company_name']}
          emptyState={{ icon: Package, title: 'Aucune commande', description: "Aucune commande n'a encore été créée. Crée une commande pour démarrer une vente.", cta: { label: 'Nouvelle commande', icon: Plus, onClick: openCreate } }}
        />
      )}
    </ListPage>
  )
}
