import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Layout } from '../components/Layout.jsx'
import { Bell } from 'lucide-react'
import { useToast } from '../components/ui/ToastProvider.jsx'
import { api } from '../lib/api.js'
import { formatRelativeTime } from '../utils/formatters.js'

export default function Notifications() {
  const [notifications, setNotifications] = useState([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const navigate = useNavigate()
  const { addToast } = useToast()

  useEffect(() => { load() }, [page])

  async function load() {
    setLoading(true)
    try {
      const res = await api.notifications.list({ limit: 20, page })
      setNotifications(res.data || [])
      setTotal(res.total || 0)
    } catch {
      addToast({ message: 'Erreur de chargement', type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  async function handleMarkAllRead() {
    await api.notifications.markAllRead().catch(() => {})
    load()
    addToast({ message: 'Toutes les notifications marquées comme lues', type: 'success' })
  }

  async function handleClick(notif) {
    if (notif.read === 0) {
      await api.notifications.markRead(notif.id).catch(() => {})
      setNotifications(prev => prev.map(n => n.id === notif.id ? { ...n, read: 1 } : n))
    }
    if (notif.link) navigate(notif.link)
  }

  return (
    <Layout>
      <div className="p-6 max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Bell size={22} /> Notifications
          </h1>
          <button onClick={handleMarkAllRead}
            className="text-sm text-indigo-600 hover:text-indigo-700 font-medium">
            Tout marquer comme lu
          </button>
        </div>

        <div className="bg-white rounded-lg border divide-y">
          {!loading && notifications.length === 0 && (
            <div className="py-12 text-center text-sm text-gray-400">Aucune notification</div>
          )}
          {notifications.map(notif => (
            <button key={notif.id} onClick={() => handleClick(notif)}
              className={`w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-gray-50 ${notif.read === 0 ? 'bg-indigo-50/50' : ''}`}>
              <Bell size={16} className={`mt-0.5 shrink-0 ${notif.read === 0 ? 'text-indigo-500' : 'text-gray-400'}`} />
              <div className="flex-1 min-w-0">
                <p className={`text-sm ${notif.read === 0 ? 'font-medium text-gray-800' : 'text-gray-600'}`}>
                  {notif.title}
                </p>
                {notif.body && <p className="text-xs text-gray-400 mt-0.5 truncate">{notif.body}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-gray-400">{formatRelativeTime(notif.created_at)}</span>
                {notif.read === 0 && <span className="w-2 h-2 bg-indigo-500 rounded-full" />}
              </div>
            </button>
          ))}
        </div>

        {total > 20 && (
          <div className="flex justify-center gap-2 mt-4">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
              className="px-3 py-1.5 text-sm border rounded disabled:opacity-50 hover:bg-gray-50">Précédent</button>
            <span className="px-3 py-1.5 text-sm text-gray-500">Page {page}</span>
            <button onClick={() => setPage(p => p + 1)} disabled={page * 20 >= total}
              className="px-3 py-1.5 text-sm border rounded disabled:opacity-50 hover:bg-gray-50">Suivant</button>
          </div>
        )}
      </div>
    </Layout>
  )
}
