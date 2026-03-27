import { useState, useEffect } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, Settings,
  ChevronLeft, ChevronRight, LogOut, Menu, X,
  KeyRound, Search, Plus, ChevronDown, ChevronUp, Database,
  Zap, Table2, Bot
} from 'lucide-react'
import { useAuth } from '../lib/auth.jsx'
import { useSyncStatus } from '../lib/useSyncStatus.js'
import { api } from '../lib/api.js'
import { baseAPI } from '../hooks/useBaseAPI.js'
import { Modal } from './Modal.jsx'
import { GlobalSearch as CRMSearch } from './GlobalSearch.jsx'
import { GlobalSearch as BaseSearch } from './ui/GlobalSearch.jsx'
import { NewTableModal } from './modals/NewTableModal.jsx'
import { DynamicIcon } from './ui/DynamicIcon.jsx'
import { NotificationBell } from './ui/NotificationBell.jsx'

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
]

const bottomNavItems = [
  { to: '/automations', icon: Zap, label: 'Automations' },
  { to: '/agent', icon: Bot, label: 'Agent', adminOnly: true },
]

function NavItem({ to, icon: Icon, label, collapsed, badge }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all
        ${isActive
          ? 'bg-indigo-600 text-white shadow-sm'
          : 'text-slate-400 hover:text-white hover:bg-slate-800'
        }
        ${collapsed ? 'justify-center' : ''}`
      }
      title={collapsed ? label : undefined}
    >
      <div className="relative flex-shrink-0">
        <Icon size={18} />
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

function BasesSection({ collapsed }) {
  const [tables, setTables] = useState([])
  const [expanded, setExpanded] = useState(true)
  const [showNewTable, setShowNewTable] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    baseAPI.tables()
      .then(res => setTables(res.tables || []))
      .catch(() => {})
  }, [location.pathname]) // refresh on navigation

  async function handleCreate(data) {
    const res = await baseAPI.createTable(data)
    setTables(prev => [...prev, res])
    navigate(`/tables/${res.slug || res.id}`)
  }

  if (collapsed) {
    return (
      <div className="px-2 py-2 border-t border-slate-800">
        <div className="flex items-center justify-center py-1">
          <Database size={16} className="text-slate-500" />
        </div>
        {tables.slice(0, 5).map(t => (
          <NavLink
            key={t.id}
            to={`/tables/${t.slug || t.id}`}
            className={({ isActive }) =>
              `flex items-center justify-center px-3 py-2.5 rounded-lg transition-all ${isActive ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`
            }
            title={t.name}
          >
            <DynamicIcon name={t.icon || 'Table2'} size={16} />
          </NavLink>
        ))}
      </div>
    )
  }

  return (
    <div className="border-t border-slate-800 py-2 px-2">
      <button
        onClick={() => setExpanded(s => !s)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wide hover:text-slate-300 transition-colors"
      >
        <Database size={13} />
        <span className="flex-1 text-left">Données</span>
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>

      {expanded && (
        <div className="space-y-0.5 mt-1">
          {tables.map(t => (
            <NavLink
              key={t.id}
              to={`/tables/${t.slug || t.id}`}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all
                ${isActive ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`
              }
            >
              <DynamicIcon name={t.icon || 'Table2'} size={15} />
              <span className="flex-1 truncate">{t.name}</span>
            </NavLink>
          ))}
          <button
            onClick={() => setShowNewTable(true)}
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-all w-full"
          >
            <Plus size={15} />
            <span>Nouvelle table</span>
          </button>
        </div>
      )}

      <NewTableModal open={showNewTable} onClose={() => setShowNewTable(false)} onCreate={handleCreate} />
    </div>
  )
}

function InterfacesSection({ collapsed, userRole, isAdmin }) {
  const [interfaces, setInterfaces] = useState([])
  const [expanded, setExpanded] = useState(true)
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    api.interfaces.list()
      .then(data => setInterfaces(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [location.pathname])

  if (collapsed) {
    return interfaces.length === 0 ? null : (
      <div className="px-2 py-2 border-t border-slate-800">
        {interfaces.slice(0, 5).map(iface => (
          <NavLink
            key={iface.id}
            to={`/interfaces/${iface.id}`}
            className={({ isActive }) =>
              `flex items-center justify-center px-3 py-2.5 rounded-lg transition-all ${isActive ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`
            }
            title={iface.name}
          >
            <DynamicIcon name={iface.icon || 'LayoutDashboard'} size={16} />
          </NavLink>
        ))}
      </div>
    )
  }

  return (
    <div className="border-t border-slate-800 py-2 px-2">
      <button
        onClick={() => setExpanded(s => !s)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wide hover:text-slate-300 transition-colors"
      >
        <LayoutDashboard size={13} />
        <span className="flex-1 text-left">Interfaces</span>
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>

      {expanded && (
        <div className="space-y-0.5 mt-1">
          {interfaces.map(iface => (
            <NavLink
              key={iface.id}
              to={`/interfaces/${iface.id}`}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all
                ${isActive ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`
              }
            >
              <DynamicIcon name={iface.icon || 'LayoutDashboard'} size={15} />
              <span className="flex-1 truncate">{iface.name}</span>
            </NavLink>
          ))}
          {isAdmin && (
            <button
              onClick={() => navigate('/interfaces')}
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-all w-full"
            >
              <Plus size={15} />
              <span>Gérer les interfaces</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function Layout({ children }) {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [showChangePw, setShowChangePw] = useState(false)
  const [showSearch, setShowSearch] = useState(false)    // CRM search
  const [showBaseSearch, setShowBaseSearch] = useState(false) // Base records search
  const { user, logout } = useAuth()
  const { anyRunning } = useSyncStatus()

  // Cmd+K → open base records search (unless focus is in an input)
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        const tag = document.activeElement?.tagName
        if ((tag === 'INPUT' || tag === 'TEXTAREA') && !showBaseSearch) return
        e.preventDefault()
        setShowBaseSearch(s => !s)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showBaseSearch])

  // WebSocket global — écouter les notifications
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
        } catch {}
      }
      ws.onclose = () => { retryTimeout = setTimeout(connect, 5000) }
    }
    connect()
    return () => { ws?.close(); clearTimeout(retryTimeout) }
  }, [])

  const roleLabel = { admin: 'Admin', sales: 'Ventes', support: 'Support', ops: 'Opérations' }

  const SidebarContent = ({ mobile = false }) => (
    <div className={`flex flex-col h-full bg-slate-900 ${mobile ? 'w-72' : collapsed ? 'w-16' : 'w-60'} transition-all duration-200`}>
      {/* Logo */}
      <div className={`flex items-center h-16 px-4 border-b border-slate-800 flex-shrink-0 ${collapsed && !mobile ? 'justify-center' : 'gap-3'}`}>
        <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center flex-shrink-0">
          <span className="text-white font-bold text-sm">O</span>
        </div>
        {(!collapsed || mobile) && (
          <div>
            <div className="text-white font-semibold text-sm leading-tight">Orisha</div>
            <div className="text-slate-500 text-xs">ERP System</div>
          </div>
        )}
        {!mobile && (
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="ml-auto text-slate-500 hover:text-white p-1 rounded transition-colors"
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        )}
      </div>

      {/* Search */}
      <div className="px-2 pt-3 pb-1 flex-shrink-0">
        <button
          onClick={() => setShowSearch(true)}
          className={`flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-slate-800 transition-colors ${collapsed && !mobile ? 'justify-center' : ''}`}
          title={collapsed && !mobile ? 'Rechercher (⌘K)' : undefined}
        >
          <Search size={18} className="flex-shrink-0" />
          {(!collapsed || mobile) && (
            <>
              <span className="flex-1 text-left">Rechercher…</span>
              <kbd className="text-xs text-slate-600 bg-slate-800 px-1 py-0.5 rounded">⌘K</kbd>
            </>
          )}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
        {navItems.map(item => (
          <NavItem key={item.to} {...item} collapsed={collapsed && !mobile} />
        ))}
      </nav>

      {/* Dynamic tables (Données) */}
      <BasesSection collapsed={collapsed && !mobile} />

      {/* Interfaces */}
      <InterfacesSection
        collapsed={collapsed && !mobile}
        userRole={user?.role}
        isAdmin={user?.role === 'admin'}
      />

      {/* Bottom items */}
      <div className="border-t border-slate-800 py-3 px-2 space-y-0.5 flex-shrink-0">
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
        <div className={`flex items-center gap-3 px-3 py-2.5 rounded-lg mt-1 ${collapsed && !mobile ? 'justify-center' : ''}`}>
          <div className="w-7 h-7 bg-indigo-500 rounded-full flex items-center justify-center flex-shrink-0">
            <span className="text-white text-xs font-semibold">{user?.name?.[0]?.toUpperCase() || 'U'}</span>
          </div>
          {(!collapsed || mobile) && (
            <div className="flex-1 min-w-0">
              <div className="text-white text-xs font-medium truncate">{user?.name}</div>
              <div className="text-slate-500 text-xs">{roleLabel[user?.role] || user?.role}</div>
            </div>
          )}
          {(!collapsed || mobile) && (
            <div className="flex items-center gap-0.5 flex-shrink-0">
              <NotificationBell />
              <button
                onClick={() => setShowChangePw(true)}
                className="text-slate-500 hover:text-white p-1 rounded transition-colors"
                title="Changer mon mot de passe"
              >
                <KeyRound size={14} />
              </button>
              <button
                onClick={logout}
                className="text-slate-500 hover:text-white p-1 rounded transition-colors"
                title="Déconnexion"
              >
                <LogOut size={14} />
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
          <div className="w-6 h-6 bg-indigo-600 rounded flex items-center justify-center mr-2">
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
      {showBaseSearch && <BaseSearch onClose={() => setShowBaseSearch(false)} />}
    </div>
  )
}
