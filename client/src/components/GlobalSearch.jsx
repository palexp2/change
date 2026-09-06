import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Building2, Users, TrendingUp, ShoppingCart, Package, LifeBuoy, MessageSquare, X, Barcode, FileText, Receipt, CornerDownLeft, Clock, Truck, RotateCcw, Boxes, UserRound, BookUser, RefreshCw } from 'lucide-react'
import api from '../lib/api.js'
import { defaultNavItems } from '../lib/navItems.js'
import { useRecentRecords, clearRecentRecords } from '../lib/useRecentRecords.js'

const TYPE_ICON = {
  company: Building2,
  contact: Users,
  project: TrendingUp,
  order: ShoppingCart,
  product: Package,
  serial: Barcode,
  ticket: LifeBuoy,
  interaction: MessageSquare,
  bill: FileText,
  expense: Receipt,
  // Types additionnels pour le fil « Récemment consultés ».
  facture: FileText,
  purchase: Boxes,
  return: RotateCcw,
  shipment: Truck,
  sale_receipt: Receipt,
  employee: UserRound,
  vendor_profile: BookUser,
  vendor_subscription: RefreshCw,
}

const TYPE_LABEL = {
  company: 'Entreprise',
  contact: 'Contact',
  project: 'Projet',
  order: 'Commande',
  product: 'Produit',
  serial: 'N° de série',
  ticket: 'Ticket',
  interaction: 'Interaction',
  bill: 'Facture fourn.',
  expense: 'Dépense',
  facture: 'Facture',
  purchase: 'Achat',
  return: 'Retour',
  shipment: 'Envoi',
  sale_receipt: 'Reçu de vente',
  employee: 'Employé',
  vendor_profile: 'Fournisseur',
  vendor_subscription: 'Abonnement fourn.',
}

// Commandes slash — restreignent la recherche à un seul type de record, sans le
// bruit des pages/autres records (ex. `/fournisseur acme`, `/abonnements twilio`).
// Le nom peut être singulier ou pluriel ; le texte après l'espace filtre la liste.
const SLASH_COMMANDS = [
  { re: /^\/(fournisseurs?)\b\s*(.*)$/i, type: 'vendor_profile', label: 'Fournisseurs' },
  { re: /^\/(abonnements?)\b\s*(.*)$/i, type: 'vendor_subscription', label: 'Abonnements fournisseurs' },
]

function parseSlashCommand(raw) {
  const q = raw.trim()
  for (const c of SLASH_COMMANDS) {
    const m = q.match(c.re)
    if (m) return { type: c.type, label: c.label, filterText: (m[2] || '').trim() }
  }
  return null
}

// Liste à plat de toutes les pages navigables, dérivée de la même définition de
// nav que la sidebar (navItems.js). Construite une seule fois au chargement du
// module. Les liens externes (`external`) sont exclus — la palette ne fait que
// du routage interne.
const PAGE_ITEMS = (() => {
  const pages = []
  // Une entrée à sous-menu flottant (Espace finance) n'est pas navigable
  // elle-même : ce sont ses sections qui le sont, sous son propre libellé.
  const push = (item, group) => {
    if (item.flyoutGroups) {
      for (const sub of item.flyoutGroups) {
        for (const s of sub.items) {
          pages.push({ to: s.to, label: s.label, icon: s.icon, group: item.label })
        }
      }
    } else if (item.to) {
      pages.push({ to: item.to, label: item.label, icon: item.icon, group })
    }
  }
  for (const item of defaultNavItems) {
    if (item.external) continue
    if (item.group) for (const sub of item.items) push(sub, item.group)
    else push(item, null)
  }
  return pages
})()

// Normalisation insensible à la casse et aux accents pour le filtrage des pages.
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

const MAX_PAGE_MATCHES = 12

function matchPages(query) {
  const q = norm(query.trim())
  if (!q) return PAGE_ITEMS // requête vide → palette de lancement : toutes les pages
  return PAGE_ITEMS
    .filter(p => norm(p.label).includes(q) || (p.group && norm(p.group).includes(q)))
    .slice(0, MAX_PAGE_MATCHES)
}

const MAX_COMMAND_MATCHES = 20

export function GlobalSearch({ open, onClose }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(0)
  const inputRef = useRef(null)
  const navigate = useNavigate()
  const timerRef = useRef(null)
  const recent = useRecentRecords()
  // Caches des commandes slash (`/fournisseur`, `/abonnement`) — chargées une
  // fois par ouverture de palette, puis filtrées localement à chaque frappe.
  const vendorProfilesCacheRef = useRef(null)
  const vendorSubsCacheRef = useRef(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setResults([])
      setSelected(0)
      vendorProfilesCacheRef.current = null
      vendorSubsCacheRef.current = null
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const search = useCallback(async (q) => {
    if (q.length < 2) { setResults([]); return }
    setLoading(true)
    try {
      const { results: res } = await api.search.query(q)
      setResults(res || [])
    } finally {
      setLoading(false)
    }
  }, [])

  const loadVendorProfiles = useCallback(async () => {
    if (!vendorProfilesCacheRef.current) {
      const r = await api.vendorProfiles.list()
      vendorProfilesCacheRef.current = (r.data || []).map(p => ({
        type: 'vendor_profile', id: p.id, label: p.name, sub: p.qb_category || '',
        url: `/fournisseurs?open=${p.id}`,
      }))
    }
    return vendorProfilesCacheRef.current
  }, [])

  const loadVendorSubscriptions = useCallback(async () => {
    if (!vendorSubsCacheRef.current) {
      const rows = await api.vendorSubscriptions.list()
      vendorSubsCacheRef.current = (rows || []).map(s => ({
        type: 'vendor_subscription', id: s.id, label: s.vendor, sub: s.plan || '',
        url: `/fournisseurs/abonnements?open=${s.id}`,
      }))
    }
    return vendorSubsCacheRef.current
  }, [])

  function filterCommandList(list, text) {
    if (!text) return list.slice(0, MAX_COMMAND_MATCHES)
    const t = norm(text)
    return list
      .filter(item => norm(item.label).includes(t) || norm(item.sub).includes(t))
      .slice(0, MAX_COMMAND_MATCHES)
  }

  function runCommandSearch(cmd) {
    setLoading(true)
    const loader = cmd.type === 'vendor_profile' ? loadVendorProfiles : loadVendorSubscriptions
    loader()
      .then(list => setResults(filterCommandList(list, cmd.filterText)))
      .finally(() => setLoading(false))
  }

  function handleChange(e) {
    const q = e.target.value
    setQuery(q)
    setSelected(0)
    clearTimeout(timerRef.current)
    const cmd = parseSlashCommand(q)
    if (cmd) { runCommandSearch(cmd); return }
    timerRef.current = setTimeout(() => search(q), 220)
  }

  // En mode commande slash, la palette ne montre que les records du type ciblé —
  // pas de pages ni de récents, pour éviter le bruit dont voulait se débarrasser
  // l'utilisateur.
  const command = parseSlashCommand(query)

  // Liste combinée récents + pages + records, dans l'ordre d'affichage, pour la
  // navigation clavier (un seul index `selected` couvre toutes les sections).
  // Le fil « Récemment consultés » n'apparaît que lorsque la requête est vide.
  const queryEmpty = query.trim() === ''
  const recentItems = (queryEmpty && !command) ? recent.map(r => ({ ...r, kind: 'record' })) : []
  const pageMatches = command ? [] : matchPages(query)
  const pageItems = pageMatches.map(p => ({ ...p, kind: 'page' }))
  const recordItems = results.map(r => ({ ...r, kind: 'record' }))
  const allItems = [...recentItems, ...pageItems, ...recordItems]
  const resultsLabel = command ? command.label : 'Résultats'

  function go(item) {
    if (!item) return
    navigate(item.kind === 'page' ? item.to : item.url)
    onClose()
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, allItems.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)) }
    if (e.key === 'Enter') { e.preventDefault(); go(allItems[selected]) }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-xl bg-white rounded-xl shadow-2xl overflow-hidden">
        {/* Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200">
          <Search size={18} className="text-slate-400 flex-shrink-0" />
          <input
            ref={inputRef}
            data-testid="global-search-input"
            value={query}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            className="flex-1 text-sm outline-none text-slate-900 placeholder-slate-400"
          />
          {loading && (
            <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
          )}
          {!loading && query && (
            <button onClick={() => { setQuery(''); setResults([]); setSelected(0) }} className="text-slate-400 hover:text-slate-600">
              <X size={14} />
            </button>
          )}
          <kbd className="hidden sm:inline text-xs text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">Esc</kbd>
        </div>

        {/* Results */}
        {allItems.length > 0 && (
          <ul className="max-h-80 overflow-y-auto py-1">
            {recentItems.length > 0 && (
              <li className="flex items-center justify-between px-4 pt-2 pb-1 select-none">
                <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  <Clock size={12} /> Récemment consultés
                </span>
                <button
                  data-testid="global-search-clear-recent"
                  className="text-[11px] font-medium text-slate-400 hover:text-slate-600 normal-case tracking-normal"
                  onClick={(e) => { e.stopPropagation(); clearRecentRecords() }}
                >
                  Effacer
                </button>
              </li>
            )}
            {recentItems.map((r, i) => {
              const Icon = TYPE_ICON[r.type] || Clock
              const idx = i
              return (
                <li key={`recent-${r.url}`}>
                  <button
                    data-testid={`global-search-recent-${r.url}`}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${idx === selected ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
                    onClick={() => go(r)}
                    onMouseEnter={() => setSelected(idx)}
                  >
                    <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
                      <Icon size={14} className="text-slate-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{r.label}</div>
                      {r.sub && <div className="text-xs text-slate-400 truncate">{r.sub}</div>}
                    </div>
                    <span className="text-xs text-slate-400 flex-shrink-0">{TYPE_LABEL[r.type] || ''}</span>
                  </button>
                </li>
              )
            })}

            {pageItems.length > 0 && (
              <li className="px-4 pt-2 pb-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider select-none">Aller à</li>
            )}
            {pageItems.map((p, i) => {
              const Icon = p.icon || Search
              const idx = recentItems.length + i
              return (
                <li key={`page-${p.to}`}>
                  <button
                    data-testid={`global-search-page-${p.to}`}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${idx === selected ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
                    onClick={() => go(p)}
                    onMouseEnter={() => setSelected(idx)}
                  >
                    <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
                      <Icon size={14} className="text-slate-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{p.label}</div>
                      {p.group && <div className="text-xs text-slate-400 truncate">{p.group}</div>}
                    </div>
                    {idx === selected
                      ? <CornerDownLeft size={13} className="text-slate-400 flex-shrink-0" />
                      : <span className="text-xs text-slate-400 flex-shrink-0">Page</span>}
                  </button>
                </li>
              )
            })}

            {recordItems.length > 0 && (
              <li className="px-4 pt-2 pb-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider select-none">{resultsLabel}</li>
            )}
            {recordItems.map((r, i) => {
              const Icon = TYPE_ICON[r.type] || Search
              const idx = recentItems.length + pageItems.length + i
              return (
                <li key={`${r.type}-${r.id}`}>
                  <button
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${idx === selected ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
                    onClick={() => go(r)}
                    onMouseEnter={() => setSelected(idx)}
                  >
                    <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
                      <Icon size={14} className="text-slate-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{r.label}</div>
                      {r.sub && <div className="text-xs text-slate-400 truncate">{r.sub}</div>}
                    </div>
                    <span className="text-xs text-slate-400 flex-shrink-0">{TYPE_LABEL[r.type]}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {(command || query.length >= 2) && !loading && allItems.length === 0 && (
          <div className="py-10 text-center text-slate-400 text-sm">
            {command ? `Aucun résultat dans « ${command.label} »` : `Aucun résultat pour « ${query} »`}
          </div>
        )}
      </div>
    </div>
  )
}
