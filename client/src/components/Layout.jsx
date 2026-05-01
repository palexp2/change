import { useState, useEffect, useRef } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, Settings,
  ChevronLeft, ChevronRight, ChevronDown, LogOut, Menu, X,
  Search,
  TrendingUp, ShoppingCart, Package, LifeBuoy,
  ShoppingBag, Truck, RotateCcw, FileText, RefreshCw, Wrench,
  Barcode, MessageSquare, CheckSquare,
  Receipt, ReceiptText, Landmark, Users, Banknote, Contact, BookOpen,
  ArrowLeftRight, CreditCard, Clock, Tag, Wallet
} from 'lucide-react'
import { useAuth } from '../lib/auth.jsx'
import { useSyncStatus } from '../lib/useSyncStatus.js'
import { api } from '../lib/api.js'
import { prefetch } from '../lib/prefetch.js'
import { Modal } from './Modal.jsx'
import { GlobalSearch as CRMSearch } from './GlobalSearch.jsx'

// When the user hovers a nav link, kick off the page's primary list fetch.
// The request-level cache in prefetch.js keeps the in-flight promise, so the
// fetch fired on page mount (the real <NavLink> click) reuses it instead of
// re-hitting the server. Each entry mirrors the exact args the target page
// passes to its first api.*.list(...) call — ordering matters for the
// cache key (URLSearchParams preserves insertion order).
const NAV_PREFETCH = {
  '/interactions':  () => api.interactions.list({ limit: 'all', offset: 0 }),
  '/contacts':      () => api.contacts.list({ limit: 'all', page: 1 }),
  '/companies':     () => api.companies.list({ limit: 'all', page: 1 }),
  '/orders':        () => api.orders.list({ limit: 'all', page: 1 }),
  '/factures':      () => api.factures.list({ limit: 'all', page: 1 }),
  '/items-vendus':  () => api.stripeInvoiceItems.list({ limit: 'all', page: 1 }),
  '/retours':       () => api.retours.list({ limit: 'all', page: 1 }),
  '/products':      () => api.products.list({ limit: 'all', page: 1, active: true }),
  '/purchases':     () => api.purchases.list({ limit: 'all', page: 1 }),
  '/tickets':       () => api.tickets.list({ limit: 'all', page: 1 }),
  '/tasks':         () => api.tasks.list({ limit: 'all' }),
  '/abonnements':   () => api.abonnements.list({ limit: 'all', page: 1 }),
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

const defaultNavItems = [
  { to: '/dashboard',    icon: LayoutDashboard, label: 'Dashboard' },
  { group: 'Clients', icon: Contact, items: [
    { to: '/pipeline',     icon: TrendingUp,    label: 'Projets' },
    { to: '/tasks',        icon: CheckSquare,   label: 'Tâches' },
    { to: '/tickets',      icon: LifeBuoy,      label: 'Billets' },
    { to: '/interactions', icon: MessageSquare, label: 'Interactions' },
  ]},
  { group: 'Envois', icon: Truck, items: [
    { to: '/orders',   icon: ShoppingCart, label: 'Commandes' },
    { to: '/envois',   icon: Truck,        label: 'Envois' },
    { to: '/retours',  icon: RotateCcw,    label: 'Retours' },
  ]},
  { group: 'Comptabilité', icon: Landmark, items: [
    { to: '/factures',              icon: FileText,   label: 'Factures clients' },
    { to: '/items-vendus',          icon: Tag,        label: 'Items vendus' },
    { to: '/abonnements',           icon: RefreshCw,  label: 'Abonnements' },
    { to: '/achats-fournisseurs',   icon: Receipt,    label: 'Achats fournisseurs' },
    { to: '/sale-receipts',         icon: ReceiptText,label: 'Extraction de données' },
    { to: '/stripe-payouts',        icon: CreditCard, label: 'Stripe Payouts' },
    { to: '/journal-entries',       icon: BookOpen,   label: 'Écritures de journal' },
    { to: '/comptabilite/regles-serials', icon: BookOpen, label: 'Mouvements numéros de série' },
    { to: '/stock-movement',        icon: ArrowLeftRight, label: "Mouvements d'inventaire" },
  ]},
  { group: 'Inventaire', icon: Package, items: [
    { to: '/purchases',    icon: ShoppingBag, label: 'Achats' },
    { to: '/assemblages',  icon: Wrench,      label: 'Assemblages' },
    { to: '/products',     icon: Package,     label: 'Pièces/Produits' },
    { to: '/serials',      icon: Barcode,     label: 'Numéros de série' },
  ]},
  { group: 'RH', icon: Users, items: [
    { to: '/employees',        icon: Users,    label: 'Employés' },
    { to: '/feuille-de-temps', icon: Clock,    label: 'Feuille de temps' },
    { to: '/codes-activite',   icon: Tag,      label: "Codes d'activité" },
    { to: '/paies',            icon: Banknote, label: 'Paies' },
    { to: '/banque-heures',    icon: Wallet,   label: "Banque d'heures" },
  ]},
]

const bottomNavItems = []

function NavItem({ to, icon: Icon, label, collapsed, badge }) {
  const hover = useHoverPrefetch(to)
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

function UserAvatarMenu({ user, roleLabel, onLogout }) {
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
        onMouseEnter={openMenu}
        className="w-8 h-8 bg-gradient-to-br from-brand-500 to-emerald-700 rounded-full flex items-center justify-center cursor-pointer ring-2 ring-transparent hover:ring-brand-300/40 transition"
      >
        <span className="text-white text-xs font-semibold tracking-tight">{initials}</span>
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
          <button
            onClick={onLogout}
            className="flex items-center gap-2.5 w-full px-3 py-2 mt-1 mx-1 rounded-md text-sm text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
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
  const { user, logout } = useAuth()
  const { anyRunning } = useSyncStatus()

  // Raccourcis clavier globaux
  useEffect(() => {
    const SHORTCUTS = {
      d: '/dashboard',
      t: '/feuille-de-temps',
      b: '/tickets',
      p: '/pipeline',
      c: '/orders',
    }
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
      const target = SHORTCUTS[e.key.toLowerCase()]
      if (target) {
        e.preventDefault()
        navigate(target)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  // WebSocket global — notifications
  // Désactivé : nginx n'a pas de location /ws (ni /erp/ws) pour router l'upgrade
  // vers le backend, donc toutes les tentatives tombent en 404 et rebouclent
  // toutes les 5s. À réactiver quand la conf nginx aura un proxy WebSocket.
  useEffect(() => {
    if (!import.meta.env.VITE_REALTIME_ENABLED) return
    const token = localStorage.getItem('erp_token')
    if (!token) return
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    let ws
    let retryTimeout
    function connect() {
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`)
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }))
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'agent:task:updated') {
            window.dispatchEvent(new CustomEvent('agent:task:updated', { detail: msg.task }))
          }
          if (msg.type === 'agent:task:stream') {
            window.dispatchEvent(new CustomEvent('agent:task:stream', { detail: msg }))
          }
          if (msg.type === 'sync:progress') {
            window.dispatchEvent(new CustomEvent('sync:progress', { detail: msg }))
          }
        } catch {}
      }
      ws.onclose = () => { retryTimeout = setTimeout(connect, 5000) }
    }
    connect()
    return () => { ws?.close(); clearTimeout(retryTimeout) }
  }, [])

  const roleLabel = { admin: 'Admin', sales: 'Ventes', support: 'Support', ops: 'Opérations' }

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
        {defaultNavItems.map(item =>
          item.group
            ? <NavGroup key={item.group} {...item} collapsed={collapsed && !mobile} />
            : <NavItem key={item.to} {...item} collapsed={collapsed && !mobile} />
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
          <NavItem to="/admin" icon={Settings} label="Paramètres" collapsed={collapsed && !mobile} />
        )}
        {/* User avatar with hover menu */}
        <div className="flex justify-start px-2 py-2 mt-1">
          <UserAvatarMenu user={user} roleLabel={roleLabel} onLogout={logout} />
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
    </div>
  )
}
