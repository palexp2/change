import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Tags, RefreshCw, Unlink } from 'lucide-react'
import api from '../lib/api.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtMoney } from '../utils/formatters.js'
import SaleOfferDetail from './SaleOfferDetail.jsx'

// Catalogue de vente = produits Stripe, deux faces d'un même objet : chaque
// produit Stripe actif a sa fiche (créée par le miroir), chaque fiche a son
// produit Stripe. Colonne « Soumission » : proposé dans le constructeur de
// soumission (/api/catalog). Le bouton « non relié » n'apparaît que s'il en reste.

const INTERVAL_LABELS = { month: '/mois', year: '/an', week: '/sem.', day: '/jour' }
export const priceLabel = p => `${fmtMoney((p.unit_amount || 0) / 100, (p.currency || 'cad').toUpperCase())}${p.interval ? INTERVAL_LABELS[p.interval] || '' : ''}`

const STALE_MS = 10 * 60e3

const money = (v, cur) => (Number(v) ? <span className="tabular-nums text-slate-700">{fmtMoney(Number(v), cur)}</span> : null)
const OFFER_RENDERS = {
  sku: row => <span className="text-xs text-slate-500 font-mono">{row.sku}</span>,
  name_fr: row => <span className="font-medium text-slate-800">{row.name_fr}</span>,
  price_cad: row => money(row.price_cad, 'CAD'),
  price_usd: row => money(row.price_usd, 'USD'),
  monthly_price_cad: row => money(row.monthly_price_cad, 'CAD'),
  monthly_price_usd: row => money(row.monthly_price_usd, 'USD'),
  offer_legacy: row => row.offer_legacy ? null : <span className="text-green-600" title="Proposé en soumission">✓</span>,
}
const OFFER_COLUMNS = TABLE_COLUMN_META.catalogue_offers.map(meta => ({ ...meta, render: OFFER_RENDERS[meta.id] }))

const STRIPE_RENDERS = {
  name: row => <span className={row.active ? 'font-medium text-slate-800' : 'text-slate-400 line-through'}>{row.name}</span>,
  prices: row => (
    <span className="flex flex-wrap gap-1">
      {row.prices.map(p => <span key={p.id} className="text-xs bg-slate-100 text-slate-700 rounded px-1.5 py-0.5 tabular-nums">{priceLabel(p)}</span>)}
    </span>
  ),
  active: row => row.active ? <span className="text-green-600">●</span> : <span className="text-slate-300">●</span>,
  id: row => <span className="text-xs text-slate-500 font-mono">{row.id}</span>,
}
const STRIPE_COLUMNS = TABLE_COLUMN_META.stripe_products.map(meta => ({ ...meta, render: STRIPE_RENDERS[meta.id] }))

export default function StripeCatalog() {
  const navigate = useNavigate()
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState(null)
  const [unlinkedOnly, setUnlinkedOnly] = useState(false)
  const [openId, setOpenId] = useState(null)
  const syncedAt = useRef(null)
  const unlinked = useRef([])
  const list = useListData({
    fetch: () => api.stripeCatalog.list().then(r => {
      syncedAt.current = r.synced_at
      unlinked.current = r.unlinked.map(p => ({ ...p, price_label: p.prices.map(priceLabel).join(' ') }))
      return { data: r.offers.map(o => ({ ...o, in_quotes: !o.offer_legacy })) }
    }),
    cacheKey: 'sale_offers',
  })

  async function sync() {
    setSyncing(true)
    setError(null)
    try { await api.stripeCatalog.sync(); await list.reload() }
    catch (e) { setError(e.message) }
    finally { setSyncing(false) }
  }

  // Miroir Stripe vieux de plus de 10 min : relu à l'ouverture.
  useEffect(() => {
    if (list.loading) return
    if (!syncedAt.current || Date.now() - Date.parse(syncedAt.current) > STALE_MS) sync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.loading])

  async function handleCreate(values) {
    const created = await api.stripeCatalog.createOffer(values)
    await list.reload()
    setUnlinkedOnly(false)
    setOpenId(created.id)
  }

  return (
    <ListPage
      title="Catalogue de vente"
      icon={Tags}
      titleExtra={<>
        {(unlinkedOnly || unlinked.current.length > 0) && (
          <button onClick={() => setUnlinkedOnly(v => !v)} data-testid="catalog-unlinked"
            className={unlinkedOnly ? 'btn-primary' : 'btn-secondary'} title="Produits Stripe non reliés">
            <Unlink size={14} /> {unlinked.current.length || ''}
          </button>
        )}
        <button onClick={sync} disabled={syncing} className="btn-secondary" title="Relire Stripe" data-testid="stripe-catalog-sync">
          <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
        </button>
      </>}
      create={{
        label: 'Nouveau produit',
        submitLabel: 'Créer',
        onSubmit: handleCreate,
        fields: [{ field: 'name', label: 'Nom', required: true, locked: true }],
      }}
    >
      {({ openCreate }) => (<>
        {error && <div className="mb-3 text-sm text-red-600">{error}</div>}
        {unlinkedOnly ? (
          <DataTable
            key="unlinked"
            table="stripe_products"
            columns={STRIPE_COLUMNS}
            data={unlinked.current}
            loading={list.loading}
            searchFields={['name', 'description', 'id', 'price_label']}
            onRowClick={row => navigate(`/catalogue-vente/${row.id}`)}
            emptyState={{ icon: Tags, title: 'Tout est relié' }}
          />
        ) : (
          <DataTable
            key="offers"
            table="catalogue_offers"
            columns={OFFER_COLUMNS}
            data={list.rows}
            loading={list.loading}
            searchFields={['name_fr', 'name_en', 'sku']}
            // Ids « sellable-… » hors du registre des fiches : panneau du tableau.
            peek={{
              title: row => row.name_fr || row.name_en || 'Produit',
              subtitle: row => row.sku || '',
              width: 720,
              openId,
              onOpenConsumed: () => setOpenId(null),
              render: row => <SaleOfferDetail recordId={row.id} onChanged={list.reload} />,
            }}
            emptyState={{ icon: Tags, title: 'Aucun produit', cta: { label: 'Nouveau produit', onClick: openCreate } }}
          />
        )}
      </>)}
    </ListPage>
  )
}
