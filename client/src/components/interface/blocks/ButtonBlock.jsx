import { useState } from 'react'
import { baseAPI } from '../../../hooks/useBaseAPI.js'
import { useToast } from '../../ui/ToastProvider.jsx'
import { DynamicIcon } from '../../ui/DynamicIcon.jsx'
import { api } from '../../../lib/api.js'

const COLOR_CLASSES = {
  indigo: 'bg-indigo-600 hover:bg-indigo-700 text-white',
  green:  'bg-green-600 hover:bg-green-700 text-white',
  red:    'bg-red-600 hover:bg-red-700 text-white',
  orange: 'bg-orange-500 hover:bg-orange-600 text-white',
  purple: 'bg-purple-600 hover:bg-purple-700 text-white',
  gray:   'bg-gray-600 hover:bg-gray-700 text-white',
}

export default function ButtonBlock({ config, selectedRecord }) {
  const [loading, setLoading] = useState(false)
  const { addToast } = useToast()

  const isDisabled = config.action_type === 'update_field' && !selectedRecord

  async function handleClick() {
    setLoading(true)
    try {
      switch (config.action_type) {
        case 'update_field':
          if (!selectedRecord) return
          await baseAPI.updateRecord(
            config.table_id,
            selectedRecord.id,
            { data: { [config.target_field_key]: config.target_value } }
          )
          addToast({ message: 'Enregistrement mis à jour', type: 'success' })
          break
        case 'run_automation':
          await api.automations.run(config.automation_id)
          addToast({ message: 'Automation déclenchée', type: 'success' })
          break
        case 'open_url':
          if (config.url) window.open(config.url, '_blank')
          break
        default:
          addToast({ message: 'Action non configurée', type: 'error' })
      }
    } catch (err) {
      addToast({ message: err.message || 'Erreur', type: 'error' })
    }
    setLoading(false)
  }

  return (
    <div className="flex items-center justify-center h-full">
      <button
        onClick={handleClick}
        disabled={isDisabled || loading}
        className={`px-5 py-2.5 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors disabled:opacity-40 ${
          COLOR_CLASSES[config.color] || COLOR_CLASSES.indigo
        }`}
      >
        {config.icon && <DynamicIcon name={config.icon} size={16} />}
        {loading ? 'En cours…' : config.label || 'Bouton'}
      </button>
    </div>
  )
}
