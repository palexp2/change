import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { api } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { fmtDateTime } from '../lib/formatDate.js'

// Mise en service de la cloche : les anciennes notifications, jamais vues
// faute d'affichage, restent de côté.
const SINCE = '2026-10-10'

// Le corps peut être un message Slack : on retire ses marques (*gras*, :emoji:).
const plain = (s) => (s || '').replace(/:[a-z0-9_+-]+:\s?/g, '').replace(/\*([^*\n]+)\*/g, '$1')

// Cloche de la barre de gauche. `compact` : dans le rail, l'icône seule.
export function NotificationBell({ compact = false }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [items, setItems] = useState([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const triggerRef = useRef(null)
  const panelRef = useRef(null)

  const load = useCallback(() => {
    api.notifications.list(SINCE)
      .then(r => { setItems(r.data || []); setUnread(r.unread_count || 0) })
      .catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])
  useRealtimeChannel(user?.id ? `notifications:user:${user.id}` : null, (msg) => {
    if (msg.type === 'notification:created') load()
  })

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target) || triggerRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function toggle() {
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setPos({ bottom: Math.max(8, window.innerHeight - r.bottom), left: r.right + 8 })
    setOpen(o => !o)
  }

  function openItem(n) {
    if (!n.read) {
      api.notifications.read(n.id).catch(() => {})
      setItems(list => list.map(x => x.id === n.id ? { ...x, read: 1 } : x))
      setUnread(c => Math.max(0, c - 1))
    }
    if (n.link) { setOpen(false); navigate(n.link) }
  }

  function readAll() {
    api.notifications.readAll().catch(() => {})
    setItems(list => list.map(x => ({ ...x, read: 1 })))
    setUnread(0)
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={toggle}
        title="Notifications"
        aria-label="Notifications"
        data-testid="notification-bell"
        className={`relative flex items-center rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors
          ${compact ? 'justify-center w-9 h-9' : 'gap-2.5 w-full px-2.5 py-1.5 text-[13px]'}`}
      >
        <Bell size={compact ? 17 : 15} />
        {!compact && <span className="flex-1 text-left">Notifications</span>}
        {unread > 0 && (
          <span className={`${compact ? 'absolute -top-0.5 -right-0.5' : ''} min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold flex items-center justify-center`}>
            {unread}
          </span>
        )}
      </button>

      {open && pos && (
        <div
          ref={panelRef}
          className="fixed z-[200] w-96 max-w-[calc(100vw-1rem)] max-h-[70vh] overflow-y-auto bg-white rounded-xl shadow-xl border border-slate-200"
          style={pos}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 sticky top-0 bg-white">
            <span className="text-sm font-medium text-slate-800">Notifications</span>
            {unread > 0 && (
              <button onClick={readAll} className="text-xs text-slate-500 hover:text-slate-800">Tout lu</button>
            )}
          </div>
          {items.length === 0 && <div className="px-3 py-6 text-center text-sm text-slate-400">Rien</div>}
          {items.map(n => (
            <button
              key={n.id}
              onClick={() => openItem(n)}
              className={`block w-full text-left px-3 py-2.5 border-b border-slate-100 last:border-0 hover:bg-slate-50 ${n.read ? '' : 'bg-brand-50/40'}`}
            >
              <div className="flex items-start gap-2">
                {!n.read && <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-brand-500 flex-shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-slate-800">{n.title}</div>
                  {n.body && <div className="mt-1 text-xs text-slate-600 whitespace-pre-wrap break-words">{plain(n.body)}</div>}
                  <div className="mt-1 text-[11px] text-slate-400">{fmtDateTime(n.created_at)}</div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  )
}
