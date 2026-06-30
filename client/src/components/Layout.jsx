import { useState, useEffect, useRef } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  Settings,
  ChevronLeft, ChevronRight, ChevronDown, LogOut, Menu, X,
  Search, ExternalLink, Sparkles, Network, Bot,
} from 'lucide-react'
import { useAuth } from '../lib/auth.jsx'
import { useNavPrefs } from '../lib/navPrefs.jsx'
import { defaultNavItems } from '../lib/navItems.js'
import { useSyncStatus } from '../lib/useSyncStatus.js'
import { api } from '../lib/api.js'
import { prefetch } from '../lib/prefetch.js'
import { connect as realtimeConnect, disconnect as realtimeDisconnect } from '../lib/realtime.js'
import { hasUnseenChangelog, CHANGELOG_SEEN_EVENT } from '../lib/changelog.js'
import { Modal } from './Modal.jsx'
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal.jsx'
import { GlobalSearch as CRMSearch } from './GlobalSearch.jsx'
import { FeedbackFab } from './FeedbackFab.jsx'

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

const bottomNavItems = []

function NavItem({ to, href, external, icon: Icon, label, collapsed, badge }) {
  const hover = useHoverPrefetch(to)
  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="nav-external"
        className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all
          text-slate-300 hover:text-white hover:bg-slate-800
          ${collapsed ? 'justify-center' : ''}`}
        title={collapsed ? label : undefined}
      >
        <div className="relative flex-shrink-0">
          <Icon size={16} />
        </div>
        {!collapsed && <span className="flex-1">{label}</span>}
        {!collapsed && <ExternalLink size={12} className="flex-shrink-0 text-slate-500" />}
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
          : 'text-slate-300 hover:text-white hover:bg-slate-800'
        }
        ${collapsed ? 'justify-center' : ''}`
      }
      title={collapsed ? label : undefined}
    >
      <div className="relative flex-shrink-0">
        <Icon size={16} />
        {badge && (
          <span className="absolute -top-1 -right-1 w-2 h-2 bg-amber-400 rounded-full animate-pulse" />
        )}
      </div>
      {!collapsed && <span className="flex-1">{label}</span>}
      {!collapsed && badge && (
        <span className="text-xs text-amber-400 font-medium">sync</span>
      )}
    </NavLink>
  )
}

function FlyoutNavLink({ item }) {
  const hover = useHoverPrefetch(item.to)
  return (
    <NavLink
      to={item.to}
      {...hover}
      className={({ isActive }) =>
        `flex items-center gap-2.5 px-3 py-2 mx-1 rounded-md text-sm font-medium transition-colors
        ${isActive ? 'bg-brand-600 text-white' : 'text-slate-300 hover:text-white hover:bg-slate-700'}`
      }
    >
      <item.icon size={15} className="flex-shrink-0" />
      {item.label}
    </NavLink>
  )
}

function GroupNavLink({ item }) {
  const hover = useHoverPrefetch(item.to)
  return (
    <NavLink
      to={item.to}
      {...hover}
      className={({ isActive }) =>
        `flex items-center gap-2.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors
        ${isActive ? 'bg-brand-600 text-white' : 'text-slate-300 hover:text-white hover:bg-slate-800'}`
      }
    >
      <item.icon size={14} className="flex-shrink-0" />
      {item.label}
    </NavLink>
  )
}

function NavGroupCollapsedFlyout({ group, icon: Icon, items }) {
  const [open, setOpen] = useState(false)
  const [flyoutPos, setFlyoutPos] = useState({ top: 0, left: 0 })
  const triggerRef = useRef(null)
  const flyoutRef = useRef(null)
  const location = useLocation()
  const isActive = items.some(item => location.pathname === item.to || location.pathname.startsWith(item.to + '/'))

  function openMenu() {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      setFlyoutPos({ top: rect.top, left: rect.right })
    }
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
      <div ref={triggerRef} onMouseEnter={openMenu}>
        <div
          title={group}
          className={`flex items-center justify-center gap-3 px-3 py-2 rounded-lg text-sm font-medium select-none cursor-default transition-all
            ${isActive ? 'bg-brand-600 text-white' : 'text-slate-300 hover:text-white hover:bg-slate-800'}`}
        >
          <Icon size={16} className="flex-shrink-0" />
        </div>
      </div>

      {open && (
        <div
          ref={flyoutRef}
          className="fixed bg-slate-800 rounded-lg shadow-2xl border border-slate-700 py-1.5 min-w-52 z-[200]"
          style={{ top: flyoutPos.top, left: flyoutPos.left }}
        >
          <p className="px-3 pt-0.5 pb-1 text-xs font-semibold text-slate-400 uppercase tracking-wider">{group}</p>
          {items.map(item => (
            <FlyoutNavLink key={item.to} item={item} />
          ))}
        </div>
      )}
    </>
  )
}

function NavGroup({ group, icon: Icon, items, collapsed }) {
  const location = useLocation()
  const isActive = items.some(item => location.pathname === item.to || location.pathname.startsWith(item.to + '/'))

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

  if (collapsed) {
    return <NavGroupCollapsedFlyout group={group} icon={Icon} items={items} />
  }

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium w-full transition-all
          ${isActive ? 'bg-brand-600 text-white' : 'text-slate-300 hover:text-white hover:bg-slate-800'}`}
      >
        <Icon size={16} className="flex-shrink-0" />
        <span className="flex-1 text-left">{group}</span>
        <ChevronDown
          size={12}
          className={`flex-shrink-0 transition-transform duration-150 ${open ? '' : '-rotate-90'} ${isActive ? 'text-brand-200' : 'text-slate-500'}`}
        />
      </button>

      {open && (
        <div className="mt-0.5 ml-4 pl-2 border-l border-slate-800 space-y-0.5">
          {items.map(item => (
            <GroupNavLink key={item.to} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}

function UserAvatarMenu({ user, roleLabel, onLogout, hasUnseenNews }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const triggerRef = useRef(null)
  const flyoutRef = useRef(null)

  const parts = (user?.name || '').trim().split(/\s+/)
  const firstInitial = parts[0]?.[0]?.toUpperCase() || 'U'
  const lastInitial = parts.length > 1 ? parts[parts.length - 1][0].toUpperCase() : ''
  const initials = firstInitial + lastInitial

  function openMenu() {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      setPos({ top: rect.top, left: rect.right + 8 })
    }
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
        className="relative w-8 h-8 bg-gradient-to-br from-brand-500 to-emerald-700 rounded-full flex items-center justify-center cursor-pointer ring-2 ring-transparent hover:ring-brand-300/40 transition"
      >
        <span className="text-white text-xs font-semibold tracking-tight">{initials}</span>
        {hasUnseenNews && (
          <span
            data-testid="changelog-badge"
            className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-amber-400 rounded-full ring-2 ring-slate-900"
            title="Nouveautés disponibles"
          />
        )}
      </div>

      {open && (
        <div
          ref={flyoutRef}
          className="fixed bg-slate-800 rounded-lg shadow-2xl border border-slate-700 py-2 min-w-56 z-[200]"
          style={{ bottom: window.innerHeight - pos.top - 32, left: pos.left }}
        >
          <div className="px-3 py-2 border-b border-slate-700">
            <div className="text-white text-sm font-medium truncate">{user?.name}</div>
            <div className="text-slate-400 text-xs mt-0.5">{roleLabel[user?.role] || user?.role}</div>
          </div>
          <NavLink
            to="/changelog"
            data-testid="user-menu-changelog"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 w-full px-3 py-2 mt-1 mx-1 rounded-md text-sm text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
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
            className="flex items-center gap-2.5 w-full px-3 py-2 mx-1 rounded-md text-sm text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
            style={{ width: 'calc(100% - 0.5rem)' }}
          >
            <Settings size={14} />
            Paramètres
          </NavLink>
          <button
            onClick={onLogout}
            className="flex items-center gap-2.5 w-full px-3 py-2 mx-1 rounded-md text-sm text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
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
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [showChangePw, setShowChangePw] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const { user, logout } = useAuth()
  const { isHidden } = useNavPrefs()
  const { anyRunning } = useSyncStatus()
  const [hasUnseenNews, setHasUnseenNews] = useState(() => hasUnseenChangelog())

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
  const filteredNavItems = defaultNavItems
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

  const SidebarContent = ({ mobile = false }) => (
    <div className={`flex flex-col h-full bg-slate-900 ${mobile ? 'w-72' : collapsed ? 'w-16' : 'w-56'} transition-all duration-200`}>
      {/* Logo */}
      <div className={`flex items-center h-14 px-4 border-b border-slate-800 flex-shrink-0 justify-center`}>
        <img src="/erp/favicon.png" alt="Orisha ERP" className={collapsed && !mobile ? 'h-7 w-auto' : 'h-9 w-auto'} />
        {!mobile && (
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="ml-auto text-slate-400 hover:text-white p-1 rounded transition-colors"
          >
            {collapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
          </button>
        )}
      </div>

      {/* Search */}
      <div className="px-2 pt-2 pb-1 flex-shrink-0">
        <button
          onClick={() => setShowSearch(true)}
          className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-slate-800 transition-colors ${collapsed && !mobile ? 'justify-center' : ''}`}
          title={collapsed && !mobile ? 'Rechercher (⌘K)' : undefined}
        >
          <Search size={15} className="flex-shrink-0" />
          {(!collapsed || mobile) && (
            <>
              <span className="flex-1 text-left text-xs">Rechercher…</span>
              <kbd className="text-xs text-slate-300 bg-slate-700 px-1 py-0.5 rounded">⌘K</kbd>
            </>
          )}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-1 px-2 space-y-0.5">
        {filteredNavItems.map(item =>
          item.group
            ? <NavGroup key={item.group} {...item} collapsed={collapsed && !mobile} />
            : <NavItem key={item.to || item.href} {...item} collapsed={collapsed && !mobile} />
        )}
      </nav>

      {/* Bottom items */}
      <div className="border-t border-slate-800 py-2 px-2 space-y-0.5 flex-shrink-0">
        {bottomNavItems.map(item => {
          if (item.adminOnly && user?.role !== 'admin') return null
          return (
            <NavItem key={item.to} {...item} collapsed={collapsed && !mobile}
              badge={item.to === '/connectors' && anyRunning} />
          )
        })}
        {user?.role === 'admin' && (
          <NavItem to="/admin/agent" icon={Bot} label="Agent" collapsed={collapsed && !mobile} />
        )}
        {user?.role === 'admin' && (
          <NavItem to="/architecture" icon={Network} label="Architecture" collapsed={collapsed && !mobile} />
        )}
        {user?.role === 'admin' && (
          <NavItem to="/admin" icon={Settings} label="Paramètres" collapsed={collapsed && !mobile} />
        )}
        {/* User avatar with hover menu */}
        <div className="flex justify-start px-2 py-2 mt-1">
          <UserAvatarMenu user={user} roleLabel={roleLabel} onLogout={logout} hasUnseenNews={hasUnseenNews} />
        </div>
      </div>
    </div>
  )

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      {/* Desktop Sidebar */}
      <div className="hidden md:flex flex-shrink-0">
        {SidebarContent({})}
      </div>

      {/* Mobile sidebar */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="fixed inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <div className="fixed left-0 top-0 bottom-0 z-50 flex">
            {SidebarContent({ mobile: true })}
            <button
              onClick={() => setMobileOpen(false)}
              className="absolute top-4 right-4 text-white"
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
  )
}
