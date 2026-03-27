import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Layout } from '../components/Layout.jsx'
import { DynamicIcon } from '../components/ui/DynamicIcon.jsx'
import { NewInterfaceModal } from '../components/modals/NewInterfaceModal.jsx'
import { useAuth } from '../lib/auth.jsx'
import api from '../lib/api.js'
import { Plus, LayoutDashboard } from 'lucide-react'

export default function Interfaces() {
  const [interfaces, setInterfaces] = useState([])
  const [showNew, setShowNew] = useState(false)
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  useEffect(() => { load() }, [])

  async function load() {
    try {
      const data = await api.interfaces.list()
      setInterfaces(Array.isArray(data) ? data : [])
    } catch {}
  }

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <LayoutDashboard size={22} /> Interfaces
          </h1>
          {isAdmin && (
            <button
              onClick={() => setShowNew(true)}
              className="flex items-center gap-1.5 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            >
              <Plus size={14} /> Nouvelle interface
            </button>
          )}
        </div>

        {interfaces.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <LayoutDashboard size={40} className="mx-auto mb-3 opacity-50" />
            <p className="text-sm">Aucune interface. Créez votre premier dashboard.</p>
            {isAdmin && (
              <button
                onClick={() => setShowNew(true)}
                className="mt-4 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
              >
                Créer une interface
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {interfaces.map(iface => (
              <button
                key={iface.id}
                onClick={() => navigate(`/interfaces/${iface.id}`)}
                className="bg-white rounded-xl border p-5 text-left hover:shadow-md hover:border-indigo-200 transition-all group"
              >
                <div className={`w-10 h-10 rounded-lg bg-${iface.color || 'indigo'}-100 flex items-center justify-center mb-3`}>
                  <DynamicIcon
                    name={iface.icon || 'LayoutDashboard'}
                    size={20}
                    className={`text-${iface.color || 'indigo'}-600`}
                  />
                </div>
                <h3 className="font-semibold text-gray-800 group-hover:text-indigo-600">{iface.name}</h3>
                <p className="text-xs text-gray-400 mt-1">{iface.page_count || 1} page(s)</p>
              </button>
            ))}
          </div>
        )}

        {showNew && (
          <NewInterfaceModal
            onClose={() => setShowNew(false)}
            onCreated={iface => navigate(`/interfaces/${iface.id}`)}
          />
        )}
      </div>
    </Layout>
  )
}
