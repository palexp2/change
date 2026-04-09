import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Layout } from '../components/Layout.jsx'
import { ArrowLeft, Play, ChevronDown } from 'lucide-react'
import { useToast } from '../contexts/ToastContext.jsx'
import { api } from '../lib/api.js'

export default function AutomationDetail() {
  const { id } = useParams()
  const isNew = id === 'new'
  const navigate = useNavigate()
  const { addToast } = useToast()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [active, setActive] = useState(true)
  const [triggerType, setTriggerType] = useState('manual')
  const [triggerConfig, setTriggerConfig] = useState({})
  const [script, setScript] = useState('')
  const [logs, setLogs] = useState([])
  const [testResult, setTestResult] = useState(null)
  const [testRunning, setTestRunning] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (isNew) return
    api.automations.get(id).then(auto => {
      setName(auto.name)
      setDescription(auto.description || '')
      setActive(!!auto.active)
      setTriggerType(auto.trigger_type)
      setTriggerConfig(JSON.parse(auto.trigger_config || '{}'))
      setScript(auto.script || '')
    }).catch(() => addToast({ message: 'Erreur de chargement', type: 'error' }))
    loadLogs()
  }, [id])

  async function loadLogs() {
    const data = await api.automations.logs(id).catch(() => [])
    setLogs(data)
  }

  async function handleSave() {
    if (!name.trim()) { addToast({ message: 'Nom requis', type: 'error' }); return }
    setSaving(true)
    const body = {
      name: name.trim(), description, active: active ? 1 : 0,
      trigger_type: triggerType,
      trigger_config: JSON.stringify(triggerConfig),
      script,
    }
    try {
      if (isNew) {
        const res = await api.automations.create(body)
        addToast({ message: 'Automation créée', type: 'success' })
        navigate(`/automations/${res.id}`)
      } else {
        await api.automations.update(id, body)
        addToast({ message: 'Automation enregistrée', type: 'success' })
      }
    } catch (e) {
      addToast({ message: e.message || 'Erreur de sauvegarde', type: 'error' })
    }
    setSaving(false)
  }

  async function handleTest() {
    setTestRunning(true)
    setTestResult(null)
    try {
      const res = await api.automations.run(id)
      setTestResult(res)
      loadLogs()
    } catch (e) {
      setTestResult({ status: 'error', error: e.message })
    }
    setTestRunning(false)
  }

  async function handleDelete() {
    if (!confirm(`Supprimer l'automation "${name}" ?`)) return
    await api.automations.delete(id).catch(() => {})
    addToast({ message: 'Automation supprimée', type: 'success' })
    navigate('/automations')
  }

  return (
    <Layout>
      <div className="p-6 max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/automations')} className="text-gray-400 hover:text-gray-600">
              <ArrowLeft size={20} />
            </button>
            <h1 className="text-xl font-semibold">{isNew ? 'Nouvelle automation' : name}</h1>
          </div>
          <div className="flex gap-2">
            {!isNew && (
              <button onClick={handleDelete}
                className="px-3 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50">
                Supprimer
              </button>
            )}
            <button onClick={handleSave} disabled={saving}
              className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
              {saving ? 'Enregistrement...' : 'Enregistrer'}
            </button>
          </div>
        </div>

        {/* Infos générales */}
        <div className="bg-white rounded-lg border p-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nom</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="Mon automation" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Statut</label>
              <label className="flex items-center gap-2 mt-2 cursor-pointer">
                <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
                <span className="text-sm">{active ? 'Activée' : 'Désactivée'}</span>
              </label>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="Optionnel" />
          </div>
        </div>

        {/* Trigger */}
        <div className="bg-white rounded-lg border p-5">
          <h2 className="text-sm font-semibold mb-4">Déclencheur</h2>
          <TriggerConfig
            triggerType={triggerType}
            triggerConfig={triggerConfig}
            onTypeChange={setTriggerType}
            onConfigChange={setTriggerConfig}
          />
        </div>

        {/* Script */}
        <div className="bg-white rounded-lg border p-5">
          <h2 className="text-sm font-semibold mb-2">Script</h2>
          <p className="text-xs text-gray-500 mb-3">
            Variables : <code className="bg-gray-100 px-1 rounded">record</code>, <code className="bg-gray-100 px-1 rounded">table</code>.{' '}
            Fonctions : <code className="bg-gray-100 px-1 rounded">updateRecord(id, data)</code>,{' '}
            <code className="bg-gray-100 px-1 rounded">createRecord(tableId, data)</code>,{' '}
            <code className="bg-gray-100 px-1 rounded">getRecords(tableId, filters)</code>,{' '}
            <code className="bg-gray-100 px-1 rounded">fetch(url, options)</code>,{' '}
            <code className="bg-gray-100 px-1 rounded">log(message)</code>.
            Timeout : 10 secondes.
          </p>
          <textarea value={script} onChange={e => setScript(e.target.value)}
            rows={12}
            className="w-full border rounded-lg px-4 py-3 font-mono text-sm bg-gray-900 text-green-400 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            placeholder={"// Votre script ici...\nlog('Hello from automation!')\n\nif (record) {\n  updateRecord(record.id, { status: 'Traité' })\n}"} />
        </div>

        {/* Test + Résultat */}
        {!isNew && (
          <div className="bg-white rounded-lg border p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold">Tester</h2>
              <button onClick={handleTest} disabled={testRunning}
                className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1.5">
                {testRunning ? (
                  <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> Exécution...</>
                ) : (
                  <><Play size={14} /> Exécuter</>
                )}
              </button>
            </div>
            {testResult && (
              <div className={`p-4 rounded-lg text-sm font-mono ${
                testResult.status === 'success' ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'
              }`}>
                <div className="flex items-center gap-2 mb-2">
                  <span className={testResult.status === 'success' ? 'text-green-700 font-medium' : 'text-red-700 font-medium'}>
                    {testResult.status === 'success' ? '✓ Succès' : '✗ Erreur'}
                  </span>
                  {testResult.duration_ms != null && (
                    <span className="text-gray-500 text-xs">{testResult.duration_ms}ms</span>
                  )}
                </div>
                {testResult.output && <pre className="text-xs text-gray-600 whitespace-pre-wrap">{testResult.output}</pre>}
                {testResult.error && <pre className="text-xs text-red-600 whitespace-pre-wrap">{testResult.error}</pre>}
              </div>
            )}
          </div>
        )}

        {/* Logs */}
        {!isNew && (
          <div className="bg-white rounded-lg border p-5">
            <h2 className="text-sm font-semibold mb-4">Dernières exécutions</h2>
            <AutomationLogs logs={logs} />
          </div>
        )}
      </div>
    </Layout>
  )
}

function TriggerConfig({ triggerType, triggerConfig, onTypeChange, onConfigChange }) {
  const CRON_PRESETS = [
    { label: 'Chaque minute', value: '* * * * *' },
    { label: 'Toutes les 5min', value: '*/5 * * * *' },
    { label: 'Toutes les heures', value: '0 * * * *' },
    { label: 'Chaque jour à 8h', value: '0 8 * * *' },
    { label: 'Lundi à 9h', value: '0 9 * * 1' },
    { label: '1er du mois 7h', value: '0 7 1 * *' },
  ]

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
        <select value={triggerType} onChange={e => { onTypeChange(e.target.value); onConfigChange({}) }}
          className="w-full border rounded-lg px-3 py-2 text-sm">
          <option value="schedule">Planifié (cron)</option>
          <option value="manual">Déclenchement manuel</option>
        </select>
      </div>

      {triggerType === 'schedule' && (
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Expression cron</label>
            <input type="text" value={triggerConfig.cron || ''}
              onChange={e => onConfigChange({ ...triggerConfig, cron: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
              placeholder="0 8 * * *" />
          </div>
          <div className="flex flex-wrap gap-2">
            {CRON_PRESETS.map(p => (
              <button key={p.value}
                onClick={() => onConfigChange({ ...triggerConfig, cron: p.value })}
                className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                  triggerConfig.cron === p.value
                    ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                    : 'border-gray-200 text-gray-500 hover:border-gray-300'
                }`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {triggerType === 'manual' && (
        <p className="text-sm text-gray-500 italic">
          Cette automation se déclenche uniquement via le bouton "Exécuter" ou via l'API.
        </p>
      )}
    </div>
  )
}

function AutomationLogs({ logs }) {
  const [expandedId, setExpandedId] = useState(null)

  if (logs.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-4">Aucune exécution</p>
  }

  return (
    <div className="divide-y border rounded-lg overflow-hidden">
      {logs.slice(0, 20).map(log => (
        <div key={log.id}>
          <button
            onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
            className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-gray-50 text-left">
            <span className={`w-2 h-2 rounded-full shrink-0 ${
              log.status === 'success' ? 'bg-green-500' :
              log.status === 'error' ? 'bg-red-500' : 'bg-yellow-500'
            }`} />
            <span className="text-gray-500 text-xs w-36 shrink-0">
              {new Date(log.created_at).toLocaleString('fr-CA')}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              log.status === 'success' ? 'bg-green-100 text-green-700' :
              log.status === 'error' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'
            }`}>
              {log.status === 'success' ? 'Succès' : log.status === 'error' ? 'Erreur' : 'En cours'}
            </span>
            {log.duration_ms != null && (
              <span className="text-xs text-gray-400 ml-auto">{log.duration_ms}ms</span>
            )}
            <ChevronDown size={14} className={`text-gray-400 transition-transform ${expandedId === log.id ? 'rotate-180' : ''}`} />
          </button>
          {expandedId === log.id && (
            <div className="px-4 py-3 bg-gray-50 border-t">
              {log.result && (
                <div className="mb-2">
                  <span className="text-xs font-medium text-gray-500">Output :</span>
                  <pre className="text-xs text-gray-600 mt-1 whitespace-pre-wrap font-mono bg-white p-2 rounded border">
                    {log.result}
                  </pre>
                </div>
              )}
              {log.error && (
                <div>
                  <span className="text-xs font-medium text-red-500">Erreur :</span>
                  <pre className="text-xs text-red-600 mt-1 whitespace-pre-wrap font-mono bg-white p-2 rounded border border-red-200">
                    {log.error}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
