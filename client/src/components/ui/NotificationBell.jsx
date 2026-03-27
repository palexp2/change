import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { api } from '../../lib/api.js'
import { formatRelativeTime } from '../../utils/formatters.js'

export function NotificationBell() {
  const [unreadCount, setUnreadCount] = useState(0)
  const [recent, setRecent] = useState([])
  const [showDropdown, setShowDropdown] = useState(false)
  const navigate = useNavigate()
  const dropdownRef = useRef(null)

  useEffect(() => { loadUnreadCount() }, [])

  useEffect(() => {
    function handleNewNotif() { setUnreadCount(c => c + 1); loadRecent() }
    window.addEventListener('new-notification', handleNewNotif)
    return () => window.removeEventListener('new-notification', handleNewNotif)
  }, [])

  useEffect(() => {
    if (!showDropdown) return
    function onClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setShowDropdown(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [showDropdown])

  async function loadUnreadCount() {
    try {
      const res = await api.notifications.list({ unread_only: 'true', limit: 1 })
      setUnreadCount(res.unread_count || 0)
    } catch {}
  }

  async function loadRecent() {
    try {
      const res = await api.notifications.list({ limit: 5 })
      setRecent(res.data || [])
    } catch {}
  }

  async function markRead(notif) {
    if (notif.read === 0) {
      await api.notifications.markRead(notif.id).catch(() => {})
      setUnreadCount(c => Math.max(0, c - 1))
    }
    if (notif.link) navigate(notif.link)
    setShowDropdown(false)
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => { setShowDropdown(s => !s); if (!showDropdown) loadRecent() }}
        className="relative p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
        title="Notifications">
        <Bell size={18} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {showDropdown && (
        <div className="absolute bottom-full mb-2 right-0 w-80 bg-white rounded-lg shadow-xl border z-50 overflow-hidden">
          <div className="px-4 py-3 border-b flex items-center justify-between">
            <span className="text-sm font-medium text-gray-900">Notifications</span>
            {unreadCount > 0 && <span className="text-xs text-gray-400">{unreadCount} non lue(s)</span>}
          </div>
          <div className="max-h-64 overflow-y-auto divide-y">
            {recent.length === 0 ? (
              <div className="py-6 text-center text-sm text-gray-400">Aucune notification</div>
            ) : recent.map(notif => (
              <button key={notif.id} onClick={() => markRead(notif)}
                className={`w-full text-left px-4 py-2.5 hover:bg-gray-50 ${notif.read === 0 ? 'bg-indigo-50/50' : ''}`}>
                <p className={`text-sm truncate ${notif.read === 0 ? 'font-medium text-gray-900' : 'text-gray-600'}`}>
                  {notif.title}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">{formatRelativeTime(notif.created_at)}</p>
              </button>
            ))}
          </div>
          <button onClick={() => { navigate('/notifications'); setShowDropdown(false) }}
            className="w-full text-center text-sm text-indigo-600 hover:bg-gray-50 py-2.5 border-t font-medium">
            Voir toutes les notifications
          </button>
        </div>
      )}
    </div>
  )
}
