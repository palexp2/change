import { useState, useEffect, useRef, useLayoutEffect, useMemo, createContext, useContext } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  Settings,
  ChevronRight, ChevronDown, LogOut, Menu, X,
  Search, ExternalLink, Sparkles, ListChecks,
  GripVertical, Bookmark, BookmarkPlus, BookmarkMinus,
} from 'lucide-react'
import { useAuth } from '../lib/auth.jsx'
import { useNavPrefs } from '../lib/navPrefs.jsx'
import { defaultNavItems, applyNavOrder, navKey, findNavEntry } from '../lib/navItems.js'
import { currentPageTitle } from '../lib/currentPageTitle.js'
import { getSubsections, resolveSubsections } from '../lib/navSubsections.js'
import { SETTINGS_ROUTE } from '../lib/settingsSections.js'
import { NAV_TAB_CLAIMS } from '../lib/financeSections.js'
import { api } from '../lib/api.js'
import { prefetch } from '../lib/prefetch.js'
import { connect as realtimeConnect, disconnect as realtimeDisconnect } from '../lib/realtime.js'
import { startRecordLive, stopRecordLive } from '../lib/recordLive.jsx'
import { Modal } from './Modal.jsx'
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal.jsx'
import { GlobalSearch as CRMSearch } from './GlobalSearch.jsx'
import { FeedbackFab } from './FeedbackFab.jsx'
import ThemeToggle from './ThemeToggle.jsx'
import { useTravauxQuick } from './TravauxQuickPanel.jsx'
import { Logo } from './Logo.jsx'

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
function NavItem({ to, href, external, icon: Icon, label, compact = false, badge, badgeTone, badgeTitle }) {
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
      <NavBadge item={{ to, badge, badgeTone, badgeTitle }} inRail={false} />
    </NavLink>
  )
}

// ── Chaîne de survol des panneaux flottants ─────────────────────────────────
// Un panneau se ferme quand la souris le quitte. Avec des sous-menus imbriqués,
// entrer dans l'enfant, c'est quitter le parent : sans coordination, le parent
// se fermerait et emporterait l'enfant. Chaque panneau ouvert s'annonce donc à
// son parent, qui compte les rectangles de ses descendants comme « dedans ».
const FlyoutChainContext = createContext(null)

// ── Un seul menu de section à la fois ───────────────────────────────────────
// Un panneau s'ouvre dès que la souris touche son icône, mais ne se referme que
// lorsqu'elle s'éloigne franchement (tolérance de quelques pixels autour de
// l'icône et du panneau, cf. useFlyoutDismiss). En glissant d'une section à sa
// voisine — ou en s'arrêtant dans l'interstice entre deux icônes — l'ancienne
// se croyait encore survolée pendant que la nouvelle s'ouvrait : deux menus
// superposés à l'écran. Les panneaux de premier niveau du rail s'inscrivent
// donc ici, et toute ouverture referme les autres sans délai. Les sous-menus
// imbriqués ne s'inscrivent pas : ils vivent avec leur parent.
const openRailMenus = new Set()

function useExclusiveRailMenu(open, close) {
  const closeRef = useRef(close)
  closeRef.current = close
  // Avant la peinture : jamais une image avec deux menus.
  useLayoutEffect(() => {
    if (!open) return
    const self = { close: () => closeRef.current() }
    for (const other of [...openRailMenus]) {
      openRailMenus.delete(other)
      other.close()
    }
    openRailMenus.add(self)
    return () => { openRailMenus.delete(self) }
  }, [open])
}

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
//
// `maxHeight` : toujours la hauteur utile de la fenêtre, jamais « du haut du
// panneau jusqu'en bas ». Sinon un déclencheur du bas du rail (la roue dentée)
// s'enferme dans un cercle vicieux : le panneau est bridé par sa position, on
// mesure sa hauteur tronquée, elle « tient » déjà en bas, donc il n'est jamais
// remonté — la roue dentée n'affichait plus qu'un liseré de sous-menu.
function useFlyoutPosition(triggerRef, panelRef, open) {
  const [pos, setPos] = useState(null)

  const seed = () => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.top, left: r.right + 4, maxHeight: window.innerHeight - 16 })
  }

  useLayoutEffect(() => {
    if (!open) return
    const t = triggerRef.current?.getBoundingClientRect()
    const p = panelRef.current
    if (!t || !p) return
    const w = p.offsetWidth
    // Hauteur naturelle : offsetHeight est déjà rogné par le maxHeight du rendu
    // précédent, scrollHeight rend le contenu complet.
    const avail = window.innerHeight - 16
    const h = Math.min(Math.max(p.scrollHeight, p.offsetHeight), avail)
    setPos({
      top: Math.max(8, Math.min(t.top, window.innerHeight - h - 8)),
      left: t.right + w + 8 > window.innerWidth ? Math.max(8, t.left - w - 4) : t.right + 4,
      maxHeight: avail,
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
 *   - 'rail'    : icône seule dans le rail — le panneau porte le titre de la
 *                 page et s'ouvre même sans sous-section (il tient alors le
 *                 rôle d'infobulle)
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

/**
 * Compteur posé sur une entrée de navigation (`item.badge`). Dans le rail réduit
 * aux icônes, c'est le seul moyen de savoir qu'il se passe quelque chose derrière
 * l'icône : la pastille se pose dans le coin. Dans le menu déplié, elle suit le
 * libellé. Ton violet quand Claude attend une réponse (même code couleur que la
 * pastille « À répondre » de /travaux), vert de marque sinon.
 */
function NavBadge({ item, inRail }) {
  const n = item.badge || 0
  if (!n) return null
  const tone = item.badgeTone === 'ask' ? 'bg-violet-600' : 'bg-brand-600'
  return (
    <span
      data-testid={`nav-badge-${item.to}`}
      title={item.badgeTitle}
      className={`${inRail ? 'absolute -top-0.5 -right-0.5' : 'flex-shrink-0'}
       inline-flex items-center justify-center min-w-[15px] h-[15px] px-1
       rounded-full text-white text-[9px] font-semibold leading-none ${tone}`}
    >
      {n > 99 ? '99+' : n}
    </span>
  )
}

function NavRow({ item, variant }) {
  const hover = useHoverPrefetch(item.to)
  // Certaines sous-sections sont réservées aux admins (Paramètres).
  const { user } = useAuth()
  const [items, setItems] = useState(null)
  const [open, setOpen] = useState(false)
  const rowRef = useRef(null)
  const panelRef = useRef(null)
  const location = useLocation()
  const { chain, childRects } = useFlyoutChain(panelRef, open)
  const [pos, seedPos] = useFlyoutPosition(rowRef, panelRef, open)
  const hasSubsections = !!getSubsections(item.to)
  const inFlyout = variant === 'flyout'
  const inRail = variant === 'rail'
  // Réordonner le rail au glisser-déposer : pendant un glissement de section,
  // ouvrir un panneau masquerait la ligne visée (le calcul de cible passe par
  // elementFromPoint). Les panneaux restent donc fermés le temps du geste.
  const rootDrag = useContext(NavReorderContext)?.drag?.container === 'root'

  useFlyoutDismiss({ open, pinned: false, triggerRef: rowRef, panelRef, childRects, close: () => setOpen(false) })
  // Seules les icônes du rail sont des menus de premier niveau : les lignes de
  // panneau (variantes 'flyout'/'group') sont des sous-menus de leur parent.
  useExclusiveRailMenu(inRail && open, () => setOpen(false))
  useEffect(() => { setOpen(false) }, [location.pathname, location.search])
  useEffect(() => { if (rootDrag) setOpen(false) }, [rootDrag])

  const pendingRef = useRef(false)
  function onEnter() {
    hover.onMouseEnter?.()
    if (rootDrag) return
    if (!hasSubsections) {
      // Dans le rail, le panneau porte le titre : il s'ouvre quand même.
      if (inRail) { seedPos(); setOpen(true) }
      return
    }
    seedPos()
    if (items) { setOpen(true); return }
    if (pendingRef.current) return
    pendingRef.current = true
    resolveSubsections(item.to, { isAdmin: user?.role === 'admin' }).then(list => {
      pendingRef.current = false
      setItems(list)
      setOpen(true)
    })
  }

  const cls = ({ isActive: routerActive }) => {
    const isActive = tabAwareActive(item.to, location, routerActive)
    // `nav-active` porte la teinte de section héritée (`--nav-accent`, posée
    // par NavGroup ; vert de marque par défaut hors groupe).
    if (inRail) {
      // `relative` : la pastille de compteur (item.badge) se pose dans le coin.
      return `relative flex items-center justify-center w-9 h-9 rounded-lg transition-colors
       ${isActive ? 'nav-active' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'}`
    }
    return `flex items-center gap-2.5 rounded-md text-sm font-medium transition-colors
     ${inFlyout ? 'px-3 py-2 mx-1' : 'px-3 py-1.5'}
     ${isActive
        ? 'nav-active'
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
        onMouseMove={() => { if ((hasSubsections || inRail) && !open) onEnter() }}
        onMouseLeave={hover.onMouseLeave}
        title={inRail ? item.label : undefined}
        aria-label={inRail ? item.label : undefined}
        className={cls}
      >
        <item.icon size={inRail ? 18 : inFlyout ? 15 : 14} className="flex-shrink-0" />
        {!inRail && <span className="flex-1">{item.label}</span>}
        <NavBadge item={item} inRail={inRail} />
        {hasSubsections && !inRail && <ChevronRight size={11} className="flex-shrink-0 opacity-50" />}
      </NavLink>

      {open && (inRail || items?.length > 0) && (
        <FlyoutChainContext.Provider value={chain}>
          <div
            ref={panelRef}
            role="menu"
            aria-label={item.label}
            data-testid="nav-subsection-panel"
            data-nav-flyout=""
            data-route={item.to}
            className={`fixed bg-white rounded-xl shadow-xl border border-slate-200 py-1.5 max-w-72 z-[210] overflow-y-auto ${items?.length ? 'min-w-52' : ''}`}
            style={pos
              ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight }
              : { top: 0, left: 0, visibility: 'hidden' }}
          >
            <p className={items?.length
              ? 'px-3 pb-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider truncate'
              : 'px-3 py-0.5 text-[13px] font-medium text-slate-700 whitespace-nowrap'}>
              {item.label}
            </p>
            {items?.map(sub => (
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
            ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight }
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
// `rail` : dans le rail d'icônes, la ligne occupe toute la largeur et l'icône
// est centrée — la poignée se loge dans la marge de gauche au lieu de mordre
// sur l'icône (où elle volerait le clic de navigation).
function NavSortable({ container, itemKey, rail = false, children }) {
  const ctx = useContext(NavReorderContext)
  if (!ctx || !itemKey) return children
  const { drag, start } = ctx
  const dragging = drag?.container === container && drag.key === itemKey
  const isTarget = drag?.container === container && drag.targetKey === itemKey && drag.key !== itemKey

  return (
    <div
      data-nav-sortable={itemKey}
      data-nav-container={container}
      className={`relative group/sortable ${rail ? 'w-full flex justify-center' : ''} ${dragging ? 'opacity-40' : ''}`}
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
        className={`absolute left-0 top-1/2 -translate-y-1/2 z-20 flex items-center justify-center h-5 ${rail ? 'w-2.5' : 'w-3'}
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

function NavGroup({ group, icon: Icon, items, accent }) {
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

  // Survol : déplie la section sans clic, comme le reste des menus de la
  // sidebar (cf. NavRow, NavFlyoutItem), et la replie quand la souris la
  // quitte (cf. useFlyoutDismiss) — sauf si elle est épinglée : ouverte par
  // clic (persistée en localStorage) ou active (route courante). Court délai
  // d'intention à l'ouverture pour qu'un simple balayage ne déplie pas tout
  // au passage ; `openedByHoverRef` ne suit que les ouvertures dues au survol,
  // pour ne jamais refermer une section épinglée.
  const enterTimerRef = useRef(null)
  const leaveTimerRef = useRef(null)
  const openedByHoverRef = useRef(false)
  function onHoverEnter() {
    if (leaveTimerRef.current) { clearTimeout(leaveTimerRef.current); leaveTimerRef.current = null }
    if (open) return
    enterTimerRef.current = setTimeout(() => {
      openedByHoverRef.current = true
      setOpen(true)
    }, 90)
  }
  function onHoverLeave() {
    if (enterTimerRef.current) { clearTimeout(enterTimerRef.current); enterTimerRef.current = null }
    if (openedByHoverRef.current && !isActive) {
      leaveTimerRef.current = setTimeout(() => {
        openedByHoverRef.current = false
        setOpen(false)
      }, 150)
    }
  }

  // Teinte de section : posée ici, héritée par toutes les entrées du groupe
  // (cf. `.nav-active` dans index.css). Hors groupe, `--nav-accent` retombe
  // sur le vert de marque défini au `:root`.
  const accentVar = accent ? { '--nav-accent': `var(--acc-${accent})` } : undefined

  return (
    <div style={accentVar} onMouseEnter={onHoverEnter} onMouseLeave={onHoverLeave}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium w-full transition-all
          ${isActive ? 'nav-active' : 'text-slate-700 hover:text-slate-900 hover:bg-slate-100'}`}
      >
        <Icon
          size={16}
          className="flex-shrink-0"
          // Groupe éteint : l'icône garde la teinte, c'est elle qui sert de
          // repère. Groupe allumé : elle suit la couleur du texte.
          style={isActive ? undefined : { color: 'rgb(var(--nav-accent))' }}
        />
        <span className="flex-1 text-left">{group}</span>
        <ChevronDown
          size={12}
          className={`flex-shrink-0 transition-transform duration-150 ${open ? '' : '-rotate-90'} ${isActive ? '' : 'text-slate-400'}`}
        />
      </button>

      {open && (
        <div
          className="mt-0.5 ml-4 pl-2 border-l space-y-0.5"
          style={{ borderColor: 'rgb(var(--nav-accent) / 0.3)' }}
        >
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

// ── Rail de sections ────────────────────────────────────────────────────────
// Sur desktop, la barre latérale est un rail permanent : une icône par grande
// section, rien d'autre. Le survol d'une icône ouvre le menu de la section
// juste à côté — son titre, puis ses pages cliquables. Rien ne se déplie sur
// place, le contenu de la page ne bouge jamais.

function RailNavLink({ item }) {
  return <NavRow item={item} variant="rail" />
}

// Lien externe (ex. Admin Chatbot) réduit à son icône.
function RailExternalLink({ href, icon: Icon, label }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
      data-testid="nav-external"
      className="flex items-center justify-center w-9 h-9 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors"
    >
      <Icon size={18} />
    </a>
  )
}

function RailGroup({ group, icon: Icon, items, accent }) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const location = useLocation()
  const drag = useContext(NavReorderContext)?.drag
  const { chain, childRects } = useFlyoutChain(panelRef, open)
  const [pos, seedPos] = useFlyoutPosition(triggerRef, panelRef, open)

  const isActive = items.some(item => navItemMatches(location.pathname, item))
  // Teinte de section, comme dans le menu déplié : posée ici, héritée par les
  // entrées du panneau (cf. `.nav-active` dans index.css).
  const accentVar = accent ? { '--nav-accent': `var(--acc-${accent})` } : undefined

  const openMenu = () => { seedPos(); setOpen(true) }
  const close = () => { setOpen(false); setPinned(false) }
  // Glisser-déposer : un glissement DANS le panneau doit le garder ouvert
  // (épinglé), un glissement du rail lui-même doit le fermer — ouvert, il
  // masquerait les lignes visées.
  const rootDrag = drag?.container === 'root'
  const innerDrag = drag?.container === `group:${group}`
  useFlyoutDismiss({ open, pinned: pinned || innerDrag, triggerRef, panelRef, childRects, close })
  useExclusiveRailMenu(open, close)
  useEffect(() => { if (rootDrag) { setOpen(false); setPinned(false) } }, [rootDrag])
  useEffect(() => { setOpen(false); setPinned(false) }, [location.pathname, location.search])

  return (
    // `my-0.5` : un peu d'air autour des sections à menu survolable, pour les
    // détacher des entrées à plat du rail (qui n'ont que le `gap` de la nav).
    <div style={accentVar} className="my-0.5">
      <button
        ref={triggerRef}
        type="button"
        onMouseEnter={() => { if (!rootDrag) openMenu() }}
        onMouseMove={() => { if (!open && !rootDrag) openMenu() }}
        onFocus={openMenu}
        onClick={() => {
          // Au doigt il n'y a pas de survol : le tap ouvre puis referme.
          if (open && pinned) { close(); return }
          if (!open) openMenu()
          setPinned(true)
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={group}
        title={group}
        data-testid="rail-section"
        data-section={group}
        className={`flex items-center justify-center w-9 h-9 rounded-lg transition-colors
          ${isActive ? 'nav-active' : 'text-slate-500 hover:bg-slate-100'}`}
      >
        {/* Section éteinte : l'icône garde la teinte de section, c'est le seul
            repère quand il n'y a pas de libellé. */}
        <Icon size={18} style={isActive ? undefined : { color: 'rgb(var(--nav-accent))' }} />
      </button>

      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label={group}
          data-testid="rail-section-panel"
          data-nav-flyout=""
          className="fixed bg-white rounded-xl shadow-xl border border-slate-200 py-2 min-w-56 z-[200] overflow-y-auto"
          style={{
            ...accentVar,
            ...(pos
              ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight }
              : { top: 0, left: 0, visibility: 'hidden' }),
          }}
        >
          <p
            className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: 'rgb(var(--nav-accent))' }}
          >
            {group}
          </p>
          <FlyoutChainContext.Provider value={chain}>
            {items.map(item => (
              <NavSortable key={item.to || item.href} container={`group:${group}`} itemKey={item.to || item.href}>
                {item.flyoutGroups
                  ? <NavFlyoutItem {...item} groups={item.flyoutGroups} />
                  : item.external
                    ? <NavItem {...item} compact />
                    : <FlyoutNavLink item={item} />}
              </NavSortable>
            ))}
          </FlyoutChainContext.Provider>
        </div>
      )}
    </div>
  )
}

// ── Signets ─────────────────────────────────────────────────────────────────
// Le menu porte les grandes sections ; une page précise et souvent revisitée
// (une configuration de champs, une vue filtrée, une fiche) n'y a pas d'entrée.
// Le signet l'épingle sous l'icône du tableau de bord, sans toucher au menu
// canonique. Préférence par utilisateur (nav_bookmarks), autosauvegardée.

// Nom du signet : le titre affiché par la page (cf. lib/currentPageTitle.js),
// sinon l'entrée de menu qui possède la route, sinon l'URL elle-même.
function bookmarkLabelFor(location) {
  const key = location.pathname + location.search
  return currentPageTitle(key) || findNavEntry(location.pathname)?.label || key
}

function BookmarkRows({ bookmarks, here, onRemove, compact = false }) {
  return bookmarks.map(b => {
    const Icon = findNavEntry(b.to.split('?')[0])?.icon || Bookmark
    const isHere = b.to === here
    return (
      <div key={b.to} className="relative group/bm">
        <NavLink
          to={b.to}
          title={b.label}
          className={`flex items-center gap-2 px-3 py-1.5 mx-1 pr-7 rounded-md text-sm transition-colors
            ${isHere ? 'nav-active font-medium' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'}`}
        >
          <Icon size={compact ? 13 : 14} className="flex-shrink-0" />
          <span className="truncate">{b.label}</span>
        </NavLink>
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); onRemove(b) }}
          title="Retirer des signets"
          aria-label="Retirer des signets"
          className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-400 hover:text-slate-700
            opacity-0 group-hover/bm:opacity-100 transition-opacity"
        >
          <X size={12} />
        </button>
      </div>
    )
  })
}

function BookmarkToggle({ marked, onClick, className = '' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="nav-bookmark-toggle"
      className={`flex items-center gap-2 w-full px-3 py-1.5 rounded-md text-[13px]
        text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors ${className}`}
    >
      {marked ? <BookmarkMinus size={14} /> : <BookmarkPlus size={14} />}
      {marked ? 'Retirer cette page' : 'Ajouter cette page'}
    </button>
  )
}

// Rail : une icône, le panneau des signets au survol (même mécanique que les
// sections, cf. RailGroup).
function RailBookmarks() {
  const { bookmarks, isBookmarked, toggleBookmark } = useNavPrefs()
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const location = useLocation()
  const { chain, childRects } = useFlyoutChain(panelRef, open)
  const [pos, seedPos] = useFlyoutPosition(triggerRef, panelRef, open)

  const here = location.pathname + location.search
  const marked = isBookmarked(here)

  const openMenu = () => { seedPos(); setOpen(true) }
  const close = () => { setOpen(false); setPinned(false) }
  useFlyoutDismiss({ open, pinned, triggerRef, panelRef, childRects, close })
  useExclusiveRailMenu(open, close)
  useEffect(() => { close() }, [location.pathname, location.search])

  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        onMouseEnter={openMenu}
        onMouseMove={() => { if (!open) openMenu() }}
        onFocus={openMenu}
        onClick={() => {
          // Au doigt il n'y a pas de survol : le tap ouvre puis referme.
          if (open && pinned) { close(); return }
          if (!open) openMenu()
          setPinned(true)
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Signets"
        title="Signets"
        data-testid="rail-bookmarks"
        className={`flex items-center justify-center w-9 h-9 flex-shrink-0 rounded-lg transition-colors
          ${marked ? 'text-brand-600' : 'text-slate-500'} hover:text-slate-800 hover:bg-slate-100`}
      >
        <Bookmark size={17} fill={marked ? 'currentColor' : 'none'} />
      </button>

      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label="Signets"
          data-testid="nav-bookmarks-panel"
          data-nav-flyout=""
          className="fixed bg-white rounded-xl shadow-xl border border-slate-200 py-2 min-w-56 max-w-72 z-[200] overflow-y-auto"
          style={pos
            ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight }
            : { top: 0, left: 0, visibility: 'hidden' }}
        >
          <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Signets</p>
          <FlyoutChainContext.Provider value={chain}>
            <BookmarkRows bookmarks={bookmarks} here={here} onRemove={toggleBookmark} />
          </FlyoutChainContext.Provider>
          <div className={bookmarks.length ? 'mt-1 pt-1 border-t border-slate-100' : ''}>
            <BookmarkToggle
              marked={marked}
              onClick={() => toggleBookmark({ to: here, label: bookmarkLabelFor(location) })}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// Tiroir mobile : pas de survol au doigt, la liste est déjà dépliée.
function MobileBookmarks() {
  const { bookmarks, isBookmarked, toggleBookmark } = useNavPrefs()
  const location = useLocation()
  const here = location.pathname + location.search
  return (
    <div className="pb-1 mb-1 border-b border-slate-100">
      <p className="px-3 pb-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Signets</p>
      <BookmarkRows bookmarks={bookmarks} here={here} onRemove={toggleBookmark} compact />
      <BookmarkToggle
        marked={isBookmarked(here)}
        onClick={() => toggleBookmark({ to: here, label: bookmarkLabelFor(location) })}
      />
    </div>
  )
}

// Ligne de compte en bas de la sidebar : avatar + nom, menu au survol
// (identité + Déconnexion) qui s'ouvre au-dessus.
// `compact` : dans le rail, l'avatar seul (le nom n'a pas la place).
function UserAvatarMenu({ user, roleLabel, onLogout, compact = false }) {
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

  // Dans le rail, ce menu est au même niveau que ceux des sections : il les
  // ferme en s'ouvrant, et se ferme quand l'une d'elles s'ouvre.
  useExclusiveRailMenu(compact && open, () => setOpen(false))

  return (
    <>
      <div
        ref={triggerRef}
        data-testid="user-avatar-trigger"
        onMouseEnter={openMenu}
        title={compact ? user?.name : undefined}
        className={`flex items-center rounded-lg cursor-pointer hover:bg-slate-100 transition-colors
          ${compact ? 'justify-center w-9 h-9' : 'gap-2.5 px-2 py-1.5'}`}
      >
        <div className="relative w-7 h-7 flex-shrink-0 bg-gradient-to-br from-brand-500 to-emerald-700 rounded-full flex items-center justify-center">
          <span className="text-white text-[11px] font-semibold tracking-tight">{initials}</span>
        </div>
        {!compact && (
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-slate-700 truncate">{user?.name}</div>
          </div>
        )}
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
          {/* Ni les nouveautés ni les paramètres ne sont ici : ils ont leur
              propre entrée dans la barre latérale, juste au-dessus. Ce menu ne
              garde que ce qui touche au compte. */}
          <button
            onClick={onLogout}
            className="flex items-center gap-2.5 w-full px-3 py-2 mt-1 mx-1 rounded-md text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors"
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
        <input type="password" value={form.next} onChange={e => setForm(f => ({ ...f, next: e.target.value }))} className="input" required />
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
  // Sur desktop la barre latérale est TOUJOURS repliée : un rail d'icônes, une
  // par grande section, et le menu de la section au survol (cf. RailGroup). Il
  // n'y a donc plus d'état déplié/replié à persister. Le menu complet, avec
  // libellés, ne subsiste que dans le tiroir mobile.
  const [mobileOpen, setMobileOpen] = useState(false)
  const [showChangePw, setShowChangePw] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const { user, logout } = useAuth()
  const { isHidden, order, setOrder } = useNavPrefs()
  // Compteur des files de travaux : la lecture temps réel vit déjà dans le
  // provider du panneau rapide (monté au-dessus des routes), on ne rajoute donc
  // aucun appel. Les DEUX files sont comptées — l'icône dit « il reste du
  // travail », peu importe de quelle section il vient. Les items « de côté » n'y
  // sont pas : rien ne démarrera tant qu'on ne les aura pas remis en file.
  const travauxQuick = useTravauxQuick()
  const travauxItem = useMemo(() => {
    const asking = travauxQuick?.askingCount || 0
    const active = travauxQuick?.activeCount || 0
    const total = asking + active
    return {
      to: '/travaux',
      icon: ListChecks,
      label: 'Travaux',
      badge: total,
      badgeTone: asking ? 'ask' : 'busy',
      badgeTitle: total
        ? [`${total} en file`, asking ? `dont ${asking} en attente de ta réponse` : null].filter(Boolean).join(' — ')
        : undefined,
    }
  }, [travauxQuick?.askingCount, travauxQuick?.activeCount])

  // Roue dentée : simple lien vers la page. Ses sections ne s'ouvrent pas au
  // survol dans le menu de gauche — on les voit une fois sur la page
  // (cf. lib/settingsSections.js).
  const settingsItem = { to: SETTINGS_ROUTE, icon: Settings, label: 'Paramètres' }

  // Nouveautés : entrée à part entière de la barre latérale (avant, elle était
  // enfouie dans le menu du compte, où personne n'allait la chercher).
  const changelogItem = { to: '/changelog', icon: Sparkles, label: 'Nouveautés' }

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
  // `startRecordLive` : l'abonnement unique qui fait qu'une modification venue
  // d'ailleurs (Airtable, un collègue) apparaît sans rafraîchir la page, et que
  // le champ touché porte sa pastille quelques secondes.
  useEffect(() => {
    realtimeConnect()
    startRecordLive()
    return () => { stopRecordLive(); realtimeDisconnect() }
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

  // Menu complet du tiroir mobile (pas de survol au doigt : tout est déplié).
  // Rendu par appel direct (pas un composant JSX) : défini pendant le render,
  // il perdrait son état à chaque frappe s'il était monté comme composant.
  const sidebarBody = () => (
    <div className="flex flex-col h-full bg-white w-72">
      {/* En-tête : logo */}
      <div className="flex items-center h-14 px-3 border-b border-slate-100 flex-shrink-0 gap-2">
        <NavLink to="/dashboard" className="flex items-center gap-2 min-w-0" title="Tableau de bord">
          <Logo size={24} className="text-brand-600 flex-shrink-0" />
          <span className="text-[15px] font-semibold text-slate-800 tracking-tight">Boréal</span>
        </NavLink>
        <div className="ml-auto"><ThemeToggle /></div>
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
        <MobileBookmarks />
        {filteredNavItems.map(item => (
          <NavSortable key={navKey(item)} container="root" itemKey={navKey(item)}>
            {item.group ? <NavGroup {...item} /> : <NavItem {...item} />}
          </NavSortable>
        ))}
      </nav>

      {/* Bas de barre : Travaux, Paramètres, compte */}
      <div className="border-t border-slate-100 py-2 px-2 space-y-0.5 flex-shrink-0">
        {/* Travaux visible par tous : file de prompts pour l'agent, suggestions,
            réglages — touche toute la plateforme, pas seulement la compta, d'où
            une entrée à plat plutôt qu'un sous-menu de l'Espace finance. */}
        <NavItem {...travauxItem} />
        <NavItem {...changelogItem} />
        <NavItem {...settingsItem} />
        <div className="pt-1">
          <UserAvatarMenu user={user} roleLabel={roleLabel} onLogout={logout} />
        </div>
      </div>
    </div>
  )

  // Rail desktop : une icône par grande section, le menu de la section au
  // survol (titre + pages, cf. RailGroup). Le logo, la recherche et le compte
  // encadrent la liste, comme dans l'ancien menu déplié.
  const sidebarRail = () => (
    <div
      data-testid="sidebar-rail"
      className="flex flex-col items-center w-14 h-full py-2.5 gap-1"
    >
      <NavLink
        to="/dashboard"
        title="Tableau de bord"
        aria-label="Tableau de bord"
        className="flex items-center justify-center w-9 h-9 mb-0.5 flex-shrink-0"
      >
        <Logo size={22} className="text-brand-600" />
      </NavLink>
      {/* Signets, juste sous l'icône du tableau de bord. */}
      <RailBookmarks />
      <button
        data-testid="sidebar-search"
        onClick={() => setShowSearch(true)}
        title="Rechercher (⌘K)"
        aria-label="Rechercher"
        className="flex items-center justify-center w-9 h-9 flex-shrink-0 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors"
      >
        <Search size={17} />
      </button>

      <nav className="flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden flex flex-col items-center gap-1 py-1">
        {filteredNavItems.map(item => (
          <NavSortable key={navKey(item)} container="root" itemKey={navKey(item)} rail>
            {item.group
              ? <RailGroup {...item} />
              : item.external
                ? <RailExternalLink {...item} />
                : <RailNavLink item={item} />}
          </NavSortable>
        ))}
      </nav>

      {/* Bas de rail : Travaux, Paramètres, compte */}
      <div className="flex flex-col items-center gap-1 pt-1.5 w-full border-t border-slate-100 flex-shrink-0">
        {/* Travaux visible par tous : file de prompts pour l'agent, suggestions,
            réglages — touche toute la plateforme, pas seulement la compta, d'où
            une entrée à plat plutôt qu'un sous-menu de l'Espace finance. */}
        <RailNavLink item={travauxItem} />
        <RailNavLink item={changelogItem} />
        <RailNavLink item={settingsItem} />
        <ThemeToggle compact />
        <UserAvatarMenu user={user} roleLabel={roleLabel} onLogout={logout} compact />
      </div>
    </div>
  )

  return (
    <NavReorderProvider items={orderedNavItems} order={order} setOrder={setOrder}>
    <div className="flex h-screen overflow-hidden bg-slate-50">
      {/* Sidebar desktop — rail d'icônes permanent, menus au survol */}
      <div
        data-testid="app-sidebar"
        className="hidden md:flex flex-shrink-0 bg-white border-r border-slate-200 w-14"
      >
        {sidebarRail()}
      </div>

      {/* Mobile sidebar */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="fixed inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="fixed left-0 top-0 bottom-0 z-50 flex shadow-2xl">
            {sidebarBody()}
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
          <Logo size={24} className="text-brand-600" />
          <div className="ml-auto"><ThemeToggle compact /></div>
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
