import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import { useTable } from '../lib/dataStore.js'
import { applyFilter, applyFilterGroup } from '../lib/tableFilters.js'
import { Layout } from '../components/Layout.jsx'
import { Modal } from '../components/Modal.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { PenLine, PackageOpen, Truck, ShoppingBag, Wrench, ExternalLink, Clock, AlertTriangle, Plus, ChevronDown } from 'lucide-react'
import { useToast } from '../contexts/ToastContext.jsx'

// ── URLs externes (lanceurs Airtable) ───────────────────────────────────────
const AIRTABLE_SIGNATURE_URL =
  'https://airtable.com/appN2odudZaQ43RMd/pagnWxI3F0YUNus6q?FbxG7=b%3AWzAsWyJtY2pKVCIsMTAsWyJyZWNFd212V2VhWFgzQUt4bCJdXSxbImZIcjF2Iiw2LFsicmVjRXdtdldlYVhYM0FLeGwiXSwickE1VjYiXV0'
const AIRTABLE_ACHATS_URL =
  'https://airtable.com/appB4Fehk9jYd4s4B/pagxklhkFUYRiaGVV?YDWGE=sfs60Jc1OhB4jds8M'
const AIRTABLE_RETOUR_CLIENT_URL =
  'https://airtable.com/appB4Fehk9jYd4s4B/pagMJlhZxK69fulf5?MeTpM=sfsUhPqlbLR4ZFobG'

// Achats internes considérés « ouverts » → la pièce est déjà traitée (étape 4).
const OPEN_PURCHASE_STATUSES = new Set(['Commandé', 'Reçu partiellement'])

// Étape 3 — on réutilise telle quelle la vue « À envoyer » de la page Commandes
// (un pill du DataTable orders) pour que les deux listes soient toujours identiques.
const ENVOI_PILL_LABEL = 'À envoyer'

// Applique le filtre d'un pill à une row, en gérant les deux formes : groupe
// { conjunction, rules } ou tableau de règles (legacy). Identique à useTableView.
function matchesPill(row, filters, ctx = {}) {
  if (filters?.conjunction && filters?.rules) return applyFilterGroup(row, filters, ctx)
  if (Array.isArray(filters) && filters.length > 0) return filters.every(f => applyFilter(row, f, ctx))
  return true
}

// ── Helpers report (snooze) — toujours stockés en ISO UTC Z ──────────────────
// « Demain » = prochaine minuit locale (Montréal en prod).
function tomorrowMidnightISO() {
  const d = new Date()
  d.setHours(24, 0, 0, 0)
  return d.toISOString()
}
// « Semaine prochaine » = lundi prochain à minuit (début de semaine de travail).
function nextMondayMidnightISO() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const day = d.getDay() // 0 = dimanche … 6 = samedi
  const diff = ((8 - day) % 7) || 7 // jours jusqu'au prochain lundi (jamais aujourd'hui)
  d.setDate(d.getDate() + diff)
  return d.toISOString()
}

// Gros bouton tactile qui ouvre une page externe dans un nouvel onglet.
function ExternalButton({ href, children }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-center gap-3 w-full px-6 py-5 rounded-2xl
                 bg-brand-600 hover:bg-brand-700 active:bg-brand-800 text-white
                 text-xl font-semibold shadow-sm transition-colors"
    >
      {children}
      <ExternalLink size={22} className="opacity-80" />
    </a>
  )
}

// Bouton point d'interrogation (style FontAwesome fa-question) — ouvre l'aide.
function HelpButton({ onClick, testid }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      aria-label="Aide / instructions"
      title="Aide / instructions"
      className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full
                 bg-slate-100 hover:bg-brand-100 text-slate-500 hover:text-brand-700 transition-colors"
    >
      <svg role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 512" aria-hidden="true" className="w-4 h-4">
        <path d="M80 160c0-35.3 28.7-64 64-64l32 0c35.3 0 64 28.7 64 64l0 3.6c0 21.8-11.1 42.1-29.4 53.8l-42.2 27.1c-25.2 16.2-40.4 44.1-40.4 74l0 1.4c0 17.7 14.3 32 32 32s32-14.3 32-32l0-1.4c0-8.2 4.2-15.8 11-20.2l42.2-27.1c36.6-23.6 58.8-64.1 58.8-107.7l0-3.6c0-70.7-57.3-128-128-128l-32 0C73.3 32 16 89.3 16 160c0 17.7 14.3 32 32 32s32-14.3 32-32zm80 320a40 40 0 1 0 0-80 40 40 0 1 0 0 80z" fill="currentColor"></path>
      </svg>
    </button>
  )
}

// Carte « étape » : grand en-tête (numéro + icône + titre + compteur) puis contenu.
// Repliable : un chevron à droite plie/déplie le corps (déplié par défaut).
function StepBox({ number, icon: Icon, title, count, testid, onHelp, defaultCollapsed = false, children }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  return (
    <section data-testid={testid} className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
      <header className={`flex items-center gap-4 px-6 py-5 ${collapsed ? '' : 'border-b border-slate-100'}`}>
        <div className="flex items-center justify-center w-12 h-12 rounded-2xl text-white text-xl font-bold bg-brand-600 shrink-0">
          {number}
        </div>
        <Icon size={26} className="text-slate-400 shrink-0" />
        <button
          type="button"
          onClick={() => setCollapsed(c => !c)}
          aria-expanded={!collapsed}
          className="flex-1 min-w-0 flex items-center text-left"
        >
          <h2 className="text-2xl font-bold text-slate-900 truncate">{title}</h2>
        </button>
        {onHelp && <HelpButton onClick={onHelp} testid={testid ? `${testid}-help` : undefined} />}
        {count != null && (
          <span data-testid={testid ? `${testid}-count` : undefined} className="inline-flex items-center justify-center min-w-[2.5rem] h-10 px-3 rounded-full bg-slate-100 text-slate-700 text-xl font-bold">
            {count}
          </span>
        )}
        <button
          type="button"
          data-testid={testid ? `${testid}-collapse` : undefined}
          onClick={() => setCollapsed(c => !c)}
          aria-label={collapsed ? 'Déplier' : 'Replier'}
          aria-expanded={!collapsed}
          className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
        >
          <ChevronDown size={22} className={`transition-transform ${collapsed ? '-rotate-90' : ''}`} />
        </button>
      </header>
      {!collapsed && <div className="p-6">{children}</div>}
    </section>
  )
}

// Couleur du badge « statut d'assemblage » : plus c'est bas, plus c'est urgent.
function statusBadgeClasses(pct) {
  if (pct == null) return 'bg-slate-100 text-slate-500'
  if (pct < 34) return 'bg-red-100 text-red-700'
  if (pct < 67) return 'bg-amber-100 text-amber-700'
  return 'bg-emerald-100 text-emerald-700'
}

// Ligne (lecture seule) de l'étape 5 — Production.
function ProductionRow({ p }) {
  const manque = p.finished_min_stock - p.projected_available_qty
  const possible = p.producible_qty
  // assembly_status est une fraction 0–1 dans Airtable → afficher en %.
  const pct = p.assembly_status != null ? Math.round(p.assembly_status * 100) : null

  return (
    <div data-testid="production-row" className="flex items-center gap-4 py-4 border-b border-slate-100 last:border-0">
      {p.image_url
        ? <img src={p.image_url} alt="" className="w-16 h-16 rounded-xl object-cover bg-slate-100 shrink-0" />
        : <div className="w-16 h-16 rounded-xl bg-slate-100 shrink-0" />}

      <div className="min-w-0 flex-1">
        <div className="text-lg font-semibold text-slate-900 truncate">{p.name_fr || '—'}</div>
        {p.sku && <div className="text-sm font-mono text-slate-400">{p.sku}</div>}
      </div>

      <div className="text-center shrink-0 w-28">
        <div className="text-3xl font-extrabold text-red-600 leading-none">{manque}</div>
        <div className="text-xs uppercase tracking-wide text-slate-400 mt-1">à produire</div>
      </div>

      <div className="text-center shrink-0 w-28">
        <div className="text-3xl font-bold text-slate-700 leading-none">{possible ?? '—'}</div>
        <div className="text-xs uppercase tracking-wide text-slate-400 mt-1">possible</div>
      </div>

      <span className={`shrink-0 w-20 text-center py-2 rounded-full text-lg font-bold ${statusBadgeClasses(pct)}`}>
        {pct != null ? `${pct}%` : '—'}
      </span>
    </div>
  )
}

// Ligne de l'étape 3 — Commande « à envoyer » (lecture seule, lien vers la fiche).
function EnvoiRow({ o }) {
  return (
    <Link
      to={`/orders/${o.id}?mode=expedition`}
      data-testid="envoi-row"
      className="flex items-center gap-4 py-4 border-b border-slate-100 last:border-0 hover:bg-slate-50 -mx-6 px-6 transition-colors"
    >
      <div className="min-w-0 flex-1">
        <div className="text-lg font-semibold text-slate-900 flex items-center gap-2 min-w-0">
          <span className="truncate">
            #{o.order_number}
            {o.company_name && <span className="text-slate-500 font-normal"> · {o.company_name}</span>}
          </span>
          {o.priority === 'Urgent' && (
            <span
              data-testid="envoi-urgent-tag"
              className="shrink-0 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold text-white"
              style={{ backgroundColor: '#166ee1' }}
            >
              Urgent
            </span>
          )}
        </div>
        <div className="text-sm text-slate-400 flex items-center gap-2 flex-wrap">
          {o.date_commande && <span>{fmtDate(o.date_commande)}</span>}
          {o.priority && o.priority !== 'Urgent' && <span className="text-orange-500 font-medium">· {o.priority}</span>}
        </div>
      </div>

      {o.items_count != null && (
        <div className="text-center shrink-0 w-24">
          <div className="text-2xl font-bold text-slate-700 leading-none">{o.items_count}</div>
          <div className="text-xs uppercase tracking-wide text-slate-400 mt-1">articles</div>
        </div>
      )}

      <ExternalLink size={20} className="text-slate-300 shrink-0" />
    </Link>
  )
}

// Ligne de l'étape 4 — Commande de pièces (actions Commander / Reporter).
function AchatRow({ p, snoozed, busy, snoozeOpen, onOpenOrder, onToggleSnooze, onSnooze, onCancelSnooze }) {
  return (
    <div data-testid="achat-row" className="flex items-center gap-4 py-4 border-b border-slate-100 last:border-0">
      {p.image_url
        ? <img src={p.image_url} alt="" className="w-16 h-16 rounded-xl object-cover bg-slate-100 shrink-0" />
        : <div className="w-16 h-16 rounded-xl bg-slate-100 shrink-0" />}

      <div className="min-w-0 flex-1">
        <div className="text-lg font-semibold text-slate-900 truncate">{p.name_fr || '—'}</div>
        <div className="text-sm text-slate-400 flex items-center gap-2 flex-wrap">
          {p.sku && <span className="font-mono">{p.sku}</span>}
          {p.supplier && <span>· {p.supplier}</span>}
          {p.supplier_link && (
            <a
              href={p.supplier_link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-brand-600 hover:text-brand-700 font-medium"
            >
              Fournisseur <ExternalLink size={13} />
            </a>
          )}
        </div>
      </div>

      <div className="text-center shrink-0 w-24">
        <div className="text-2xl font-extrabold text-red-600 leading-none">{p.stock_qty} / {p.min_stock}</div>
        <div className="text-xs uppercase tracking-wide text-slate-400 mt-1">stock / seuil</div>
      </div>

      <div className="text-center shrink-0 w-20">
        <div className="text-2xl font-bold text-slate-700 leading-none">{p.order_qty || '—'}</div>
        <div className="text-xs uppercase tracking-wide text-slate-400 mt-1">suggéré</div>
      </div>

      {/* Actions */}
      {snoozed ? (
        <button
          onClick={() => onCancelSnooze(p)}
          disabled={busy}
          className="shrink-0 px-4 py-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold disabled:opacity-50"
        >
          Annuler le report
        </button>
      ) : snoozeOpen ? (
        <div className="shrink-0 flex items-center gap-2">
          <button onClick={() => onSnooze(p, tomorrowMidnightISO())} disabled={busy}
            className="px-3 py-3 rounded-xl bg-amber-100 hover:bg-amber-200 text-amber-800 font-semibold disabled:opacity-50">
            Demain
          </button>
          <button onClick={() => onSnooze(p, nextMondayMidnightISO())} disabled={busy}
            className="px-3 py-3 rounded-xl bg-amber-100 hover:bg-amber-200 text-amber-800 font-semibold disabled:opacity-50">
            Sem. prochaine
          </button>
          <button onClick={() => onToggleSnooze(null)} className="px-2 py-3 text-slate-400 hover:text-slate-600">✕</button>
        </div>
      ) : (
        <div className="shrink-0 flex items-center gap-2">
          <button
            data-testid="achat-commander"
            onClick={() => onOpenOrder(p)}
            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold"
          >
            <Plus size={18} /> Commander
          </button>
          <button
            data-testid="achat-reporter"
            onClick={() => onToggleSnooze(p.id)}
            title="Reporter"
            className="inline-flex items-center gap-2 px-4 py-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 font-semibold"
          >
            <Clock size={18} /> Reporter
          </button>
        </div>
      )}
    </div>
  )
}

export default function PrioriteAssemblage() {
  const { addToast } = useToast()
  const [products, setProducts] = useState([])
  const [openPurchaseIds, setOpenPurchaseIds] = useState(() => new Set())
  const [loading, setLoading] = useState(true)

  // Étape 3 — commandes « à envoyer ». Branché sur le MÊME cache que la page
  // Commandes (dataStore) pour garantir une liste identique à sa vue « à envoyer »
  // (filtre status = 'À envoyer'). Enrichi côté client comme dans Orders.jsx.
  const ordersRaw = useTable('orders')
  const companies = useTable('companies')
  const orderItems = useTable('order_items')
  // Filtre de la vue « À envoyer » de la page Commandes, chargé depuis les pills.
  const [envoiFilter, setEnvoiFilter] = useState(null)

  // Étape 4 — état UI
  const [showReportes, setShowReportes] = useState(false)
  const [snoozeOpenId, setSnoozeOpenId] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [orderProduct, setOrderProduct] = useState(null)
  const [orderQty, setOrderQty] = useState('')
  const [orderNote, setOrderNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Aide / instructions (étape 1)
  const [helpStep1, setHelpStep1] = useState(false)
  const [zoomImage, setZoomImage] = useState(null) // src de l'image agrandie (lightbox)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [prodRes, purRes] = await Promise.all([
        api.products.list({ limit: 'all' }),
        api.purchases.list({ limit: 'all' }),
      ])
      setProducts(prodRes?.data || [])
      const open = new Set(
        (purRes?.data || [])
          .filter(pu => OPEN_PURCHASE_STATUSES.has(pu.status))
          .map(pu => pu.product_id),
      )
      setOpenPurchaseIds(open)
    } catch {
      setProducts([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Charge le pill « À envoyer » de la table orders (= la vue de la page Commandes).
  useEffect(() => {
    let cancelled = false
    api.views.get('orders')
      .then(({ pills }) => {
        if (cancelled) return
        const pill = (pills || []).find(p => p.label === ENVOI_PILL_LABEL)
        setEnvoiFilter(pill ? pill.filters : null)
      })
      .catch(() => { if (!cancelled) setEnvoiFilter(null) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => { reload() }, [reload])

  // Étape 3 — commandes « à envoyer » : exactement les mêmes que la vue de la page
  // Commandes (on applique le filtre du pill), enrichies (company_name, items_count).
  const envoiList = useMemo(() => {
    if (!envoiFilter) return []
    const cById = new Map(companies.map(c => [c.id, c.name]))
    const itemCountByOrder = new Map()
    for (const it of orderItems) {
      itemCountByOrder.set(it.order_id, (itemCountByOrder.get(it.order_id) || 0) + 1)
    }
    return ordersRaw
      .filter(o => matchesPill(o, envoiFilter))
      .map(o => ({
        ...o,
        company_name: cById.get(o.company_id) || o.company_name,
        items_count: itemCountByOrder.get(o.id) || 0,
      }))
      // Commandes urgentes en premier, puis par date de commande décroissante.
      .sort((a, b) => {
        const ua = a.priority === 'Urgent' ? 0 : 1
        const ub = b.priority === 'Urgent' ? 0 : 1
        if (ua !== ub) return ua - ub
        return (b.date_commande || '').localeCompare(a.date_commande || '')
      })
  }, [ordersRaw, companies, orderItems, envoiFilter])

  // Étape 5 — produits Fabriqué en manque, triés par statut d'assemblage ASC.
  const productionList = useMemo(() => products
    .filter(p =>
      p.procurement_type === 'Fabriqué' &&
      p.finished_min_stock != null &&
      p.projected_available_qty != null &&
      (p.finished_min_stock - p.projected_available_qty) > 0)
    .sort((a, b) => (a.assembly_status ?? Infinity) - (b.assembly_status ?? Infinity)),
  [products])

  // Étape 4 — pièces Acheté bas-de-stock, sans achat ouvert. Séparées en
  // « actives » (à traiter) et « reportées » (snooze dans le futur).
  const { achatActive, achatSnoozed } = useMemo(() => {
    const now = new Date().toISOString()
    const base = products.filter(p =>
      p.procurement_type === 'Acheté' &&
      p.min_stock > 0 &&
      p.stock_qty < p.min_stock && // strictement sous le seuil : une pièce pile au seuil (5/5) est correcte, ne pas l'afficher
      !openPurchaseIds.has(p.id))
    const deficit = p => (p.stock_qty - p.min_stock) // plus négatif = manque le plus
    const active = base
      .filter(p => !p.purchase_snooze_until || p.purchase_snooze_until <= now)
      .sort((a, b) => deficit(a) - deficit(b))
    const snoozed = base
      .filter(p => p.purchase_snooze_until && p.purchase_snooze_until > now)
      .sort((a, b) => (a.purchase_snooze_until < b.purchase_snooze_until ? -1 : 1))
    return { achatActive: active, achatSnoozed: snoozed }
  }, [products, openPurchaseIds])

  function openOrder(p) {
    setOrderProduct(p)
    setOrderQty(p.order_qty ? String(p.order_qty) : '')
    setOrderNote('')
  }

  async function submitOrder() {
    const qty = parseInt(orderQty, 10)
    if (!Number.isFinite(qty) || qty <= 0) return
    setSubmitting(true)
    try {
      await api.purchases.create({ product_id: orderProduct.id, qty_ordered: qty, notes: orderNote || undefined })
      setOrderProduct(null)
      await reload()
    } catch (e) {
      addToast({ message: 'Erreur lors de la création de l\'achat : ' + (e?.message || e), type: 'error' })
    } finally {
      setSubmitting(false)
    }
  }

  async function setSnooze(p, iso) {
    setBusyId(p.id)
    try {
      await api.products.update(p.id, { purchase_snooze_until: iso })
      setSnoozeOpenId(null)
      await reload()
    } finally {
      setBusyId(null)
    }
  }

  async function cancelSnooze(p) {
    setBusyId(p.id)
    try {
      await api.products.update(p.id, { purchase_snooze_until: null })
      await reload()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto" data-testid="priorite-assemblage">
        <h1 className="text-3xl font-bold text-slate-900 mb-6">Priorité d'assemblage</h1>

        <div className="space-y-6">
          {/* Étapes 1 & 2 — côte à côte */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Étape 1 — Signature des documents */}
            <StepBox number={1} testid="step-1" icon={PenLine} title="Signature des documents" onHelp={() => setHelpStep1(true)}>
              <ExternalButton href={AIRTABLE_SIGNATURE_URL}>Ouvrir dans Airtable</ExternalButton>
            </StepBox>

            {/* Étape 2 — Réception de pièces */}
            <StepBox number={2} testid="step-2" icon={PackageOpen} title="Réception de pièces">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <ExternalButton href={AIRTABLE_ACHATS_URL}>Achats</ExternalButton>
                <ExternalButton href={AIRTABLE_RETOUR_CLIENT_URL}>Retour client</ExternalButton>
              </div>
            </StepBox>
          </div>

          {/* Étape 3 — Commande « à envoyer » (même source que Commandes → à envoyer) */}
          <StepBox number={3} testid="step-3" icon={Truck} title="Commande « à envoyer »" count={envoiList.length}>
            {envoiList.length === 0 ? (
              <div className="py-10 text-center text-slate-400 text-lg">Aucune commande à envoyer 🎉</div>
            ) : (
              <div>
                {envoiList.map(o => <EnvoiRow key={o.id} o={o} />)}
              </div>
            )}
          </StepBox>

          {/* Étape 4 — Production (lecture seule) — interchangée avec Commande de pièces */}
          <StepBox number={4} testid="step-4" icon={Wrench} title="Production" count={loading ? null : productionList.length}>
            {loading ? (
              <div className="py-10 text-center text-slate-400 text-lg">Chargement…</div>
            ) : productionList.length === 0 ? (
              <div className="py-10 text-center text-slate-400 text-lg">Rien à produire pour l'instant 🎉</div>
            ) : (
              <div>
                {productionList.map(p => <ProductionRow key={p.id} p={p} />)}
              </div>
            )}
          </StepBox>

          {/* Étape 5 — Commande de pièces — interchangée avec Production */}
          <StepBox number={5} testid="step-5" icon={ShoppingBag} title="Commande de pièces" count={loading ? null : achatActive.length}>
            {loading ? (
              <div className="py-10 text-center text-slate-400 text-lg">Chargement…</div>
            ) : (
              <>
                {achatActive.length === 0 ? (
                  <div className="py-10 text-center text-slate-400 text-lg">Aucune pièce à commander 🎉</div>
                ) : (
                  <div>
                    {achatActive.map(p => (
                      <AchatRow
                        key={p.id}
                        p={p}
                        busy={busyId === p.id}
                        snoozeOpen={snoozeOpenId === p.id}
                        onOpenOrder={openOrder}
                        onToggleSnooze={setSnoozeOpenId}
                        onSnooze={setSnooze}
                      />
                    ))}
                  </div>
                )}

                {/* Section repliable « Reportés (N) » */}
                {achatSnoozed.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-slate-100">
                    <button
                      data-testid="reportes-toggle"
                      onClick={() => setShowReportes(v => !v)}
                      className="flex items-center gap-2 text-slate-500 hover:text-slate-700 font-medium"
                    >
                      <Clock size={16} />
                      Reportés ({achatSnoozed.length})
                      <span className="text-slate-400">{showReportes ? '▲' : '▼'}</span>
                    </button>
                    {showReportes && (
                      <div className="mt-2">
                        {achatSnoozed.map(p => (
                          <AchatRow
                            key={p.id}
                            p={p}
                            snoozed
                            busy={busyId === p.id}
                            onCancelSnooze={cancelSnooze}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </StepBox>
        </div>
      </div>

      {/* Aide — instructions étape 1 (Signature des documents) */}
      <Modal isOpen={helpStep1} onClose={() => setHelpStep1(false)} title="Étape 1 — Signature des documents" size="md">
        <div data-testid="step-1-help-modal" className="p-6 space-y-4 text-slate-700">
          <p className="text-lg">
            Cette étape sert à <strong>lire et signer les documents liés à votre nom</strong>.
          </p>
          <ol className="list-decimal pl-5 space-y-2">
            <li>Cliquer sur <strong>« Ouvrir dans Airtable »</strong> pour ouvrir la vue de signature.</li>
            <li>Dans la section <strong>« Personne is »</strong>, sélectionner <strong>votre nom</strong>.</li>
            <li>
              Ajouter le filtre <strong>« Signature pour »</strong> →
              <strong> « has none of » </strong> → <strong>votre nom</strong>.
            </li>
            <li>Lire les documents qui restent affichés, puis les signer.</li>
          </ol>
          <button
            type="button"
            onClick={() => setZoomImage('/erp/p/e11a1c50b694c8ef0915ee79046ac523')}
            className="block w-full group relative cursor-zoom-in"
            title="Cliquer pour agrandir"
          >
            <img
              src="/erp/p/e11a1c50b694c8ef0915ee79046ac523"
              alt="Illustration : filtrer la vue de signature dans Airtable"
              data-testid="step-1-help-image"
              className="w-full rounded-xl border border-slate-200 transition group-hover:opacity-90"
            />
            <span className="absolute bottom-2 right-2 px-2 py-1 rounded-md bg-black/60 text-fixed-white text-xs opacity-0 group-hover:opacity-100 transition">
              Cliquer pour agrandir
            </span>
          </button>
        </div>
      </Modal>

      {/* Lightbox plein écran — agrandissement de l'image d'aide */}
      {zoomImage && (
        <div
          data-testid="image-lightbox"
          onClick={() => setZoomImage(null)}
          className="fixed inset-0 z-[300] flex items-center justify-center bg-black/80 p-6 cursor-zoom-out"
        >
          <img
            src={zoomImage}
            alt="Illustration agrandie"
            data-testid="image-lightbox-img"
            className="max-w-full max-h-full rounded-lg shadow-2xl"
          />
        </div>
      )}

      {/* Mini-formulaire « Commander » — création d'un achat INTERNE (side effect) */}
      <Modal isOpen={!!orderProduct} onClose={() => !submitting && setOrderProduct(null)} title="Commander une pièce" size="md">
        {orderProduct && (
          <div data-testid="commander-modal" className="p-6 space-y-4">
            <div className="flex items-center gap-3">
              {orderProduct.image_url
                ? <img src={orderProduct.image_url} alt="" className="w-14 h-14 rounded-xl object-cover bg-slate-100" />
                : <div className="w-14 h-14 rounded-xl bg-slate-100" />}
              <div className="min-w-0">
                <div className="font-semibold text-slate-900 truncate">{orderProduct.name_fr}</div>
                <div className="text-sm text-slate-400">{orderProduct.sku} {orderProduct.supplier ? `· ${orderProduct.supplier}` : ''}</div>
              </div>
            </div>

            {/* Avertissement : achat interne ERP, PAS Airtable */}
            <div data-testid="commander-warning" className="flex gap-3 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm">
              <AlertTriangle size={18} className="shrink-0 mt-0.5" />
              <span>Cet achat est créé <strong>en interne dans l'ERP</strong>, PAS dans Airtable. Une référence <strong>LIA-ERP-…</strong> sera générée automatiquement.</span>
            </div>

            <label className="block">
              <span className="block text-sm font-medium text-slate-600 mb-1">Quantité commandée</span>
              <input
                type="number" min="1"
                value={orderQty}
                onChange={e => setOrderQty(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-slate-300 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none text-lg"
                autoFocus
              />
            </label>

            <label className="block">
              <span className="block text-sm font-medium text-slate-600 mb-1">Note (optionnel)</span>
              <textarea
                rows={2}
                value={orderNote}
                onChange={e => setOrderNote(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-slate-300 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
              />
            </label>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setOrderProduct(null)}
                disabled={submitting}
                className="px-5 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold disabled:opacity-50"
              >
                Annuler
              </button>
              <button
                data-testid="commander-submit"
                onClick={submitOrder}
                disabled={submitting || !(parseInt(orderQty, 10) > 0)}
                className="px-5 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold disabled:opacity-50"
              >
                {submitting ? 'Création…' : 'Créer'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </Layout>
  )
}
