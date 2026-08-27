import { useState, useEffect, useRef, useLayoutEffect, useMemo, createContext, useContext } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  Settings,
  ChevronRight, ChevronDown, LogOut, Menu, X,
  Search, ExternalLink, Sparkles, Bot,
  PanelLeftClose, PanelLeftOpen, GripVertical,
} from 'lucide-react'
import { useAuth } from '../lib/auth.jsx'
import { useNavPrefs } from '../lib/navPrefs.jsx'
import { defaultNavItems, applyNavOrder, navKey } from '../lib/navItems.js'
import { getSubsections, resolveSubsections } from '../lib/navSubsections.js'
import { NAV_TAB_CLAIMS } from '../lib/financeSections.js'
import { api } from '../lib/api.js'
import { prefetch } from '../lib/prefetch.js'
import { connect as realtimeConnect, disconnect as realtimeDisconnect } from '../lib/realtime.js'
import { hasUnseenChangelog, CHANGELOG_SEEN_EVENT } from '../lib/changelog.js'
import { Modal } from './Modal.jsx'
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal.jsx'
import { GlobalSearch as CRMSearch } from './GlobalSearch.jsx'
import { FeedbackFab } from './FeedbackFab.jsx'
import ThemeToggle from './ThemeToggle.jsx'
import { TravauxQuickButton } from './TravauxQuickPanel.jsx'

// Raccourcis clavier de navigation globaux — source unique de vérité.
// Le handler clavier de Layout construit sa table de routage à partir d'ici,
// et la modale d'aide (« ? ») les liste pour les rendre découvrables. Ajouter
// un raccourci = ajouter une entrée ici (et rien d'autre).
export const NAV_SHORTCUTS = [
  { key: 'd', label: 'Tableau de bord', to: '/dashboard' },
  { key: 't', label: 'Feuille de temps', to: '/feuille-de-temps' },
  { key: 'b', label: 'Tickets', to: '/tickets' },
  { key: 'p', label: 'Pipeline', to: '/pipeline' },
  { key: 'c', label: 'Commandes', to: '/orders' },
]

// When the user hovers a nav link, kick off the page's primary list fetch.
// The request-level cache in prefetch.js keeps the in-flight promise, so the
// fetch fired on page mount (the real <NavLink> click) reuses it instead of
// re-hitting the server. Each entry mirrors the exact args the target page
// passes to its first api.*.list(...) call — ordering matters for the
// cache key (URLSearchParams preserves insertion order).
// Note : les pages qui lisent depuis le cache global (`useTable` hydraté par
// /api/bootstrap) ne sont pas listées ici — leur prefetch serait gaspillé.
// Pages cachées actuellement : /contacts, /products, /orders, /tickets,
// /tasks, /retours, /purchases, /items-vendus.
const NAV_PREFETCH = {
  '/interactions':  () => api.interactions.list({ limit: 'all', offset: 0 }),
  '/companies':     () => api.companies.list({ limit: 'all', page: 1 }),
  '/factures':      () => api.factures.list({ limit: 'all', page: 1 }),
  '/abonnements':   () => api.abonnements.list({ limit: 'all', page: 1 }),
  '/abonnements/mouvements': () => api.abonnements.events({ limit: 'all', page: 1 }),
  '/discovery-forms': () => api.discoveryForms.list({ limit: 'all' }),
}

// Short delay so sweeping the mouse across the sidebar doesn't trigger a
// dozen fetches — only hovers that last this long count as intent.
const PREFETCH_DELAY_MS = 120

function useHoverPrefetch(to) {
  const timerRef = useRef(null)
  const firedRef = useRef(false)
  const getter = NAV_PREFETCH[to]
  const onEnter = () => {
    if (!getter || firedRef.current) return
    timerRef.current = setTimeout(() => {
      firedRef.current = true
      prefetch(getter)
    }, PREFETCH_DELAY_MS)
  }
  const onLeave = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
  }
  return { onMouseEnter: onEnter, onMouseLeave: onLeave }
}

// `compact` : dimensions des sous-items d'un groupe (vs ligne pleine hauteur).
function NavItem({ to, href, external, icon: Icon, label, compact = false }) {
  const hover = useHoverPrefetch(to)
  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="nav-external"
        className={`flex items-center text-sm font-medium transition-all
          text-slate-600 hover:text-slate-900 hover:bg-slate-100
          ${compact ? 'gap-2.5 px-3 py-1.5 rounded-md' : 'gap-3 px-3 py-2 rounded-lg'}`}
      >
        <Icon size={compact ? 14 : 16} className="flex-shrink-0" />
        <span className="flex-1">{label}</span>
        <ExternalLink size={12} className="flex-shrink-0 text-slate-400" />
      </a>
    )
  }
  return (
    <NavLink
      to={to}
      {...hover}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all
        ${isActive
          ? 'bg-brand-600 text-white shadow-sm'
          : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
        }`
      }
    >
      <Icon size={16} className="flex-shrink-0" />
      <span className="flex-1">{label}</span>
    </NavLink>
  )
}

// ── Chaîne de survol des panneaux flottants ─────────────────────────────────
// Un panneau se ferme quand la souris le quitte. Avec des sous-menus imbriqués,
// entrer dans l'enfant, c'est quitter le parent : sans coordination, le parent
// se fermerait et emporterait l'enfant. Chaque panneau ouvert s'annonce donc à
// son parent, qui compte les rectangles de ses descendants comme « dedans ».
const FlyoutChainContext = createContext(null)

function useFlyoutChain(panelRef, open) {
  const parent = useContext(FlyoutChainContext)
  const childRectsRef = useRef(new Set())
  const chain = useMemo(() => ({
    add: (fn) => childRectsRef.current.add(fn),
    remove: (fn) => childRectsRef.current.delete(fn),
  }), [])

  useEffect(() => {
    if (!parent || !open) return
    const getRect = () => panelRef.current?.getBoundingClientRect()
    parent.add(getRect)
    return () => parent.remove(getRect)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parent, open])

  const childRects = () => [...childRectsRef.current].map(fn => fn()).filter(Boolean)
  return { chain, childRects }
}

// Position d'un panneau à droite de son déclencheur : remonté s'il déborderait
// en bas, rabattu à gauche s'il déborderait à droite (tiroir mobile, sous-menu
// de sous-menu).
function useFlyoutPosition(triggerRef, panelRef, open) {
  const [pos, setPos] = useState(null)

  const seed = () => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.top, left: r.right + 4 })
  }

  useLayoutEffect(() => {
    if (!open) return
    const t = triggerRef.current?.getBoundingClientRect()
    const p = panelRef.current
    if (!t || !p) return
    const { offsetWidth: w, offsetHeight: h } = p
    setPos({
      top: Math.max(8, Math.min(t.top, window.innerHeight - h - 8)),
      left: t.right + w + 8 > window.innerWidth ? Math.max(8, t.left - w - 4) : t.right + 4,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return [pos, seed]
}

// Fermeture au survol sortant (sauf si épinglé au clic), Échap et clic dehors.
function useFlyoutDismiss({ open, pinned, triggerRef, panelRef, childRects, close }) {
  useEffect(() => {
    if (!open || pinned) return
    let closeTimer = null
    function onMove(e) {
      const inside = (r) => r && e.clientX >= r.left - 4 && e.clientX <= r.right + 4 && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4
      const hit = inside(triggerRef.current?.getBoundingClientRect())
        || inside(panelRef.current?.getBoundingClientRect())
        || childRects().some(inside)
      if (hit) {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
      } else if (!closeTimer) {
        closeTimer = setTimeout(close, 150)
      }
    }
    document.addEventListener('mousemove', onMove)
    return () => {
      document.removeEventListener('mousemove', onMove)
      if (closeTimer) clearTimeout(closeTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pinned])

  useEffect(() => {
    if (!open) return
    function onKey(e) { if (e.key === 'Escape') close() }
    function onDown(e) {
      if (panelRef.current?.contains(e.target) || triggerRef.current?.contains(e.target)) return
      close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
}

/**
 * Ligne de menu d'une page, avec au survol le sous-menu de ses propres
 * sections (onglets de la page, vues d'un tableau, comptes du rapprochement).
 * La ligne reste un lien : un clic ouvre la page telle quelle, le sous-menu
 * n'est qu'un raccourci vers une section précise.
 *
 * `variant` :
 *   - 'flyout'  : dans un panneau flottant
 *   - 'group'   : sous-item compact d'un groupe de la sidebar
 *   - 'bottom'  : ligne pleine hauteur (bas de la sidebar)
 */
// Une entrée peut viser un onglet précis d'une page (`?onglet=`). L'état actif
// de react-router ne regarde que le chemin : sans ça, « Comptes prépayés » et
// « Douanes (ASFC) » s'allumeraient ensemble. L'entrée sans onglet reste active
// pour tous les onglets qu'aucune autre entrée ne revendique.
function tabAwareActive(to, location, isActive) {
  const [path, query] = String(to || '').split('?')
  const claims = NAV_TAB_CLAIMS[path]
  if (!claims) return isActive
  const itemTab = new URLSearchParams(query || '').get('onglet')
  const currentTab = new URLSearchParams(location.search).get('onglet')
  if (itemTab) return location.pathname === path && currentTab === itemTab
  return isActive && !claims.includes(currentTab)
}

function NavRow({ item, variant }) {
  const hover = useHoverPrefetch(item.to)
  const [items, setItems] = useState(null)
  const [open, setOpen] = useState(false)
  const rowRef = useRef(null)
  const panelRef = useRef(null)
  const location = useLocation()
  const { chain, childRects } = useFlyoutChain(panelRef, open)
  const [pos, seedPos] = useFlyoutPosition(rowRef, panelRef, open)
  const hasSubsections = !!getSubsections(item.to)

  useFlyoutDismiss({ open, pinned: false, triggerRef: rowRef, panelRef, childRects, close: () => setOpen(false) })
  useEffect(() => { setOpen(false) }, [location.pathname, location.search])

  const pendingRef = useRef(false)
  function onEnter() {
    hover.onMouseEnter?.()
    if (!hasSubsections) return
    seedPos()
    if (items) { setOpen(true); return }
    if (pendingRef.current) return
    pendingRef.current = true
    resolveSubsections(item.to).then(list => {
      pendingRef.current = false
      setItems(list)
      if (list.length) setOpen(true)
    })
  }

  const inFlyout = variant === 'flyout'
  // 'bottom' : mêmes dimensions que les NavItem pleine hauteur, pour que la
  // ligne porte un sous-menu au survol sans détonner visuellement.
  const inBottom = variant === 'bottom'
  const cls = ({ isActive: routerActive }) => {
    const isActive = tabAwareActive(item.to, location, routerActive)
    return inBottom
      ? `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all
         ${isActive ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'}`
      : `flex items-center gap-2.5 rounded-md text-sm font-medium transition-colors
     ${inFlyout ? 'px-3 py-2 mx-1' : 'px-3 py-1.5'}
     ${isActive
        ? 'bg-brand-600 text-white'
        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'}`
  }

  return (
    <>
      <NavLink
        to={item.to}
        ref={rowRef}
        end={item.exactActive}
        onMouseEnter={onEnter}
        // Filet de sécurité : pendant que la colonne finit de se mettre en
        // page, un mousemove synthétique peut refermer le panneau sans que
        // mouseenter ne se re-déclenche (la bordure n'est jamais re-croisée).
        // Tout mouvement au-dessus de la ligne rouvre donc le sous-menu.
        onMouseMove={() => { if (hasSubsections && !open) onEnter() }}
        onMouseLeave={hover.onMouseLeave}
        className={cls}
      >
        <item.icon size={inBottom ? 16 : inFlyout ? 15 : 14} className="flex-shrink-0" />
        <span className="flex-1">{item.label}</span>
        {hasSubsections && <ChevronRight size={11} className="flex-shrink-0 opacity-50" />}
      </NavLink>

      {open && items?.length > 0 && (
        <FlyoutChainContext.Provider value={chain}>
          <div
            ref={panelRef}
            role="menu"
            aria-label={item.label}
            data-testid="nav-subsection-panel"
            data-nav-flyout=""
            data-route={item.to}
            className="fixed bg-white rounded-xl shadow-xl border border-slate-200 py-1.5 min-w-52 max-w-72 z-[210] overflow-y-auto"
            style={pos
              ? { top: pos.top, left: pos.left, maxHeight: `calc(100vh - ${pos.top + 8}px)` }
              : { top: 0, left: 0, visibility: 'hidden' }}
          >
            <p className="px-3 pb-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider truncate">
              {item.label}
            </p>
            {items.map(sub => (
              <NavLink
                key={sub.to}
                to={sub.to}
                className={`flex items-center gap-2 px-3 py-1.5 mx-1 rounded-md text-sm transition-colors ${
                  location.pathname + location.search === sub.to
                    ? 'bg-brand-600 text-white font-medium'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                <span className="truncate">{sub.label}</span>
              </NavLink>
            ))}
          </div>
        </FlyoutChainContext.Provider>
      )}
    </>
  )
}

function FlyoutNavLink({ item }) {
  return <NavRow item={item} variant="flyout" />
}

function GroupNavLink({ item }) {
  return <NavRow item={item} variant="group" />
}

// Routes couvertes par une entrée de nav. Une entrée à sous-menu flottant
// (`flyoutGroups`, ex. Espace finance) n'a pas de page à elle : elle compte
// comme active — et rend son groupe parent actif — dès qu'on est sur l'une de
// ses sections. Sans ça, le groupe Comptabilité resterait replié et éteint
// pendant qu'on travaille dans l'Espace finance.
function navItemPaths(item) {
  if (item.flyoutGroups) return item.flyoutGroups.flatMap(g => g.items.map(s => s.to))
  return [item.to]
}

function navItemMatches(pathname, item) {
  return navItemPaths(item).some(to => to && (pathname === to || pathname.startsWith(to + '/')))
}

/**
 * Entrée de menu qui déploie ses sections dans un panneau flottant au survol —
 * un survol puis un clic mènent directement à la page, en pleine largeur.
 * Utilisée par l'Espace finance (sections regroupées par famille), en
 * sous-section du groupe Comptabilité.
 *
 * Le clic sur la ligne épingle le panneau (ouvert jusqu'à Échap / clic
 * ailleurs) : c'est le seul chemin possible au doigt, où il n'y a pas de survol.
 */
function NavFlyoutItem({ icon: Icon, label, groups }) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const location = useLocation()
  const { chain, childRects } = useFlyoutChain(panelRef, open)
  const [pos, seedPos] = useFlyoutPosition(triggerRef, panelRef, open)

  const isActive = navItemMatches(location.pathname, { flyoutGroups: groups })

  function openMenu() {
    seedPos()
    setOpen(true)
  }

  const close = () => { setOpen(false); setPinned(false) }
  useFlyoutDismiss({ open, pinned, triggerRef, panelRef, childRects, close })

  // Un clic sur une section referme le menu.
  useEffect(() => { close() }, [location.pathname, location.search])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onMouseEnter={openMenu}
        onMouseMove={() => { if (!open) openMenu() }}
        onFocus={openMenu}
        onClick={() => {
          // Au doigt il n'y a pas de survol : le tap ouvre puis referme.
          if (open && pinned) { setOpen(false); setPinned(false); return }
          if (!open) openMenu()
          setPinned(true)
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="nav-flyout-trigger"
        className={`flex items-center w-full gap-2.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all
          ${isActive ? 'bg-brand-600 text-white' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'}`}
      >
        <Icon size={14} className="flex-shrink-0" />
        <span className="flex-1 text-left">{label}</span>
        <ChevronRight size={11} className={`flex-shrink-0 ${isActive ? 'text-brand-200' : 'text-slate-400'}`} />
      </button>

      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label={label}
          data-testid="nav-flyout-panel"
          data-nav-flyout=""
          className="fixed bg-white rounded-xl shadow-xl border border-slate-200 py-2 min-w-56 z-[200] overflow-y-auto"
          style={pos
            ? { top: pos.top, left: pos.left, maxHeight: `calc(100vh - ${pos.top + 8}px)` }
            : { top: 0, left: 0, visibility: 'hidden' }}
        >
          <FlyoutChainContext.Provider value={chain}>
            {groups.map((group, gi) => (
              <div key={group.label} className={gi > 0 ? 'mt-1.5 pt-1.5 border-t border-slate-100' : ''}>
                <p className="px-3 pb-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                  {group.label}
                </p>
                {group.items.map(item => (
                  <FlyoutNavLink key={item.to} item={item} />
                ))}
              </div>
            ))}
          </FlyoutChainContext.Provider>
        </div>
      )}
    </>
  )
}

// ── Réordonnancement du menu ────────────────────────────────────────────────
// Sections et sous-sections se déplacent au glisser-déposer, mais uniquement
// depuis une petite poignée qui n'apparaît qu'au survol de la ligne : impossible
// de déplacer une entrée par accident en cliquant un lien, un geste suffit
// quand on le veut. L'ordre est une préférence par utilisateur (nav_order),
// sauvegardée automatiquement.
const NavReorderContext = createContext(null)

function NavReorderProvider({ items, order, setOrder, children }) {
  const [drag, setDrag] = useState(null) // { container, key, targetKey, before }
  const stateRef = useRef(null)

  const start = (container, key, e) => {
    e.preventDefault()
    const next = { container, key, targetKey: null, before: true }
    stateRef.current = next
    setDrag(next)
  }

  // Déplace `key` avant/après `targetKey` dans son conteneur. On raisonne sur la
  // liste NON filtrée : sinon les entrées cachées par l'utilisateur tomberaient
  // silencieusement à la fin de l'ordre enregistré.
  const commit = (cur) => {
    const list = cur.container === 'root'
      ? items
      : (items.find(i => navKey(i) === cur.container)?.items || [])
    const keys = list.map(navKey)
    if (!keys.includes(cur.key) || !keys.includes(cur.targetKey)) return
    const next = keys.filter(k => k !== cur.key)
    const at = next.indexOf(cur.targetKey) + (cur.before ? 0 : 1)
    next.splice(at, 0, cur.key)
    if (next.join('\u0000') === keys.join('\u0000')) return
    setOrder({ ...order, [cur.container]: next })
  }

  useEffect(() => {
    if (!drag) return
    const prevSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'

    function onMove(e) {
      const cur = stateRef.current
      if (!cur) return
      const row = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-nav-sortable]')
      let targetKey = null
      let before = true
      if (row && row.dataset.navContainer === cur.container) {
        const r = row.getBoundingClientRect()
        targetKey = row.dataset.navSortable
        before = e.clientY < r.top + r.height / 2
      }
      if (targetKey === cur.targetKey && before === cur.before) return
      const next = { ...cur, targetKey, before }
      stateRef.current = next
      setDrag(next)
    }
    function finish(apply) {
      const cur = stateRef.current
      stateRef.current = null
      setDrag(null)
      if (apply && cur?.targetKey && cur.targetKey !== cur.key) commit(cur)
    }
    const onUp = () => finish(true)
    const onKey = (e) => { if (e.key === 'Escape') finish(false) }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey)
      document.body.style.userSelect = prevSelect
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, items, order])

  const value = useMemo(() => ({ drag, start }), [drag])
  return <NavReorderContext.Provider value={value}>{children}</NavReorderContext.Provider>
}

// Enveloppe une ligne de menu : poignée de glissement + trait d'insertion.
function NavSortable({ container, itemKey, children }) {
  const ctx = useContext(NavReorderContext)
  if (!ctx || !itemKey) return children
  const { drag, start } = ctx
  const dragging = drag?.container === container && drag.key === itemKey
  const isTarget = drag?.container === container && drag.targetKey === itemKey && drag.key !== itemKey

  return (
    <div
      data-nav-sortable={itemKey}
      data-nav-container={container}
      className={`relative group/sortable ${dragging ? 'opacity-40' : ''}`}
    >
      {children}
      {/* Poignée et trait d'insertion rendus APRÈS la ligne : ils sont
          positionnés en absolu, et la ligne reste le premier enfant du
          conteneur (des tests et des styles s'appuient sur cet ordre). */}
      <span
        role="button"
        aria-label="Déplacer"
        title="Glisser pour réordonner"
        data-testid={`nav-drag-${itemKey}`}
        onPointerDown={(e) => { if (e.button === 0) start(container, itemKey, e) }}
        className={`absolute left-0 top-1/2 -translate-y-1/2 z-20 flex items-center justify-center w-3 h-5
          text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing transition-opacity
          ${drag ? 'opacity-100' : 'opacity-0 group-hover/sortable:opacity-100'}`}
      >
        <GripVertical size={11} />
      </span>
      {isTarget && (
        <span
          data-testid="nav-drop-indicator"
          className={`pointer-events-none absolute left-1 right-1 h-0.5 bg-brand-500 rounded-full z-20 ${drag.before ? '-top-0.5' : '-bottom-0.5'}`}
        />
      )}
    </div>
  )
}

function NavGroup({ group, icon: Icon, items }) {
  const location = useLocation()
  const isActive = items.some(item => navItemMatches(location.pathname, item))

  const storageKey = `erp.navgroup.${group}`
  const [open, setOpen] = useState(() => {
    if (typeof window === 'undefined') return isActive
    const stored = window.localStorage.getItem(storageKey)
    if (stored === '1') return true
    if (stored === '0') return false
    return isActive
  })

  useEffect(() => {
    if (isActive && !open) setOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive])

  function toggle() {
    setOpen(prev => {
      const next = !prev
      try { window.localStorage.setItem(storageKey, next ? '1' : '0') } catch {}
      return next
    })
  }

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium w-full transition-all
          ${isActive ? 'bg-brand-600 text-white' : 'text-slate-700 hover:text-slate-900 hover:bg-slate-100'}`}
      >
        <Icon size={16} className="flex-shrink-0" />
        <span className="flex-1 text-left">{group}</span>
        <ChevronDown
          size={12}
          className={`flex-shrink-0 transition-transform duration-150 ${open ? '' : '-rotate-90'} ${isActive ? 'text-brand-200' : 'text-slate-400'}`}
        />
      </button>

      {open && (
        <div className="mt-0.5 ml-4 pl-2 border-l border-slate-200 space-y-0.5">
          {items.map(item => (
            <NavSortable key={item.to || item.href} container={`group:${group}`} itemKey={item.to || item.href}>
              {item.flyoutGroups
                ? <NavFlyoutItem {...item} groups={item.flyoutGroups} />
                : item.external
                  // Lien externe (ex. Admin Chatbot) : un vrai <a target="_blank">,
                  // pas un NavLink de routeur — `to` n'existe pas ici.
                  ? <NavItem {...item} compact />
                  : <GroupNavLink item={item} />}
            </NavSortable>
          ))}
        </div>
      )}
    </div>
  )
}

// Ligne de compte en bas de la sidebar : avatar + nom, menu au survol
// (Nouveautés, Paramètres perso, Déconnexion) qui s'ouvre au-dessus.
function UserAvatarMenu({ user, roleLabel, onLogout, hasUnseenNews }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const triggerRef = useRef(null)
  const flyoutRef = useRef(null)

  const parts = (user?.name || '').trim().split(/\s+/)
  const firstInitial = parts[0]?.[0]?.toUpperCase() || 'U'
  const lastInitial = parts.length > 1 ? parts[parts.length - 1][0].toUpperCase() : ''
  const initials = firstInitial + lastInitial

  function openMenu() {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setPos({ bottom: window.innerHeight - rect.top + 6, left: rect.left })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    let closeTimer = null
    function onMove(e) {
      const tRect = triggerRef.current?.getBoundingClientRect()
      const fRect = flyoutRef.current?.getBoundingClientRect()
      const inside = (r) => r && e.clientX >= r.left - 4 && e.clientX <= r.right + 4 && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4
      if (inside(tRect) || inside(fRect)) {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
      } else if (!closeTimer) {
        closeTimer = setTimeout(() => setOpen(false), 150)
      }
    }
    document.addEventListener('mousemove', onMove)
    return () => {
      document.removeEventListener('mousemove', onMove)
      if (closeTimer) clearTimeout(closeTimer)
    }
  }, [open])

  return (
    <>
      <div
        ref={triggerRef}
        data-testid="user-avatar-trigger"
        onMouseEnter={openMenu}
        className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-slate-100 transition-colors"
      >
        <div className="relative w-7 h-7 flex-shrink-0 bg-gradient-to-br from-brand-500 to-emerald-700 rounded-full flex items-center justify-center">
          <span className="text-white text-[11px] font-semibold tracking-tight">{initials}</span>
          {hasUnseenNews && (
            <span
              data-testid="changelog-badge"
              className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-amber-400 rounded-full ring-2 ring-white"
              title="Nouveautés disponibles"
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-slate-700 truncate">{user?.name}</div>
        </div>
      </div>

      {open && pos && (
        <div
          ref={flyoutRef}
          className="fixed bg-white rounded-xl shadow-xl border border-slate-200 py-2 min-w-56 z-[200]"
          style={pos}
        >
          <div className="px-3 py-2 border-b border-slate-100">
            <div className="text-slate-800 text-sm font-medium truncate">{user?.name}</div>
            <div className="text-slate-500 text-xs mt-0.5">{roleLabel[user?.role] || user?.role}</div>
          </div>
          <NavLink
            to="/changelog"
            data-testid="user-menu-changelog"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 w-full px-3 py-2 mt-1 mx-1 rounded-md text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors"
            style={{ width: 'calc(100% - 0.5rem)' }}
          >
            <Sparkles size={14} />
            <span className="flex-1 text-left">Nouveautés</span>
            {hasUnseenNews && <span className="w-2 h-2 bg-amber-400 rounded-full" />}
          </NavLink>
          <NavLink
            to="/settings"
            data-testid="user-menu-settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 w-full px-3 py-2 mx-1 rounded-md text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors"
            style={{ width: 'calc(100% - 0.5rem)' }}
          >
            <Settings size={14} />
            Paramètres
          </NavLink>
          <button
            onClick={onLogout}
            className="flex items-center gap-2.5 w-full px-3 py-2 mx-1 rounded-md text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors"
            style={{ width: 'calc(100% - 0.5rem)' }}
          >
            <LogOut size={14} />
            Déconnexion
          </button>
        </div>
      )}
    </>
  )
}

function ChangePasswordModal({ onClose }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    if (form.next.length < 8) return setError('Minimum 8 caractères')
    if (form.next !== form.confirm) return setError('Les mots de passe ne correspondent pas')
    setSaving(true)
    setError('')
    try {
      await api.auth.changePassword(form.current, form.next)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Mot de passe actuel</label>
        <input type="password" value={form.current} onChange={e => setForm(f => ({ ...f, current: e.target.value }))} className="input" required />
      </div>
      <div>
        <label className="label">Nouveau mot de passe</label>
        <input type="password" value={form.next} onChange={e => setForm(f => ({ ...f, next: e.target.value }))} className="input" placeholder="Minimum 8 caractères" required />
      </div>
      <div>
        <label className="label">Confirmer</label>
        <input type="password" value={form.confirm} onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))} className="input" required />
      </div>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Enregistrement...' : 'Changer le mot de passe'}</button>
      </div>
    </form>
  )
}

export function Layout({ children }) {
  const navigate = useNavigate()
  // Sidebar façon Claude : repliable en un mince rail (logo, réouverture,
  // recherche). L'état survit aux rechargements.
  const [collapsed, setCollapsed] = useState(() => {
    try { return window.localStorage.getItem('erp.sidebar.collapsed') === '1' } catch { return false }
  })
  // Menu replié : le survol du rail le rouvre en surimpression (façon Claude),
  // et il se referme dès que la souris le quitte. Rien n'est persisté — c'est un
  // coup d'œil, pas un changement d'état.
  const [peek, setPeek] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [showChangePw, setShowChangePw] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const { user, logout } = useAuth()
  const { isHidden, order, setOrder } = useNavPrefs()
  const [hasUnseenNews, setHasUnseenNews] = useState(() => hasUnseenChangelog())
  const location = useLocation()
  const railRef = useRef(null)
  const peekRef = useRef(null)
  const peekArmRef = useRef(null)

  function setSidebarCollapsed(next) {
    try { window.localStorage.setItem('erp.sidebar.collapsed', next ? '1' : '0') } catch {}
    setCollapsed(next)
    if (!next) setPeek(false)
  }

  function toggleSidebar() {
    setSidebarCollapsed(!collapsed)
  }

  // Court délai d'intention : balayer l'écran de gauche à droite ne doit pas
  // faire jaillir le menu.
  function armPeek() {
    if (peek || peekArmRef.current) return
    peekArmRef.current = setTimeout(() => { peekArmRef.current = null; setPeek(true) }, 90)
  }
  function cancelPeekArm() {
    if (peekArmRef.current) { clearTimeout(peekArmRef.current); peekArmRef.current = null }
  }

  // Fermeture du coup d'œil : la souris doit avoir quitté le panneau, le rail ET
  // les sous-menus flottants (qui vivent hors du panneau, en position fixe).
  useEffect(() => {
    if (!peek) return
    let closeTimer = null
    const inside = (e, r) => r && e.clientX >= r.left - 4 && e.clientX <= r.right + 4 && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4
    function onMove(e) {
      const hit = e.target?.closest?.('[data-nav-flyout]')
        || inside(e, peekRef.current?.getBoundingClientRect())
        || inside(e, railRef.current?.getBoundingClientRect())
      if (hit) {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
      } else if (!closeTimer) {
        closeTimer = setTimeout(() => setPeek(false), 180)
      }
    }
    function onKey(e) { if (e.key === 'Escape') setPeek(false) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('keydown', onKey)
      if (closeTimer) clearTimeout(closeTimer)
    }
  }, [peek])

  // Naviguer depuis le coup d'œil le referme (la page demandée reste en vue).
  useEffect(() => { setPeek(false); cancelPeekArm() }, [location.pathname, location.search])
  useEffect(() => () => cancelPeekArm(), [])

  // Pastille « nouveautés » : initialisée depuis localStorage, retirée quand la
  // page Changelog émet l'événement `changelog:seen` au montage.
  useEffect(() => {
    const onSeen = () => setHasUnseenNews(false)
    window.addEventListener(CHANGELOG_SEEN_EVENT, onSeen)
    return () => window.removeEventListener(CHANGELOG_SEEN_EVENT, onSeen)
  }, [])

  // Raccourcis clavier globaux
  useEffect(() => {
    const NAV_MAP = Object.fromEntries(NAV_SHORTCUTS.map(s => [s.key, s.to]))
    function onKey(e) {
      // Cmd+K → recherche globale
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        const tag = document.activeElement?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        setShowSearch(s => !s)
        return
      }
      // Lettres simples → navigation. Ignorer si on tape dans un champ ou si
      // un modificateur est actif.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const ae = document.activeElement
      const tag = ae?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae?.isContentEditable) return
      // Un scanner code-barre est monté (ex. fiche commande) : les frappes sont
      // des caractères de code, pas des raccourcis — ne pas naviguer.
      if (window.__barcodeScannerActive) return
      // « ? » → overlay d'aide des raccourcis (standard GitHub/Linear/Gmail).
      // e.key vaut '?' (Shift+/) ; on tolère aussi shiftKey sans le bloquer.
      if (e.key === '?') {
        e.preventDefault()
        setShowShortcuts(s => !s)
        return
      }
      const target = NAV_MAP[e.key.toLowerCase()]
      if (target) {
        e.preventDefault()
        navigate(target)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  // WebSocket global — connexion + reconnexion gérées par lib/realtime.js.
  // CustomEvents back-compat (agent:task:*, sync:progress) sont re-dispatchés
  // par la lib pour ne pas casser les écouteurs existants.
  useEffect(() => {
    realtimeConnect()
    return () => realtimeDisconnect()
  }, [])

  const roleLabel = { admin: 'Admin', rh: 'RH', sales: 'Ventes', support: 'Support', ops: 'Opérations' }
  const isHR = ['admin', 'rh'].includes(user?.role)
  // Filtrage en deux temps : d'abord les permissions de rôle (hrOnly), puis les
  // préférences perso de l'utilisateur (items/groupes cachés via Paramètres).
  // Clés : item = `to`, groupe = `group:<nom>`.
  // Ordre personnalisé appliqué avant filtrage : `orderedNavItems` (non filtré)
  // reste la référence du glisser-déposer, pour ne pas perdre la position des
  // entrées cachées.
  const orderedNavItems = useMemo(() => applyNavOrder(defaultNavItems, order), [order])
  const filteredNavItems = orderedNavItems
    .map(item => {
      // Liens externes : toujours préservés, hors logique de rôle/préférences
      // (pas de `to` interne à filtrer).
      if (item.external) return item
      if (!item.group) {
        return isHidden(item.to) ? null : item
      }
      if (isHidden(`group:${item.group}`)) return null
      const items = item.items.filter(i => (!i.hrOnly || isHR) && !isHidden(i.to))
      if (items.length === 0) return null
      return { ...item, items }
    })
    .filter(Boolean)

  // Contenu de la sidebar (partagé desktop / tiroir mobile). Rendu par appel
  // direct (pas un composant JSX) : défini pendant le render, il perdrait son
  // état à chaque frappe s'il était monté comme composant.
  const sidebarBody = ({ mobile = false, peeking = false } = {}) => (
    <div className={`flex flex-col h-full bg-white ${mobile ? 'w-72' : 'w-60'}`}>
      {/* En-tête : logo + repli */}
      <div className="flex items-center h-14 px-3 border-b border-slate-100 flex-shrink-0 gap-2">
        <NavLink to="/dashboard" className="flex items-center gap-2 min-w-0" title="Tableau de bord">
          <img src="/erp/favicon.png" alt="Orisha ERP" className="h-7 w-auto" />
          <span className="text-[15px] font-semibold text-slate-800 tracking-tight">Orisha</span>
        </NavLink>
        {/* File de travaux : joignable depuis n'importe quelle page (⌘/Ctrl + /). */}
        <TravauxQuickButton className="ml-auto" />
        <ThemeToggle />
        {!mobile && (
          <button
            onClick={() => setSidebarCollapsed(!peeking && !collapsed)}
            data-testid={peeking ? 'sidebar-pin' : 'sidebar-collapse'}
            title={peeking ? 'Garder le menu ouvert' : 'Replier le menu'}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          >
            {peeking ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </button>
        )}
      </div>

      {/* Recherche unifiée : pages/sections ET contenu, dans la même palette */}
      <div className="px-3 pt-3 pb-1.5 flex-shrink-0">
        <button
          data-testid="sidebar-search"
          onClick={() => setShowSearch(true)}
          className="flex items-center gap-2 w-full px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-slate-400 hover:border-slate-300 hover:text-slate-500 transition-colors"
        >
          <Search size={14} className="flex-shrink-0" />
          <span className="flex-1 text-left text-[13px]">Rechercher…</span>
          <kbd className="text-[10px] text-slate-400 bg-white border border-slate-200 px-1 py-0.5 rounded">⌘K</kbd>
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-1.5 px-2 space-y-0.5">
        {filteredNavItems.map(item => (
          <NavSortable key={navKey(item)} container="root" itemKey={navKey(item)}>
            {item.group ? <NavGroup {...item} /> : <NavItem {...item} />}
          </NavSortable>
        ))}
      </nav>

      {/* Bas de barre : Agent, Paramètres admin, compte */}
      <div className="border-t border-slate-100 py-2 px-2 space-y-0.5 flex-shrink-0">
        {/* Agent visible par tous : suggestions + correctifs (bulle d'aide).
            La ligne porte un sous-menu au survol (Agent autonome, file de
            prompts de l'agent, suggestions, idées). */}
        <NavRow item={{ to: '/agent', icon: Bot, label: 'Agent' }} variant="bottom" />
        {user?.role === 'admin' && (
          <NavItem to="/admin" icon={Settings} label="Paramètres" />
        )}
        <div className="pt-1">
          <UserAvatarMenu user={user} roleLabel={roleLabel} onLogout={logout} hasUnseenNews={hasUnseenNews} />
        </div>
      </div>
    </div>
  )

  return (
    <NavReorderProvider items={orderedNavItems} order={order} setOrder={setOrder}>
    <div className="flex h-screen overflow-hidden bg-slate-50">
      {/* Sidebar desktop — repliable en rail */}
      <div
        data-testid="app-sidebar"
        className={`hidden md:flex relative flex-shrink-0 bg-white border-r border-slate-200 transition-[width] duration-200 overflow-hidden ${collapsed ? 'w-12' : 'w-60'}`}
      >
        {collapsed ? (
          // Rail replié : logo, réouverture, recherche — rien d'autre, tout
          // l'écran reste à la tâche en cours. Le survol du rail rouvre le menu
          // en surimpression le temps d'un coup d'œil.
          <div
            ref={railRef}
            data-testid="sidebar-rail"
            onMouseEnter={armPeek}
            onMouseMove={armPeek}
            onMouseLeave={cancelPeekArm}
            className="flex flex-col items-center w-12 py-3 gap-1.5"
          >
            <img src="/erp/favicon.png" alt="Orisha ERP" className="h-6 w-auto mb-1" />
            <button
              onClick={toggleSidebar}
              data-testid="sidebar-reopen"
              title="Ouvrir le menu"
              className="p-2 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors"
            >
              <PanelLeftOpen size={16} />
            </button>
            <button
              onClick={() => setShowSearch(true)}
              title="Rechercher (⌘K)"
              className="p-2 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors"
            >
              <Search size={16} />
            </button>
            <TravauxQuickButton compact />
            <ThemeToggle compact />
          </div>
        ) : (
          <>
            {sidebarBody({})}
            {/* Barre verticale de repli, sur toute la hauteur du bord droit :
                cliquer n'importe où le long de la sidebar la replie. */}
            <button
              type="button"
              data-testid="sidebar-collapse-edge"
              onClick={toggleSidebar}
              title="Replier le menu"
              aria-label="Replier le menu"
              className="absolute inset-y-0 right-0 w-1.5 z-10 group cursor-w-resize"
            >
              <span className="absolute inset-y-0 right-0 w-[3px] group-hover:bg-brand-500/60 transition-colors" />
            </button>
          </>
        )}
      </div>

      {/* Coup d'œil au survol du rail : le menu complet par-dessus la page, sans
          pousser le contenu ni changer l'état replié. Décalé de la largeur du
          rail, qui reste visible et cliquable (son bouton épingle le menu). */}
      {collapsed && peek && (
        <div
          ref={peekRef}
          data-testid="sidebar-peek"
          className="hidden md:block fixed left-12 top-0 bottom-0 z-[120] w-60 bg-white border-r border-slate-200 shadow-2xl"
        >
          {sidebarBody({ peeking: true })}
        </div>
      )}

      {/* Mobile sidebar */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="fixed inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="fixed left-0 top-0 bottom-0 z-50 flex shadow-2xl">
            {sidebarBody({ mobile: true })}
            <button
              onClick={() => setMobileOpen(false)}
              className="absolute top-4 right-4 text-slate-500"
            >
              <X size={20} />
            </button>
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile header */}
        <div className="md:hidden flex items-center h-14 px-4 bg-white border-b border-slate-200">
          <button onClick={() => setMobileOpen(true)} className="text-slate-600 mr-3">
            <Menu size={20} />
          </button>
          <img src="/erp/favicon.png" alt="Orisha ERP" className="h-7 w-auto" />
          <TravauxQuickButton compact className="ml-auto" />
          <ThemeToggle compact />
        </div>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>

      <Modal isOpen={showChangePw} onClose={() => setShowChangePw(false)} title="Changer mon mot de passe" size="sm">
        <ChangePasswordModal onClose={() => setShowChangePw(false)} />
      </Modal>

      <CRMSearch open={showSearch} onClose={() => setShowSearch(false)} />

      <KeyboardShortcutsModal isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />

      <FeedbackFab />
    </div>
    </NavReorderProvider>
  )
}
