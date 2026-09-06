import { useState, useMemo, useEffect } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { Plus, Package } from 'lucide-react'
import api from '../lib/api.js'
import { useTable } from '../lib/dataStore.js'
import { useListData } from '../lib/useListData.js'
import { ListPage, FilterBanner } from '../components/ListPage.jsx'
import { Badge, orderStatusColor } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import OrderDetail from './OrderDetail.jsx'
import { usePeekOpenId } from '../lib/usePeekOpenId.js'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { fmtAddress } from '../utils/formatters.js'
import { weekStartOf, fmtWeekStart } from '../lib/isoWeek.js'


const RENDERS = {
  order_number: row => <span className="font-bold text-slate-900">#{row.order_number}</span>,
  company_name: row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline font-medium">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  date_commande: row => <span className="text-slate-600">{fmtDate(row.date_commande)}</span>,
  status: row => <Badge color={orderStatusColor(row.status)}>{row.status}</Badge>,
  // Priorité : champ perso — son rendu (pastille colorée) vient de sa config.
}

const COLUMNS = TABLE_COLUMN_META.orders.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

// Champs NATIFS proposés par le formulaire « Nouvelle commande ». Les autres
// champs saisissables de la table (champs perso, colonnes adoptées d'Airtable)
// s'y ajoutent tout seuls via le catalogue du registre — `includeAllFields` sur
// le RecordForm, cf. server/src/services/formFieldCatalog.js. Voir RecordForm.jsx
// pour la sémantique de `visible` / `required` (configurables par l'utilisateur).
function orderFormFields({ companies, users, projects, adresses }) {
  return [
    {
      field: 'company_id', label: 'Entreprise',
      input: ({ value, onChange }) => (
        <LinkedRecordField
          name="order_company_id"
          value={value}
          options={companies}
          labelFn={c => c.name}
          onChange={onChange}
        />
      ),
    },
    {
      field: 'assigned_to', label: 'Assigné à',
      input: ({ value, onChange }) => (
        <LinkedRecordField
          name="order_assigned_to"
          value={value}
          options={users}
          labelFn={u => u.name}
          onChange={onChange}
        />
      ),
    },
    // Priorité : champ perso, proposé par le catalogue du registre (ses choix
    // viennent de sa config) — plus besoin de le déclarer ici.
    { field: 'date_commande', label: 'Date de commande', type: 'date' },
    { field: 'notes', label: 'Notes', type: 'textarea' },
    // Masqués par défaut — disponibles via « Modifier le formulaire ».
    {
      field: 'project_id', label: 'Projet', visible: false,
      input: ({ value, onChange }) => (
        <LinkedRecordField
          name="order_project_id"
          value={value}
          options={projects}
          labelFn={p => p.name}
          onChange={onChange}
        />
      ),
    },
    // Statut : champ FORMULE côté Airtable (Airtable le calcule, Boréal le
    // recopie), donc en import seul depuis /champs/orders. `readOnly` empêche
    // de le poser dans le formulaire — la route refuserait le POST en 400, et
    // la valeur serait de toute façon écrasée au sync suivant. Le serveur pose
    // le défaut « Commande vide ».
    { field: 'status', label: 'Statut', type: 'select', visible: false, readOnly: true },
    {
      field: 'address_id', label: 'Adresse de livraison', visible: false,
      input: ({ value, onChange }) => (
        <LinkedRecordField
          name="order_address_id"
          value={value}
          options={adresses}
          labelFn={fmtAddress}
          onChange={onChange}
          getHref={a => `/adresses/${a.id}`}
        />
      ),
    },
    { field: 'is_subscription', label: 'Abonnement', type: 'checkbox', visible: false },
    { field: 'revenue_override_cad', label: 'Revenu forcé (CAD)', type: 'currency', visible: false },
    { field: 'cogs_override_cad', label: 'Coût des marchandises forcé (CAD)', type: 'currency', visible: false },
  ]
}

export default function Orders() {
  const navigate = useNavigate()
  const { peekOpenId, consumePeekOpen } = usePeekOpenId()
  const [formOpen, setFormOpen] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  // Filtre temporaire posé par un clic sur une barre du graphique « Revenus
  // expédiés » (vue globale du dashboard) : lundi de la semaine, 'YYYY-MM-DD'.
  const shippedWeek = searchParams.get('shippedWeek')

  // Cache global : hydraté au login par /api/bootstrap, rafraîchi par delta
  // polling toutes les 10s. Pas de WS direct ici — lag max ~10s acceptable
  // pour une liste de commandes.
  const { rows: ordersRaw, loading, reload } = useListData({ table: 'orders' })
  const companies = useTable('companies')
  const users = useTable('users')
  const orderItems = useTable('order_items')
  const projects = useTable('projects')
  const shipments = useTable('shipments')

  // Adresses : hors cache global, et seulement utiles quand la modale de
  // création est ouverte (le champ « Adresse de livraison » est masqué par
  // défaut) — chargées à l'ouverture, une fois.
  const [adresses, setAdresses] = useState([])
  useEffect(() => {
    if (!formOpen || adresses.length) return
    let alive = true
    api.adresses.lookup().then(d => { if (alive) setAdresses(Array.isArray(d) ? d : []) }).catch(() => {})
    return () => { alive = false }
  }, [formOpen, adresses.length])

  const formFields = useMemo(
    () => orderFormFields({ companies, users, projects, adresses }),
    [companies, users, projects, adresses],
  )

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
    if (!shippedWeek) return orders
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
  }, [orders, orderItems, shipments, shippedWeek])

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
          peek={{
            // Sans sous-titre : la fiche affiche déjà l'entreprise en chip.
            title: row => `Commande #${row.order_number}`,
            to: row => `/orders/${row.id}`,
            width: 900,
            openId: peekOpenId,
            onOpenConsumed: consumePeekOpen,
            render: (row, { close }) => <OrderDetail recordId={row.id} embedded onClose={close} /> }}
          searchFields={['order_number', 'company_name']}
          emptyState={{ icon: Package, title: 'Aucune commande', description: "Aucune commande n'a encore été créée. Crée une commande pour démarrer une vente.", cta: { label: 'Nouvelle commande', icon: Plus, onClick: openCreate } }}
        />
      )}
    </ListPage>
  )
}
