import { useState, useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, Settings,
  ChevronLeft, ChevronRight, LogOut, Menu, X,
  KeyRound, Search,
  TrendingUp, ShoppingCart, Package, LifeBuoy,
  ShoppingBag, Truck, RotateCcw, FileText, RefreshCw, Wrench,
  Barcode, MessageSquare, Plug, Zap, Bot, CheckSquare,
  Receipt, CreditCard, ReceiptText
} from 'lucide-react'
import { useAuth } from '../lib/auth.jsx'
import { useSyncStatus } from '../lib/useSyncStatus.js'
import { api } from '../lib/api.js'
import { Modal } from './Modal.jsx'
import { GlobalSearch as CRMSearch } from './GlobalSearch.jsx'
import { NotificationBell } from './ui/NotificationBell.jsx'

const defaultNavItems = [
  { to: '/dashboard',    icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/pipeline',     icon: TrendingUp,      label: 'Projets' },
  { to: '/orders',       icon: ShoppingCart,     label: 'Commandes' },
  { to: '/factures',              icon: FileText,    label: 'Factures' },
  { to: '/abonnements',           icon: RefreshCw,   label: 'Abonnements' },
  { to: '/factures-fournisseurs', icon: Receipt,      label: 'Fact. fournisseurs' },
  { to: '/depenses',              icon: CreditCard,  label: 'Dépenses' },
  { to: '/sale-receipts',         icon: ReceiptText, label: 'Reçus de vente' },
  { to: '/purchases',    icon: ShoppingBag,     label: 'Achats' },
  { to: '/envois',       icon: Truck,           label: 'Envois' },
  { to: '/retours',      icon: RotateCcw,       label: 'Retours' },
  { to: '/assemblages',  icon: Wrench,          label: 'Assemblages' },
  { to: '/products',     icon: Package,         label: 'Produits' },
  { to: '/serials',      icon: Barcode,         label: 'Numéros de série' },
  { to: '/tasks',        icon: CheckSquare,     label: 'Tâches' },
  { to: '/tickets',      icon: LifeBuoy,        label: 'Billets' },
  { to: '/interactions', icon: MessageSquare,    label: 'Interactions' },
]

const bottomNavItems = [
  { to: '/connectors', icon: Plug, label: 'Connecteurs', adminOnly: false },
  { to: '/automations', icon: Zap,  label: 'Automations' },
  { to: '/agent',       icon: Bot,  label: 'Agent', adminOnly: true },
]

function NavItem({ to, icon: Icon, label, collapsed, badge }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all
        ${isActive
          ? 'bg-indigo-600 text-white shadow-sm'
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
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [showChangePw, setShowChangePw] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [navConfig, setNavConfig] = useState(null)
  const { user, logout } = useAuth()
  const { anyRunning } = useSyncStatus()

  // Load nav config (custom labels + order)
  useEffect(() => {
    function loadNav() {
      api.admin.getNavConfig()
        .then(({ nav_items }) => setNavConfig(nav_items))
        .catch(() => {})
    }
    loadNav()
    window.addEventListener('nav:updated', loadNav)
    return () => window.removeEventListener('nav:updated', loadNav)
  }, [])

  // Cmd+K → recherche globale
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        const tag = document.activeElement?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        setShowSearch(s => !s)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // WebSocket global — notifications
  useEffect(() => {
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
          if (msg.type === 'notification') {
            window.dispatchEvent(new CustomEvent('new-notification', { detail: msg.notification }))
          }
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
      <div className={`flex items-center h-14 px-4 border-b border-slate-800 flex-shrink-0 ${collapsed && !mobile ? 'justify-center' : 'gap-3'}`}>
        <div className="w-7 h-7 bg-gradient-to-br from-indigo-500 to-violet-600 rounded-lg flex items-center justify-center flex-shrink-0 shadow-md shadow-indigo-900/40">
          <span className="text-white font-bold text-xs">O</span>
        </div>
        {(!collapsed || mobile) && (
          <div>
            <div className="text-white font-semibold text-sm leading-tight">Orisha</div>
            <div className="text-slate-400 text-xs">ERP</div>
          </div>
        )}
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
        {(() => {
          // Merge default items with custom config (labels + order + visibility)
          if (navConfig) {
            const itemMap = new Map(defaultNavItems.map(i => [i.to, i]))
            const configuredTos = new Set(navConfig.map(nc => nc.to))
            const configuredItems = navConfig
              .filter(nc => nc.visible !== false)
              .map(nc => {
                const item = itemMap.get(nc.to)
                if (!item) return null
                return <NavItem key={nc.to} {...item} label={nc.label || item.label} collapsed={collapsed && !mobile} />
              })
              .filter(Boolean)
            const newItems = defaultNavItems
              .filter(i => !configuredTos.has(i.to))
              .map(item => <NavItem key={item.to} {...item} collapsed={collapsed && !mobile} />)
            return [...configuredItems, ...newItems]
          }
          return defaultNavItems.map(item => (
            <NavItem key={item.to} {...item} collapsed={collapsed && !mobile} />
          ))
        })()}
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
        {/* User info */}
        <div className={`flex items-center gap-2.5 px-3 py-2 rounded-lg mt-1 ${collapsed && !mobile ? 'justify-center' : ''}`}>
          <div className="w-6 h-6 bg-gradient-to-br from-indigo-400 to-violet-500 rounded-full flex items-center justify-center flex-shrink-0">
            <span className="text-white text-xs font-semibold">{user?.name?.[0]?.toUpperCase() || 'U'}</span>
          </div>
          {(!collapsed || mobile) && (
            <div className="flex-1 min-w-0">
              <div className="text-white text-xs font-medium truncate">{user?.name}</div>
              <div className="text-slate-400 text-xs">{roleLabel[user?.role] || user?.role}</div>
            </div>
          )}
          {(!collapsed || mobile) && (
            <div className="flex items-center gap-0.5 flex-shrink-0">
              <NotificationBell />
              <button
                onClick={() => setShowChangePw(true)}
                className="text-slate-400 hover:text-white p-1 rounded transition-colors"
                title="Changer mon mot de passe"
              >
                <KeyRound size={13} />
              </button>
              <button
                onClick={logout}
                className="text-slate-400 hover:text-white p-1 rounded transition-colors"
                title="Déconnexion"
              >
                <LogOut size={13} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      {/* Desktop Sidebar */}
      <div className="hidden md:flex flex-shrink-0">
        <SidebarContent />
      </div>

      {/* Mobile sidebar */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="fixed inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <div className="fixed left-0 top-0 bottom-0 z-50 flex">
            <SidebarContent mobile />
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
          <div className="w-6 h-6 bg-gradient-to-br from-indigo-500 to-violet-600 rounded flex items-center justify-center mr-2">
            <span className="text-white font-bold text-xs">O</span>
          </div>
          <span className="font-semibold text-slate-900">Orisha ERP</span>
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
