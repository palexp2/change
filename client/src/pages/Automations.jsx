import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Layout } from '../components/Layout.jsx'
import { Zap, Plus, ChevronRight } from 'lucide-react'
import { useToast } from '../contexts/ToastContext.jsx'
import { api } from '../lib/api.js'

const TRIGGER_LABELS = {
  record_created: 'Record créé',
  record_updated: 'Record modifié',
  field_changed:  'Champ changé',
  schedule:       'Planifié',
  manual:         'Manuel',
}

function formatRelative(dateStr) {
  if (!dateStr) return '—'
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'à l\'instant'
  if (mins < 60) return `il y a ${mins}min`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `il y a ${hrs}h`
  return `il y a ${Math.floor(hrs / 24)}j`
}

export default function Automations() {
  const [automations, setAutomations] = useState([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()
  const { addToast } = useToast()

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const data = await api.automations.list()
      setAutomations(data)
    } catch (e) {
      addToast({ message: 'Erreur de chargement', type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  async function toggleActive(auto, e) {
    e.stopPropagation()
    try {
      await api.automations.update(auto.id, { active: auto.active ? 0 : 1 })
      load()
    } catch {
      addToast({ message: 'Erreur', type: 'error' })
    }
  }

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Zap size={22} /> Automations
          </h1>
          <button onClick={() => navigate('/automations/new')}
            className="flex items-center gap-1.5 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
            <Plus size={14} /> Nouvelle automation
          </button>
        </div>

        <div className="bg-white rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Nom</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Trigger</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Statut</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Dernier run</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Résultat</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {automations.map(auto => (
                <tr key={auto.id} className="hover:bg-gray-50 cursor-pointer"
                  onClick={() => navigate(`/automations/${auto.id}`)}>
                  <td className="px-4 py-3 font-medium">{auto.name}</td>
                  <td className="px-4 py-3 text-gray-500">{TRIGGER_LABELS[auto.trigger_type] || auto.trigger_type}</td>
                  <td className="px-4 py-3">
                    <button onClick={(e) => toggleActive(auto, e)}
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${
                        auto.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                      }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${auto.active ? 'bg-green-500' : 'bg-gray-400'}`} />
                      {auto.active ? 'Actif' : 'Inactif'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{formatRelative(auto.last_run_at)}</td>
                  <td className="px-4 py-3">
                    {auto.last_run_status && (
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        auto.last_run_status === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                      }`}>
                        {auto.last_run_status === 'success' ? 'Succès' : 'Erreur'}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3"><ChevronRight size={16} className="text-gray-400" /></td>
                </tr>
              ))}
              {!loading && automations.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-400">
                    Aucune automation. Créez-en une pour automatiser vos processus.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  )
}
