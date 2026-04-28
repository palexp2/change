import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { Layout } from '../components/Layout.jsx'
import { ArrowLeft, Play, ChevronDown, Lock, FlaskConical, Mail, Zap, RotateCcw, X, Eye, RefreshCw } from 'lucide-react'
import { useToast } from '../contexts/ToastContext.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { api } from '../lib/api.js'

// Mirrors MANUAL_RUNNERS in server/src/services/systemAutomations.js. Keep in sync.
const SYSTEM_MANUAL_RUNNABLE = new Set(['sys_installation_followup'])

// Mirrors SYSTEM_EMAIL_AUTOMATIONS in server/src/routes/automations.js — system
// automations whose `from` address is overridable via the picker.
const SYSTEM_EMAIL_AUTOMATIONS = new Set(['sys_installation_followup', 'sys_shipment_tracking_email'])

const OP_LABELS = {
  eq: 'est égal à',
  ne: 'est différent de',
  in: 'fait partie de (liste)',
  not_null: 'est renseigné',
}

const ACTION_TYPE_LABELS = { slack: 'Slack', email: 'Email', task: 'Tâche' }

const DEFAULT_ACTION_CONFIG = {
  slack: { webhookEnv: '', text: '' },
  email: { toEnv: '', subject: '', bodyHtml: '', bodyText: '' },
  task: { title: '', description: '', priority: 'Normal', due_in_days: null },
}

export default function AutomationDetail() {
  const { id } = useParams()
  const isNew = id === 'new'
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { addToast } = useToast()
  const confirm = useConfirm()

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
  const [isSystem, setIsSystem] = useState(false)
  const [manualResult, setManualResult] = useState(null)
  const [manualRunning, setManualRunning] = useState(null) // 'dryRun' | 'live' | null
  const [testTo, setTestTo] = useState('')
  const [testLang, setTestLang] = useState('French')
  const [testSending, setTestSending] = useState(false)
  const [testResultMsg, setTestResultMsg] = useState(null)

  // Field-rule state
  const [kind, setKind] = useState(null)           // null | 'field_rule'
  const [actionType, setActionType] = useState('slack')
  const [actionConfig, setActionConfig] = useState(DEFAULT_ACTION_CONFIG.slack)
  // System-email override state (sys_installation_followup, sys_shipment_tracking_email)
  const [systemFrom, setSystemFrom] = useState('')
  const [postmarkInfo, setPostmarkInfo] = useState(null)
  const [showTestModal, setShowTestModal] = useState(false)
  const [fires, setFires] = useState([])
  const saveTimerRef = useRef(null)
  const skipAutosaveRef = useRef(true)

  const isFieldRule = kind === 'field_rule'
  const isEmailAutomation =
    (kind === 'field_rule' && actionType === 'email') ||
    (isSystem && SYSTEM_EMAIL_AUTOMATIONS.has(id))

  useEffect(() => {
    if (isNew) {
      if (searchParams.get('kind') === 'field_rule') {
        setKind('field_rule')
        setTriggerType('field_rule')
        setTriggerConfig({ erp_table: 'tickets', column: '', op: 'eq', value: '', fire_on: 'per_record_once' })
        setActionType('slack')
        setActionConfig(DEFAULT_ACTION_CONFIG.slack)
      }
      return
    }
    api.automations.get(id).then(auto => {
      skipAutosaveRef.current = true
      setName(auto.name)
      setDescription(auto.description || '')
      setActive(!!auto.active)
      setTriggerType(auto.trigger_type)
      setTriggerConfig(JSON.parse(auto.trigger_config || '{}'))
      setScript(auto.script || '')
      setIsSystem(!!auto.system)
      setKind(auto.kind || null)
      if (auto.kind === 'field_rule') {
        setActionType(auto.action_type || 'slack')
        try { setActionConfig(JSON.parse(auto.action_config || '{}')) } catch { setActionConfig({}) }
      } else if (auto.system && SYSTEM_EMAIL_AUTOMATIONS.has(auto.id)) {
        try {
          const ac = JSON.parse(auto.action_config || '{}')
          setSystemFrom(ac.from || '')
        } catch { setSystemFrom('') }
      }
    }).catch(() => addToast({ message: 'Erreur de chargement', type: 'error' }))
    loadLogs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    if (!isNew && isFieldRule) {
      api.automations.fires(id, 50).then(setFires).catch(() => {})
    }
  }, [id, isFieldRule, isNew])

  useEffect(() => {
    if (isSystem && SYSTEM_EMAIL_AUTOMATIONS.has(id)) {
      api.connectors.postmarkInfo().then(setPostmarkInfo).catch(() => setPostmarkInfo(null))
    }
  }, [id, isSystem])

  async function loadLogs() {
    const data = await api.automations.logs(id).catch(() => [])
    setLogs(data)
  }

  function buildSaveBody() {
    if (isSystem && !isFieldRule) {
      const body = { active: active ? 1 : 0 }
      if (SYSTEM_EMAIL_AUTOMATIONS.has(id)) {
        body.action_config = JSON.stringify({ from: systemFrom || undefined })
      }
      return body
    }
    if (isFieldRule) {
      const body = {
        kind: 'field_rule',
        active: active ? 1 : 0,
        trigger_type: 'field_rule',
        trigger_config: JSON.stringify(triggerConfig),
        action_type: actionType,
        action_config: JSON.stringify(actionConfig),
      }
      if (!isSystem) { body.name = name.trim(); body.description = description }
      return body
    }
    return {
      name: name.trim(), description, active: active ? 1 : 0,
      trigger_type: triggerType,
      trigger_config: JSON.stringify(triggerConfig),
      script,
    }
  }

  async function handleCreate() {
    if (!name.trim()) { addToast({ message: 'Nom requis', type: 'error' }); return }
    setSaving(true)
    try {
      const res = await api.automations.create(buildSaveBody())
      addToast({ message: 'Automation créée', type: 'success' })
      navigate(`/automations/${res.id}`)
    } catch (e) {
      addToast({ message: e.message || 'Erreur de sauvegarde', type: 'error' })
    }
    setSaving(false)
  }

  // Autosave — debounced PATCH of header/script/trigger/action fields for existing automations.
  // System automations only autosave `active` (other fields are read-only).
  useEffect(() => {
    if (isNew) return
    if (skipAutosaveRef.current) { skipAutosaveRef.current = false; return }
    if (!name.trim() && !isSystem) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      setSaving(true)
      try {
        await api.automations.update(id, buildSaveBody())
      } catch (e) {
        addToast({ message: e.message || 'Erreur de sauvegarde', type: 'error' })
      } finally {
        setSaving(false)
      }
    }, 500)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, description, active, triggerType, triggerConfig, script, actionType, actionConfig, kind, systemFrom])

  async function handleResetFires() {
    if (!(await confirm('Supprimer l\'historique des déclenchements ? La règle pourra re-tirer sur tous les records correspondants.'))) return
    try {
      const res = await api.automations.resetFires(id)
      addToast({ message: `${res.deleted} déclenchement(s) supprimé(s)`, type: 'success' })
      setFires([])
    } catch (e) {
      addToast({ message: e.message || 'Erreur', type: 'error' })
    }
  }

  function handleActionTypeChange(newType) {
    setActionType(newType)
    setActionConfig(DEFAULT_ACTION_CONFIG[newType] || {})
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

  async function handleTestEmail() {
    if (!testTo || !/@/.test(testTo)) {
      setTestResultMsg({ type: 'error', text: 'Adresse email invalide' }); return
    }
    setTestSending(true)
    setTestResultMsg(null)
    try {
      const res = await api.automations.testEmail(id, { to: testTo, language: testLang })
      setTestResultMsg({ type: 'success', text: `Email test envoyé à ${res.to} (${res.language})` })
    } catch (e) {
      setTestResultMsg({ type: 'error', text: e.message || 'Erreur d\'envoi' })
    }
    setTestSending(false)
  }

  async function handleManualRun(dryRun) {
    if (!dryRun && !(await confirm({ title: 'Lancer en mode live', message: 'Lancer maintenant ? Cela peut envoyer de vrais emails aux clients ciblés.', confirmLabel: 'Lancer', danger: true }))) return
    setManualRunning(dryRun ? 'dryRun' : 'live')
    setManualResult(null)
    try {
      const res = await api.automations.run(id, { dryRun })
      setManualResult({ ...res, dryRun })
      if (!dryRun) loadLogs()
    } catch (e) {
      setManualResult({ status: 'error', error: e.message, dryRun })
    }
    setManualRunning(null)
  }

  async function handleDelete() {
    if (!(await confirm(`Supprimer l'automation "${name}" ?`))) return
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
            <h1 className="text-xl font-semibold flex items-center gap-2">
              {isNew ? 'Nouvelle automation' : name}
              {isSystem && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-200">
                  <Lock size={12} /> Système
                </span>
              )}
            </h1>
          </div>
          <div className="flex gap-2 items-center">
            {!isNew && !isSystem && (
              <button onClick={handleDelete}
                className="px-3 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50">
                Supprimer
              </button>
            )}
            {isNew ? (
              <button onClick={handleCreate} disabled={saving}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                {saving ? 'Création...' : 'Créer'}
              </button>
            ) : (
              <span className="text-xs text-slate-400">{saving ? 'Sauvegarde…' : 'Sauvegardé'}</span>
            )}
          </div>
        </div>

        {isSystem && (
          <div className="bg-indigo-50 border border-indigo-200 rounded-lg px-4 py-3 text-sm text-indigo-900">
            Cette automation est intégrée au code de l'application. Son trigger, son comportement et son script sont en lecture seule. Seul le statut (actif/inactif) peut être modifié.
          </div>
        )}

        {/* Infos générales */}
        <div className="bg-white rounded-lg border p-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nom</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} disabled={isSystem}
                className="w-full border rounded-lg px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-600" placeholder="Mon automation" />
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
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {isSystem ? 'Comportement' : 'Description'}
            </label>
            {isSystem ? (
              <div className="w-full border rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-700 whitespace-pre-wrap leading-relaxed">
                {description || '—'}
              </div>
            ) : (
              <input type="text" value={description} onChange={e => setDescription(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="Optionnel" />
            )}
          </div>
        </div>

        {/* Trigger */}
        <div className="bg-white rounded-lg border p-5">
          <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
            Déclencheur
            {isFieldRule && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 font-medium">
                <Zap size={9} className="inline -mt-0.5" /> Règle de champ
              </span>
            )}
          </h2>
          {isFieldRule ? (
            <FieldRuleTriggerEditor
              triggerConfig={triggerConfig}
              onChange={setTriggerConfig}
              readOnly={false}
            />
          ) : isSystem ? (
            <SystemTriggerView config={triggerConfig} />
          ) : (
            <TriggerConfig
              triggerType={triggerType}
              triggerConfig={triggerConfig}
              onTypeChange={setTriggerType}
              onConfigChange={setTriggerConfig}
            />
          )}
        </div>

        {/* Sender override — system email automations */}
        {isSystem && SYSTEM_EMAIL_AUTOMATIONS.has(id) && (
          <div className="bg-white rounded-lg border p-5">
            <h2 className="text-sm font-semibold mb-1 flex items-center gap-2">
              <Mail size={14} /> Expéditeur
            </h2>
            <p className="text-xs text-gray-500 mb-3">
              Adresse utilisée comme <code className="bg-gray-100 px-1 rounded">From</code> lors des envois de cette automation.
              Vide = défaut global Postmark{postmarkInfo?.default_from ? ` (${postmarkInfo.default_from})` : ''}.
            </p>
            <select value={systemFrom}
              onChange={e => setSystemFrom(e.target.value)}
              className="w-full max-w-md border rounded-lg px-3 py-2 text-sm bg-white">
              <option value="">— Défaut global —</option>
              {(postmarkInfo?.addresses || []).map(a => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
        )}

        {/* Action (field-rule only) */}
        {isFieldRule && (
          <div className="bg-white rounded-lg border p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold">Action</h2>
              <div className="flex gap-1">
                {['slack', 'email', 'task'].map(t => (
                  <button key={t} onClick={() => handleActionTypeChange(t)} disabled={false}
                    className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                      actionType === t
                        ? 'bg-indigo-600 text-white'
                        : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                    } disabled:opacity-50`}>
                    {ACTION_TYPE_LABELS[t]}
                  </button>
                ))}
              </div>
            </div>
            <FieldRuleActionEditor
              actionType={actionType}
              actionConfig={actionConfig}
              onChange={setActionConfig}
              erpTable={triggerConfig?.erp_table}
              readOnly={false}
            />
          </div>
        )}

        {/* Aperçu du courriel — field-rule email ou système email */}
        {!isNew && isEmailAutomation && (
          <EmailPreview automationId={id} actionConfig={actionConfig} isSystem={isSystem} />
        )}

        {/* Test + Fires (field-rule only) */}
        {isFieldRule && !isNew && (
          <div className="bg-white rounded-lg border p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-sm font-semibold">Tester & historique</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  Le test liste les candidats et les payloads rendus sans rien envoyer ni persister.
                </p>
              </div>
              <div className="flex gap-2">
                <button onClick={handleResetFires}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 flex items-center gap-1.5">
                  <RotateCcw size={13} /> Réinitialiser
                </button>
                <button onClick={() => setShowTestModal(true)}
                  className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 flex items-center gap-1.5">
                  <FlaskConical size={13} /> Tester
                </button>
              </div>
            </div>
            <FiresList fires={fires} />
          </div>
        )}

        {/* Manual run (dry-run + run-now) — system automations with a backend runner */}
        {isSystem && SYSTEM_MANUAL_RUNNABLE.has(id) && (
          <div className="bg-white rounded-lg border p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-sm font-semibold">Exécution manuelle</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  Le <strong>dry-run</strong> liste les clients qui seraient ciblés sans rien envoyer ni persister.
                  Le <strong>lancement</strong> déclenche immédiatement l'automation (envois, flags, logs inclus).
                </p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => handleManualRun(true)} disabled={manualRunning !== null}
                  className="px-3 py-1.5 text-sm border border-indigo-300 text-indigo-700 rounded-lg hover:bg-indigo-50 disabled:opacity-50 flex items-center gap-1.5">
                  {manualRunning === 'dryRun'
                    ? <><div className="w-3 h-3 border-2 border-indigo-700 border-t-transparent rounded-full animate-spin" /> Simulation...</>
                    : <><FlaskConical size={14} /> Simuler (dry-run)</>}
                </button>
                <button onClick={() => handleManualRun(false)} disabled={manualRunning !== null || !active}
                  title={!active ? 'Activez l\'automation avant de pouvoir la lancer manuellement' : ''}
                  className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1.5">
                  {manualRunning === 'live'
                    ? <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> Exécution...</>
                    : <><Play size={14} /> Lancer maintenant</>}
                </button>
              </div>
            </div>
            {manualResult && <ManualRunResult result={manualResult} />}

            <div className="mt-4 pt-4 border-t">
              <div className="flex items-end gap-2 flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Envoyer un email de test</label>
                  <input type="email" value={testTo} onChange={e => setTestTo(e.target.value)}
                    placeholder="votre@email.com"
                    className="w-full border rounded-lg px-3 py-1.5 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Langue</label>
                  <select value={testLang} onChange={e => setTestLang(e.target.value)}
                    className="border rounded-lg px-3 py-1.5 text-sm bg-white">
                    <option value="French">Français</option>
                    <option value="English">English</option>
                  </select>
                </div>
                <button onClick={handleTestEmail} disabled={testSending}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5">
                  {testSending
                    ? <><div className="w-3 h-3 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" /> Envoi...</>
                    : <><Mail size={14} /> Envoyer test</>}
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1.5">
                L'email contient une bannière « TEST » et utilise un faux client — les boutons ne créent aucune tâche.
              </p>
              {testResultMsg && (
                <div className={`mt-2 text-sm px-3 py-1.5 rounded-lg ${
                  testResultMsg.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200'
                  : 'bg-red-50 text-red-700 border border-red-200'
                }`}>{testResultMsg.text}</div>
              )}
            </div>
          </div>
        )}

        {/* Script — hidden for system automations and field-rules */}
        {!isSystem && !isFieldRule && (
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
        )}

        {/* Test + Résultat — hidden for system automations and field-rules */}
        {!isNew && !isSystem && !isFieldRule && (
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

      {showTestModal && (
        <FieldRuleTestModal automationId={id} onClose={() => setShowTestModal(false)} />
      )}
    </Layout>
  )
}

function FieldRuleTriggerEditor({ triggerConfig, onChange, readOnly }) {
  const [tables, setTables] = useState([])
  const [fieldDefs, setFieldDefs] = useState({ columns: [] })

  useEffect(() => { api.automations.fieldRuleTables().then(setTables).catch(() => setTables([])) }, [])
  useEffect(() => {
    if (!triggerConfig?.erp_table) { setFieldDefs({ columns: [] }); return }
    api.automations.ruleFieldDefs(triggerConfig.erp_table)
      .then(setFieldDefs)
      .catch(() => setFieldDefs({ columns: [] }))
  }, [triggerConfig?.erp_table])

  const op = triggerConfig?.op || 'eq'
  const cols = fieldDefs.columns || []
  const selectedCol = cols.find(c => c.column_name === triggerConfig?.column)

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Table ERP</label>
          <select
            value={triggerConfig?.erp_table || ''}
            onChange={e => onChange({ ...triggerConfig, erp_table: e.target.value, column: '' })}
            disabled={readOnly}
            className="w-full border rounded-lg px-3 py-2 text-sm bg-white disabled:bg-gray-50"
          >
            <option value="">— choisir —</option>
            {tables.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Colonne</label>
          <select
            value={triggerConfig?.column || ''}
            onChange={e => onChange({ ...triggerConfig, column: e.target.value })}
            disabled={readOnly || !triggerConfig?.erp_table}
            className="w-full border rounded-lg px-3 py-2 text-sm bg-white disabled:bg-gray-50"
          >
            <option value="">— choisir —</option>
            {cols.map(c => (
              <option key={c.column_name} value={c.column_name}>
                {c.airtable_field_name ? `${c.airtable_field_name} (${c.column_name})` : c.column_name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-[180px_1fr] gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Opérateur</label>
          <select
            value={op}
            onChange={e => onChange({ ...triggerConfig, op: e.target.value })}
            disabled={readOnly}
            className="w-full border rounded-lg px-3 py-2 text-sm bg-white disabled:bg-gray-50"
          >
            {Object.entries(OP_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {op !== 'not_null' && (
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Valeur{op === 'in' ? ' (virgules)' : ''}
            </label>
            <input
              type="text"
              value={op === 'in'
                ? (Array.isArray(triggerConfig?.value) ? triggerConfig.value.join(',') : (triggerConfig?.value || ''))
                : (triggerConfig?.value ?? '')}
              onChange={e => {
                const raw = e.target.value
                const v = op === 'in' ? raw.split(',').map(s => s.trim()).filter(Boolean) : raw
                onChange({ ...triggerConfig, value: v })
              }}
              disabled={readOnly}
              className="w-full border rounded-lg px-3 py-2 text-sm disabled:bg-gray-50"
              placeholder={op === 'in' ? 'Hardware,Software' : 'Hardware'}
            />
          </div>
        )}
      </div>
      {selectedCol?.field_type && (
        <p className="text-xs text-gray-500">Type détecté : <code className="bg-gray-100 px-1 rounded">{selectedCol.field_type}</code></p>
      )}
    </div>
  )
}

function FieldRuleActionEditor({ actionType, actionConfig, onChange, erpTable, readOnly }) {
  const [fieldDefs, setFieldDefs] = useState({ columns: [] })
  const [postmark, setPostmark] = useState(null)

  useEffect(() => {
    if (!erpTable) { setFieldDefs({ columns: [] }); return }
    api.automations.ruleFieldDefs(erpTable).then(setFieldDefs).catch(() => setFieldDefs({ columns: [] }))
  }, [erpTable])

  useEffect(() => {
    if (actionType === 'email') {
      api.connectors.postmarkInfo().then(setPostmark).catch(() => setPostmark(null))
    }
  }, [actionType])

  const allVars = [
    ...(fieldDefs.columns || []).map(c => c.column_name),
    'company_name', 'app_url', 'id',
  ].filter((v, i, a) => a.indexOf(v) === i)

  return (
    <div className="space-y-3">
      {/* Channel-specific fields */}
      {actionType === 'slack' && (
        <>
          <Field label="Webhook (env var)" hint="Nom de la variable d'environnement qui contient l'URL Slack (ex: SLACK_WEBHOOK_HARDWARE)">
            <input type="text" value={actionConfig.webhookEnv || ''}
              onChange={e => onChange({ ...actionConfig, webhookEnv: e.target.value })} readOnly={readOnly}
              className="w-full border rounded-lg px-3 py-2 text-sm font-mono disabled:bg-gray-50"
              placeholder="SLACK_WEBHOOK_HARDWARE" />
          </Field>
          <Field label="Texte (template)">
            <textarea rows={4} value={actionConfig.text || ''}
              onChange={e => onChange({ ...actionConfig, text: e.target.value })} readOnly={readOnly}
              className="w-full border rounded-lg px-3 py-2 text-sm font-mono disabled:bg-gray-50"
              placeholder="🔧 {{title}} — {{company_name}}" />
          </Field>
        </>
      )}

      {actionType === 'email' && (
        <>
          <Field label="Expéditeur" hint={postmark?.default_from ? `Vide = défaut global (${postmark.default_from})` : 'Vide = défaut global Postmark'}>
            <select value={actionConfig.from || ''}
              onChange={e => onChange({ ...actionConfig, from: e.target.value || undefined })} disabled={readOnly}
              className="w-full border rounded-lg px-3 py-2 text-sm bg-white disabled:bg-gray-50">
              <option value="">— Défaut global —</option>
              {(postmark?.addresses || []).map(a => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Destinataire (env var)" hint="POSTMARK_TO_OPS, ou laisser vide et utiliser le champ direct ci-dessous">
              <input type="text" value={actionConfig.toEnv || ''}
                onChange={e => onChange({ ...actionConfig, toEnv: e.target.value })} readOnly={readOnly}
                className="w-full border rounded-lg px-3 py-2 text-sm font-mono disabled:bg-gray-50"
                placeholder="NOTIFY_EMAIL_OPS" />
            </Field>
            <Field label="Destinataire (direct)">
              <input type="text" value={actionConfig.to || ''}
                onChange={e => onChange({ ...actionConfig, to: e.target.value })} readOnly={readOnly}
                className="w-full border rounded-lg px-3 py-2 text-sm disabled:bg-gray-50"
                placeholder="ops@example.com" />
            </Field>
          </div>
          <Field label="Sujet">
            <input type="text" value={actionConfig.subject || ''}
              onChange={e => onChange({ ...actionConfig, subject: e.target.value })} readOnly={readOnly}
              className="w-full border rounded-lg px-3 py-2 text-sm disabled:bg-gray-50" />
          </Field>
          <Field label="Corps HTML">
            <textarea rows={6} value={actionConfig.bodyHtml || ''}
              onChange={e => onChange({ ...actionConfig, bodyHtml: e.target.value })} readOnly={readOnly}
              className="w-full border rounded-lg px-3 py-2 text-xs font-mono disabled:bg-gray-50"
              placeholder="<p>Bonjour, ...</p>" />
          </Field>
          <Field label="Corps texte (fallback)">
            <textarea rows={3} value={actionConfig.bodyText || ''}
              onChange={e => onChange({ ...actionConfig, bodyText: e.target.value })} readOnly={readOnly}
              className="w-full border rounded-lg px-3 py-2 text-xs font-mono disabled:bg-gray-50" />
          </Field>
        </>
      )}

      {actionType === 'task' && (
        <>
          <Field label="Titre">
            <input type="text" value={actionConfig.title || ''}
              onChange={e => onChange({ ...actionConfig, title: e.target.value })} readOnly={readOnly}
              className="w-full border rounded-lg px-3 py-2 text-sm disabled:bg-gray-50"
              placeholder="Suivi — {{title}}" />
          </Field>
          <Field label="Description">
            <textarea rows={4} value={actionConfig.description || ''}
              onChange={e => onChange({ ...actionConfig, description: e.target.value })} readOnly={readOnly}
              className="w-full border rounded-lg px-3 py-2 text-sm font-mono disabled:bg-gray-50" />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Priorité">
              <select value={actionConfig.priority || 'Normal'}
                onChange={e => onChange({ ...actionConfig, priority: e.target.value })} disabled={readOnly}
                className="w-full border rounded-lg px-3 py-2 text-sm bg-white disabled:bg-gray-50">
                <option>Basse</option><option>Normal</option><option>Haute</option><option>Urgent</option>
              </select>
            </Field>
            <Field label="Échéance (jours)">
              <input type="number" min="0" value={actionConfig.due_in_days ?? ''}
                onChange={e => {
                  const n = e.target.value === '' ? null : parseInt(e.target.value, 10)
                  onChange({ ...actionConfig, due_in_days: isNaN(n) ? null : n })
                }} readOnly={readOnly}
                className="w-full border rounded-lg px-3 py-2 text-sm disabled:bg-gray-50" />
            </Field>
            <Field label="Assigné à (user id)">
              <input type="text" value={actionConfig.assigned_to || ''}
                onChange={e => onChange({ ...actionConfig, assigned_to: e.target.value })} readOnly={readOnly}
                className="w-full border rounded-lg px-3 py-2 text-xs font-mono disabled:bg-gray-50" />
            </Field>
          </div>
        </>
      )}

      {/* Variables chips */}
      {allVars.length > 0 && (
        <div className="pt-3 border-t">
          <p className="text-xs text-gray-500 mb-2">Variables disponibles (cliquer pour copier) :</p>
          <div className="flex flex-wrap gap-1.5">
            {allVars.map(v => (
              <button key={v} type="button"
                onClick={() => navigator.clipboard?.writeText(`{{${v}}}`)}
                className="px-2 py-0.5 text-[11px] font-mono bg-gray-100 text-gray-700 rounded hover:bg-indigo-100 hover:text-indigo-700">
                {`{{${v}}}`}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-gray-400 mt-1">{hint}</p>}
    </div>
  )
}

function FiresList({ fires }) {
  if (!fires || fires.length === 0) {
    return <p className="text-xs text-gray-400 italic">Aucun déclenchement enregistré.</p>
  }
  return (
    <div className="border rounded-lg divide-y max-h-64 overflow-y-auto bg-gray-50">
      {fires.slice(0, 50).map(f => (
        <div key={`${f.record_table}-${f.record_id}`} className="px-3 py-1.5 text-xs flex items-center gap-3">
          <span className="font-mono text-gray-500 w-36 shrink-0">{formatLocal(f.fired_at)}</span>
          <span className="font-mono text-gray-700">{f.record_table}</span>
          <span className="text-gray-400">·</span>
          <span className="font-mono text-gray-700 break-all">{f.record_id}</span>
        </div>
      ))}
    </div>
  )
}

function FieldRuleTestModal({ automationId, onClose }) {
  const [loading, setLoading] = useState(true)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.automations.test(automationId)
      .then(r => { setResult(r); setLoading(false) })
      .catch(e => { setError(e.message || 'Erreur'); setLoading(false) })
  }, [automationId])

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="text-sm font-semibold flex items-center gap-2"><FlaskConical size={16} /> Test de la règle (aucun envoi)</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="px-5 py-4 overflow-y-auto">
          {loading && <p className="text-sm text-gray-500">Chargement...</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {result && (
            <>
              <div className="flex gap-6 text-sm mb-4">
                <div><span className="text-gray-500">Candidats :</span> <strong>{result.candidates_total}</strong></div>
                <div><span className="text-gray-500">Tireraient :</span> <strong className="text-indigo-700">{result.would_fire}</strong></div>
                <div><span className="text-gray-500">Déjà tirés :</span> <strong className="text-gray-500">{result.already_fired}</strong></div>
              </div>
              {result.previews.length === 0 && (
                <p className="text-sm text-gray-500 italic">Aucun candidat pour cette règle.</p>
              )}
              <div className="space-y-2">
                {result.previews.map(p => (
                  <div key={p.id} className={`border rounded-lg p-3 text-xs ${
                    p.already_fired ? 'bg-gray-50 opacity-75' : 'bg-white'
                  } ${p.error ? 'border-red-300' : 'border-gray-200'}`}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="font-medium">{p.label}</span>
                      <span className="font-mono text-gray-400">{p.id}</span>
                      {p.already_fired && (
                        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600">déjà tiré</span>
                      )}
                    </div>
                    {p.error ? (
                      <pre className="text-red-600 whitespace-pre-wrap">{p.error}</pre>
                    ) : (
                      <pre className="text-gray-700 whitespace-pre-wrap bg-gray-50 rounded p-2 font-mono">
                        {JSON.stringify(p.rendered, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
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

// SQLite datetime('now') returns UTC as "YYYY-MM-DD HH:MM:SS" with no TZ marker —
// browsers parse it ambiguously. Force UTC interpretation, then render in local time.
function formatLocal(dateStr) {
  if (!dateStr) return '—'
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(dateStr)
    ? dateStr.replace(' ', 'T') + 'Z'
    : dateStr
  return new Date(iso).toLocaleString('fr-CA')
}

function LinkifiedText({ text }) {
  if (!text) return null
  const urlRegex = /(https?:\/\/[^\s<>]+)/g
  const parts = []
  let lastIndex = 0
  let match
  let key = 0
  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index))
    const url = match[0]
    parts.push(
      <a key={key++} href={url} target="_blank" rel="noreferrer"
        className="text-indigo-600 hover:text-indigo-800 underline decoration-dotted break-all">
        {url}
      </a>
    )
    lastIndex = match.index + url.length
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return <>{parts}</>
}

// Render log text line-by-line: diff lines (` - ` / ` + ` after indent) get
// GitHub-style red/green backgrounds; URLs remain clickable inline.
function LogView({ text, errorTone = false }) {
  if (!text) return null
  const lines = text.split('\n')
  return (
    <div className={`font-mono text-xs whitespace-pre-wrap break-all ${errorTone ? 'text-red-600' : 'text-gray-700'}`}>
      {lines.map((line, i) => {
        const m = line.match(/^(\s*)([-+])\s/)
        const cls = m
          ? (m[2] === '-'
              ? 'bg-red-50 text-red-800'
              : 'bg-green-50 text-green-800')
          : ''
        return (
          <div key={i} className={cls || undefined}>
            {line ? <LinkifiedText text={line} /> : '\u00A0'}
          </div>
        )
      })}
    </div>
  )
}

function ManualRunResult({ result }) {
  const isError = result.status === 'error'
  const out = result.output || {}
  const details = out.details || []

  return (
    <div className={`rounded-lg border p-3 ${isError ? 'bg-red-50 border-red-200' : (result.dryRun ? 'bg-indigo-50 border-indigo-200' : 'bg-green-50 border-green-200')}`}>
      <div className="flex items-center gap-2 text-sm mb-2">
        <span className={`font-medium ${isError ? 'text-red-700' : (result.dryRun ? 'text-indigo-700' : 'text-green-700')}`}>
          {isError ? '✗ Erreur' : (result.dryRun ? '🧪 Dry-run terminé' : '✓ Exécution terminée')}
        </span>
        {result.duration_ms != null && <span className="text-xs text-gray-500">{result.duration_ms}ms</span>}
      </div>
      {isError && <pre className="text-xs text-red-700 whitespace-pre-wrap">{result.error}</pre>}
      {!isError && out.summary && (
        <p className="text-sm text-gray-800 mb-2">{out.summary}</p>
      )}
      {!isError && details.length > 0 && (
        <div className="max-h-72 overflow-y-auto border rounded bg-white divide-y">
          {details.map((d, i) => (
            <div key={i} className="px-3 py-1.5 text-xs flex items-center gap-2">
              <span className={`px-1.5 py-0.5 rounded font-mono text-[10px] ${
                d.action === 'sent' ? 'bg-green-100 text-green-700' :
                d.action === 'error' ? 'bg-red-100 text-red-700' :
                'bg-indigo-100 text-indigo-700'
              }`}>
                {d.action}
              </span>
              <span className="font-medium">{d.company_name || d.company_id}</span>
              <span className="text-gray-500">→</span>
              <span className="text-gray-700 font-mono">{d.to || '—'}</span>
              {d.language && <span className="text-gray-400">({d.language})</span>}
              {d.error && <span className="text-red-600 ml-auto">{d.error}</span>}
            </div>
          ))}
        </div>
      )}
      {!isError && details.length === 0 && (
        <p className="text-xs text-gray-500 italic">Aucun client éligible actuellement.</p>
      )}
    </div>
  )
}

function SystemTriggerView({ config }) {
  const KIND_LABELS = {
    post_sync: 'Après synchronisation',
    webhook: 'Webhook entrant',
    schedule: 'Cron planifié',
    startup: 'Au démarrage du serveur',
  }
  const rows = [
    ['Type', KIND_LABELS[config?.kind] || config?.kind || '—'],
    ['Source', config?.source || '—'],
    config?.event ? ['Événement', config.event] : null,
    ['Résumé', config?.summary || '—'],
  ].filter(Boolean)

  return (
    <div className="space-y-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-3 text-sm">
          <span className="w-28 text-gray-500 shrink-0">{label}</span>
          <span className="text-gray-800 font-mono text-xs break-all">{value}</span>
        </div>
      ))}
    </div>
  )
}

function EmailPreview({ automationId, actionConfig, isSystem }) {
  const [preview, setPreview] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [language, setLanguage] = useState('French')
  const [showText, setShowText] = useState(false)

  const load = useCallback(async (lang) => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.automations.emailPreview(automationId, lang || language)
      setPreview(data)
    } catch (e) {
      setError(e.message || 'Erreur de chargement')
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automationId, language])

  // Initial load + reload on language change
  useEffect(() => { load(language) }, [language, load])

  // For field-rule emails: reload preview ~800ms after the user stops editing
  // (action_config is autosaved server-side every 500ms, so we wait a bit longer).
  const actionKey = JSON.stringify(actionConfig || {})
  useEffect(() => {
    if (isSystem) return
    const t = setTimeout(() => load(language), 800)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionKey, isSystem])

  return (
    <div className="bg-white rounded-lg border p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Eye size={14} /> Aperçu du courriel
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {preview?.sample_record
              ? <>Rendu à partir du record <code className="bg-gray-100 px-1 rounded">{preview.sample_record.label || preview.sample_record.id}</code>.</>
              : isSystem
                ? 'Rendu avec des données d\'exemple. L\'adresse du destinataire et les variables sont substituées à l\'envoi réel.'
                : 'Aucun record candidat trouvé — les placeholders {{var}} restent bruts.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isSystem && preview?.languages?.length > 1 && (
            <select value={language} onChange={e => setLanguage(e.target.value)}
              className="border rounded-lg px-2 py-1 text-xs bg-white">
              {preview.languages.map(l => <option key={l} value={l}>{l === 'French' ? 'Français' : 'English'}</option>)}
            </select>
          )}
          <button onClick={() => load(language)} disabled={loading}
            className="px-2.5 py-1 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Actualiser
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {preview && preview.available === false && (
        <p className="text-sm text-gray-500 italic">{preview.reason || 'Aperçu non disponible.'}</p>
      )}

      {preview && preview.available && (
        <div className="space-y-3">
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs">
              <div className="flex gap-2"><span className="text-gray-500 w-16 shrink-0">Sujet</span><span className="font-medium text-gray-900 break-words">{preview.subject || <span className="text-gray-400 italic">(vide)</span>}</span></div>
              {preview.from && <div className="flex gap-2 mt-1"><span className="text-gray-500 w-16 shrink-0">De</span><span className="font-mono text-gray-700">{preview.from}</span></div>}
              {preview.to && <div className="flex gap-2 mt-1"><span className="text-gray-500 w-16 shrink-0">À</span><span className="font-mono text-gray-700">{preview.to}</span></div>}
            </div>
            {preview.bodyHtml
              ? <iframe title="Aperçu courriel" srcDoc={preview.bodyHtml} sandbox="" className="w-full bg-white" style={{ height: 500, border: 0 }} />
              : <div className="p-4 text-sm text-gray-400 italic">(Corps HTML vide)</div>}
          </div>

          {preview.bodyText && (
            <div>
              <button onClick={() => setShowText(s => !s)}
                className="text-xs text-indigo-600 hover:text-indigo-800 flex items-center gap-1">
                <ChevronDown size={12} className={`transition-transform ${showText ? 'rotate-180' : ''}`} />
                Version texte (fallback)
              </button>
              {showText && (
                <pre className="mt-2 text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded-lg p-3 whitespace-pre-wrap font-mono max-h-64 overflow-y-auto">{preview.bodyText}</pre>
              )}
            </div>
          )}
        </div>
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
              log.status === 'error' ? 'bg-red-500' :
              log.status === 'skipped' ? 'bg-gray-400' :
              log.status === 'running' ? 'bg-yellow-500' : 'bg-gray-400'
            }`} />
            <span className="text-gray-500 text-xs w-36 shrink-0">
              {formatLocal(log.created_at)}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              log.status === 'success' ? 'bg-green-100 text-green-700' :
              log.status === 'error' ? 'bg-red-100 text-red-700' :
              log.status === 'skipped' ? 'bg-gray-100 text-gray-600' :
              log.status === 'running' ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-600'
            }`}>
              {log.status === 'success' ? 'Succès' :
               log.status === 'error' ? 'Erreur' :
               log.status === 'skipped' ? 'Ignorée' :
               log.status === 'running' ? 'En cours' : log.status}
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
                  <div className="mt-1 bg-white p-2 rounded border">
                    <LogView text={log.result} />
                  </div>
                </div>
              )}
              {log.error && (
                <div>
                  <span className="text-xs font-medium text-red-500">Erreur :</span>
                  <div className="mt-1 bg-white p-2 rounded border border-red-200">
                    <LogView text={log.error} errorTone />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
