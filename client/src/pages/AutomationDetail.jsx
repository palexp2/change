import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom'
import { Layout } from '../components/Layout.jsx'
import { ArrowLeft, Play, ChevronDown, Lock, FlaskConical, Mail, Zap, RotateCcw, X, Eye, RefreshCw, AlertTriangle, Gauge } from 'lucide-react'
import { useToast } from '../contexts/ToastContext.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { api } from '../lib/api.js'
import { fmtDateTime } from '../lib/formatDate.js'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { WebhookEditor } from '../components/WebhookEditor.jsx'

// Mirrors MANUAL_RUNNERS in server/src/services/systemAutomations.js. Keep in sync.
const SYSTEM_MANUAL_RUNNABLE = new Set(['sys_installation_followup'])

// Mirrors SYSTEM_EMAIL_AUTOMATIONS in server/src/routes/automations.js — system
// automations whose `from` address is overridable via the picker.
const SYSTEM_EMAIL_AUTOMATIONS = new Set(['sys_installation_followup', 'sys_shipment_tracking_email'])

// System automation whose Airtable webhook retry queue is surfaced in the detail page.
// Mirrors the id gate in server/src/routes/automations.js (/:id/retry-queue).
const WEBHOOK_RETRY_AUTOMATION_ID = 'sys_airtable_webhook_router'

const OP_LABELS = {
  eq: 'est égal à',
  ne: 'est différent de',
  gt: 'est supérieur à (>)',
  gte: 'est supérieur ou égal à (≥)',
  lt: 'est inférieur à (<)',
  lte: 'est inférieur ou égal à (≤)',
  in: 'fait partie de (liste)',
  not_null: 'est renseigné',
  date_offset: 'date relative à aujourd\'hui (J±N jours)',
}

// Operators valides pour une condition secondaire d'une règle de date (tous sauf date_offset).
const FILTER_OP_LABELS = Object.fromEntries(
  Object.entries(OP_LABELS).filter(([k]) => k !== 'date_offset')
)

// Operators that compare numerically — the value input becomes a number field.
const NUMERIC_OPS = new Set(['gt', 'gte', 'lt', 'lte'])

const ACTION_TYPE_LABELS = { slack: 'Slack', email: 'Email', task: 'Tâche', script: 'Script' }

const DEFAULT_ACTION_CONFIG = {
  slack: { webhookEnv: '', text: '' },
  email: { toEnv: '', subject: '', bodyHtml: '', bodyText: '' },
  task: { title: '', description: '', priority: 'Normal', due_in_days: null },
  script: { script: '', allow_trigger_write: false },
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

  // Webhook state
  const [webhookToken, setWebhookToken] = useState(null)

  // Field-rule state
  const [kind, setKind] = useState(null)           // null | 'field_rule' | 'webhook'
  const [actionType, setActionType] = useState('slack')
  const [actionConfig, setActionConfig] = useState(DEFAULT_ACTION_CONFIG.slack)
  // System-email override state (sys_installation_followup, sys_shipment_tracking_email)
  const [systemFrom, setSystemFrom] = useState('')
  const [postmarkInfo, setPostmarkInfo] = useState(null)
  const [showTestModal, setShowTestModal] = useState(false)
  const [fires, setFires] = useState([])
  const [runningDateRule, setRunningDateRule] = useState(false)
  // Field-rule backpressure queue (automation_deferred_candidates)
  const [deferredQueue, setDeferredQueue] = useState(null) // null = not yet loaded
  const [deferredLoading, setDeferredLoading] = useState(false)
  const [draining, setDraining] = useState(false)
  // Airtable webhook retry queue (sys_airtable_webhook_router only)
  const [retryQueue, setRetryQueue] = useState(null) // null = not yet loaded
  const [retryMaxAttempts, setRetryMaxAttempts] = useState(5)
  const [retryLoading, setRetryLoading] = useState(false)
  const [retryingId, setRetryingId] = useState(null)
  const saveTimerRef = useRef(null)
  const skipAutosaveRef = useRef(true)

  const isFieldRule = kind === 'field_rule'
  const isWebhook = kind === 'webhook'
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
      } else if (searchParams.get('kind') === 'webhook') {
        setKind('webhook')
        setTriggerType('webhook')
        setActionConfig({ mode: 'declarative', steps: [], response_rules: [], default_response: { status: 200, body: { ok: true } } })
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
      } else if (auto.kind === 'webhook') {
        setWebhookToken(auto.webhook_token || null)
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

  const loadDeferredQueue = useCallback(async () => {
    setDeferredLoading(true)
    try {
      setDeferredQueue(await api.automations.deferredQueue(id))
    } catch {
      setDeferredQueue({ depth: 0, items: [] })
    } finally {
      setDeferredLoading(false)
    }
  }, [id])

  useEffect(() => {
    if (!isNew && isFieldRule) loadDeferredQueue()
  }, [id, isFieldRule, isNew, loadDeferredQueue])

  const loadRetryQueue = useCallback(async () => {
    setRetryLoading(true)
    try {
      const data = await api.automations.retryQueue(WEBHOOK_RETRY_AUTOMATION_ID)
      setRetryQueue(data.items || [])
      if (data.max_attempts != null) setRetryMaxAttempts(data.max_attempts)
    } catch {
      setRetryQueue([])
    } finally {
      setRetryLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isNew && id === WEBHOOK_RETRY_AUTOMATION_ID) loadRetryQueue()
  }, [id, isNew, loadRetryQueue])

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
    if (isWebhook) {
      return {
        name: name.trim(), description, active: active ? 1 : 0,
        kind: 'webhook', trigger_type: 'webhook',
        action_config: JSON.stringify(actionConfig),
        script,
      }
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

  async function handleRunDateRule() {
    if (!(await confirm({
      title: 'Lancer la règle de date',
      message: 'Évaluer la règle « comme aujourd\'hui » et déclencher les actions sur les enregistrements correspondants ? Cela peut envoyer de vrais emails / créer des tâches.',
      confirmLabel: 'Lancer',
      danger: true,
    }))) return
    setRunningDateRule(true)
    try {
      const res = await api.automations.runDateRule(id)
      addToast({ message: `${res.fired || 0} déclenchement(s) sur ${res.candidates || 0} candidat(s)`, type: 'success' })
      api.automations.fires(id, 50).then(setFires).catch(() => {})
      loadLogs()
    } catch (e) {
      addToast({ message: e.message || 'Erreur', type: 'error' })
    }
    setRunningDateRule(false)
  }

  async function handleDrainDeferred() {
    // Side effect: dispatches real actions (Slack/email/task/script) for up to one
    // batch of parked candidates.
    if (!(await confirm({
      title: 'Drainer la file',
      message: 'Traiter immédiatement un lot de candidats différés ? Cela déclenche les vraies actions (emails, tâches, scripts) sur les enregistrements concernés.',
      confirmLabel: 'Drainer',
      danger: true,
    }))) return
    setDraining(true)
    try {
      const res = await api.automations.drainDeferred(id)
      addToast({ message: `${res.fired || 0} déclenchement(s) — ${res.depth || 0} en file`, type: 'success' })
      await loadDeferredQueue()
      api.automations.fires(id, 50).then(setFires).catch(() => {})
      loadLogs()
    } catch (e) {
      addToast({ message: e.message || 'Erreur', type: 'error' })
    }
    setDraining(false)
  }

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

  async function handleRetryNow(retryId, moduleName) {
    // Side effect: forces an immediate re-sync against Airtable for this module.
    if (!(await confirm({
      title: 'Retenter maintenant',
      message: `Forcer immédiatement une nouvelle tentative de synchronisation du module « ${moduleName} » ? La file de retry due sera ré-exécutée.`,
      confirmLabel: 'Retenter',
      danger: false,
    }))) return
    setRetryingId(retryId)
    try {
      const data = await api.automations.retryNow(WEBHOOK_RETRY_AUTOMATION_ID, retryId)
      setRetryQueue(data.items || [])
      if (data.max_attempts != null) setRetryMaxAttempts(data.max_attempts)
      addToast({ message: 'Nouvelle tentative déclenchée', type: 'success' })
    } catch (e) {
      addToast({ message: e.message || 'Erreur lors du retry', type: 'error' })
    }
    setRetryingId(null)
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
    const langLabel = testLang === 'English' ? 'anglais' : 'français'
    if (!(await confirm({
      title: 'Envoyer un email de test',
      message: `Un email de test (${langLabel}) sera envoyé à ${testTo}. Il contient une bannière « TEST » et utilise un faux client — aucune tâche ni donnée réelle n'est créée.`,
      confirmLabel: 'Envoyer',
      danger: false,
    }))) return
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
    try {
      await api.automations.delete(id)
    } catch (e) {
      addToast({ message: e.message || 'Échec de la suppression de l\'automation', type: 'error' })
      return
    }
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
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-brand-50 text-brand-700 border border-brand-200">
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
                className="px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50">
                {saving ? 'Création...' : 'Créer'}
              </button>
            ) : (
              <span className="text-xs text-slate-400">{saving ? 'Sauvegarde…' : 'Sauvegardé'}</span>
            )}
          </div>
        </div>

        {isSystem && (
          <div className="bg-brand-50 border border-brand-200 rounded-lg px-4 py-3 text-sm text-brand-900">
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

        {/* Trigger — masqué pour les webhooks (le déclencheur est l'appel HTTP) */}
        {!isWebhook && (
        <div className="bg-white rounded-lg border p-5">
          <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
            Déclencheur
            {isFieldRule && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 border border-brand-200 font-medium">
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
        )}

        {isWebhook && (
          <WebhookEditor
            value={actionConfig}
            onChange={setActionConfig}
            script={script}
            onScriptChange={setScript}
            token={webhookToken}
            isNew={isNew}
            automationId={id}
          />
        )}

        {/* Retry queue — Airtable webhook router system automation */}
        {!isNew && id === WEBHOOK_RETRY_AUTOMATION_ID && (
          <RetryQueuePanel
            items={retryQueue}
            maxAttempts={retryMaxAttempts}
            loading={retryLoading}
            retryingId={retryingId}
            onRefresh={loadRetryQueue}
            onRetry={handleRetryNow}
          />
        )}

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
            <div className="max-w-md">
              <SearchableSelect
                testId="system-from-select"
                className="w-full border rounded-lg px-3 py-2 text-sm bg-white"
                size="sm"
                value={systemFrom}
                options={postmarkInfo?.addresses || []}
                getOptionValue={a => a}
                getOptionLabel={a => a}
                getOptionKey={a => a}
                onChange={setSystemFrom}
                emptyOption="— Défaut global —"
                placeholder="— Défaut global —"
                searchPlaceholder="Rechercher une adresse…"
              />
            </div>
          </div>
        )}

        {/* Action (field-rule only) */}
        {isFieldRule && (
          <div className="bg-white rounded-lg border p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold">Action</h2>
              <div className="flex gap-1">
                {['slack', 'email', 'task', 'script'].map(t => (
                  <button key={t} onClick={() => handleActionTypeChange(t)} disabled={false}
                    className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                      actionType === t
                        ? 'bg-brand-600 text-white'
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

        {/* Backpressure queue (field-rule only) */}
        {isFieldRule && !isNew && (
          <DeferredQueuePanel
            data={deferredQueue}
            loading={deferredLoading}
            draining={draining}
            onRefresh={loadDeferredQueue}
            onDrain={handleDrainDeferred}
          />
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
                {triggerConfig?.op === 'date_offset' && (
                  <button onClick={handleRunDateRule} disabled={runningDateRule}
                    className="px-3 py-1.5 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5"
                    data-testid="run-date-rule-btn">
                    {runningDateRule
                      ? <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> Exécution…</>
                      : <><Play size={13} /> Lancer maintenant</>}
                  </button>
                )}
                <button onClick={() => setShowTestModal(true)}
                  className="px-3 py-1.5 text-sm border border-brand-300 text-brand-700 rounded-lg hover:bg-brand-50 flex items-center gap-1.5">
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
                  className="px-3 py-1.5 text-sm border border-brand-300 text-brand-700 rounded-lg hover:bg-brand-50 disabled:opacity-50 flex items-center gap-1.5">
                  {manualRunning === 'dryRun'
                    ? <><div className="w-3 h-3 border-2 border-brand-700 border-t-transparent rounded-full animate-spin" /> Simulation...</>
                    : <><FlaskConical size={14} /> Simuler (dry-run)</>}
                </button>
                <button onClick={() => handleManualRun(false)} disabled={manualRunning !== null || !active}
                  title={!active ? 'Activez l\'automation avant de pouvoir la lancer manuellement' : ''}
                  className="px-3 py-1.5 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5">
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

        {/* Script — hidden for system automations, field-rules and webhooks */}
        {!isSystem && !isFieldRule && !isWebhook && (
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
              className="w-full border rounded-lg px-4 py-3 font-mono text-sm bg-gray-900 text-green-400 focus:outline-none focus:ring-2 focus:ring-brand-400"
              placeholder={"// Votre script ici...\nlog('Hello from automation!')\n\nif (record) {\n  updateRecord(record.id, { status: 'Traité' })\n}"} />
          </div>
        )}

        {/* Test + Résultat — hidden for system automations, field-rules and webhooks */}
        {!isNew && !isSystem && !isFieldRule && !isWebhook && (
          <div className="bg-white rounded-lg border p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold">Tester</h2>
              <button onClick={handleTest} disabled={testRunning}
                className="px-3 py-1.5 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5">
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

  // Date-relative trigger state. offset_days signé : négatif = avant, positif = après.
  const offsetDays = Number.isInteger(triggerConfig?.offset_days) ? triggerConfig.offset_days : -3
  const direction = offsetDays >= 0 ? 'after' : 'before'
  const magnitude = Math.abs(offsetDays)
  const filter = triggerConfig?.filter || null

  function handleOpChange(newOp) {
    const tc = { ...triggerConfig, op: newOp }
    if (newOp === 'date_offset') {
      if (!Number.isInteger(tc.offset_days)) tc.offset_days = -3
      delete tc.value
    } else {
      delete tc.offset_days
      delete tc.filter
    }
    onChange(tc)
  }
  function setOffset(mag, dir) {
    const m = Math.max(0, parseInt(mag, 10) || 0)
    onChange({ ...triggerConfig, offset_days: dir === 'before' ? -m : m })
  }
  function toggleFilter(on) {
    if (on) onChange({ ...triggerConfig, filter: { column: '', op: 'eq', value: '' } })
    else { const tc = { ...triggerConfig }; delete tc.filter; onChange(tc) }
  }
  function setFilter(patch) {
    onChange({ ...triggerConfig, filter: { ...(filter || {}), ...patch } })
  }
  const fop = filter?.op || 'eq'

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Table ERP</label>
          <SearchableSelect
            value={triggerConfig?.erp_table || ''}
            options={tables}
            getOptionValue={t => t}
            getOptionLabel={t => t}
            getOptionKey={t => t}
            emptyOption="— choisir —"
            onChange={v => onChange({ ...triggerConfig, erp_table: v, column: '' })}
            disabled={readOnly}
            placeholder="— choisir —"
            size="sm"
            className="w-full border rounded-lg px-3 py-2 text-sm bg-white disabled:bg-gray-50"
            testId="automation-erp-table"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Colonne</label>
          <SearchableSelect
            value={triggerConfig?.column || ''}
            options={cols}
            getOptionValue={c => c.column_name}
            getOptionLabel={c => c.airtable_field_name ? `${c.airtable_field_name} (${c.column_name})` : c.column_name}
            getOptionKey={c => c.column_name}
            emptyOption="— choisir —"
            onChange={v => onChange({ ...triggerConfig, column: v })}
            disabled={readOnly || !triggerConfig?.erp_table}
            placeholder="— choisir —"
            size="sm"
            className="w-full border rounded-lg px-3 py-2 text-sm bg-white disabled:bg-gray-50"
            testId="automation-column"
          />
        </div>
      </div>
      <div className="grid grid-cols-[180px_1fr] gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Opérateur</label>
          <select
            value={op}
            onChange={e => handleOpChange(e.target.value)}
            disabled={readOnly}
            className="w-full border rounded-lg px-3 py-2 text-sm bg-white disabled:bg-gray-50"
            data-testid="automation-op"
          >
            {Object.entries(OP_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {op !== 'not_null' && op !== 'date_offset' && (
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Valeur{op === 'in' ? ' (virgules)' : ''}
            </label>
            <input
              type={NUMERIC_OPS.has(op) ? 'number' : 'text'}
              step="any"
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
              placeholder={op === 'in' ? 'Hardware,Software' : (NUMERIC_OPS.has(op) ? '1' : 'Hardware')}
            />
          </div>
        )}
      </div>

      {/* Déclencheur de date relative — « N jours avant/après un champ date » */}
      {op === 'date_offset' && (
        <div className="rounded-lg border border-brand-200 bg-brand-50/40 p-3 space-y-3" data-testid="date-offset-panel">
          <div className="flex items-end gap-2 flex-wrap">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Nombre de jours</label>
              <input
                type="number" min="0" step="1"
                value={magnitude}
                onChange={e => setOffset(e.target.value, direction)}
                disabled={readOnly}
                className="w-24 border rounded-lg px-3 py-2 text-sm disabled:bg-gray-50"
                data-testid="date-offset-magnitude"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Sens</label>
              <select
                value={direction}
                onChange={e => setOffset(magnitude, e.target.value)}
                disabled={readOnly}
                className="border rounded-lg px-3 py-2 text-sm bg-white disabled:bg-gray-50"
                data-testid="date-offset-direction"
              >
                <option value="before">jours AVANT la date</option>
                <option value="after">jours APRÈS la date</option>
              </select>
            </div>
          </div>
          <p className="text-xs text-gray-600">
            Se déclenche chaque jour où <code className="bg-white border px-1 rounded">{triggerConfig?.column || 'la date'}</code>
            {' '}vaut <strong>aujourd'hui {direction === 'before' ? `+ ${magnitude}` : `− ${magnitude}`} jour{magnitude > 1 ? 's' : ''}</strong>
            {' '}(ex. « rappel {magnitude} jour{magnitude > 1 ? 's' : ''} {direction === 'before' ? 'avant' : 'après'} »). Évalué une fois par jour ; chaque enregistrement ne déclenche qu'une seule fois.
          </p>

          {/* Condition secondaire optionnelle (ET) */}
          {!filter ? (
            <button type="button" onClick={() => toggleFilter(true)} disabled={readOnly}
              className="text-xs text-brand-700 hover:underline disabled:opacity-50" data-testid="date-offset-add-filter">
              + Ajouter une condition (ET)
            </button>
          ) : (
            <div className="rounded-lg border bg-white p-3 space-y-2" data-testid="date-offset-filter">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-gray-600">Condition supplémentaire (ET)</span>
                <button type="button" onClick={() => toggleFilter(false)} disabled={readOnly}
                  className="text-xs text-red-600 hover:underline disabled:opacity-50">Retirer</button>
              </div>
              <div className="grid grid-cols-[1fr_160px] gap-2">
                <SearchableSelect
                  value={filter.column || ''}
                  options={cols}
                  getOptionValue={c => c.column_name}
                  getOptionLabel={c => c.airtable_field_name ? `${c.airtable_field_name} (${c.column_name})` : c.column_name}
                  getOptionKey={c => c.column_name}
                  emptyOption="— colonne —"
                  onChange={v => setFilter({ column: v })}
                  disabled={readOnly}
                  placeholder="— colonne —"
                  size="sm"
                  className="w-full border rounded-lg px-3 py-2 text-sm bg-white disabled:bg-gray-50"
                  testId="date-offset-filter-column"
                />
                <select value={fop} onChange={e => setFilter({ op: e.target.value })} disabled={readOnly}
                  className="w-full border rounded-lg px-3 py-2 text-sm bg-white disabled:bg-gray-50">
                  {Object.entries(FILTER_OP_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              {fop !== 'not_null' && (
                <input
                  type={NUMERIC_OPS.has(fop) ? 'number' : 'text'}
                  step="any"
                  value={fop === 'in'
                    ? (Array.isArray(filter.value) ? filter.value.join(',') : (filter.value || ''))
                    : (filter.value ?? '')}
                  onChange={e => {
                    const raw = e.target.value
                    setFilter({ value: fop === 'in' ? raw.split(',').map(s => s.trim()).filter(Boolean) : raw })
                  }}
                  disabled={readOnly}
                  className="w-full border rounded-lg px-3 py-2 text-sm disabled:bg-gray-50"
                  placeholder={fop === 'in' ? 'Impayée,En retard' : 'Impayée'}
                  data-testid="date-offset-filter-value"
                />
              )}
            </div>
          )}
        </div>
      )}

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
            <SearchableSelect
              testId="action-from-select"
              className="w-full border rounded-lg px-3 py-2 text-sm bg-white disabled:bg-gray-50"
              size="sm"
              value={actionConfig.from || ''}
              options={postmark?.addresses || []}
              getOptionValue={a => a}
              getOptionLabel={a => a}
              getOptionKey={a => a}
              onChange={v => onChange({ ...actionConfig, from: v || undefined })}
              emptyOption="— Défaut global —"
              placeholder="— Défaut global —"
              searchPlaceholder="Rechercher une adresse…"
              disabled={readOnly}
            />
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

      {actionType === 'script' && (
        <>
          <Field
            label="Script (JavaScript)"
            hint="Exécuté dans un bac à sable. Disponibles : row (l'enregistrement déclencheur), update(table, id, patch), query(sql) (SELECT only), fetch(url), sendEmail(to, sujet, html), log(...). Timeout 10s.">
            <textarea rows={10} value={actionConfig.script || ''}
              onChange={e => onChange({ ...actionConfig, script: e.target.value })} readOnly={readOnly}
              className="w-full border rounded-lg px-3 py-2 text-xs font-mono disabled:bg-gray-50"
              placeholder={"// row = l'enregistrement qui a déclenché la règle\nlog('Commande', row.id, '→ items', row.nombre_d_items)\n\n// Écriture whitelistée (tables: factures, products, orders, shipments, companies, contacts, serial_numbers)\nupdate('orders', row.id, { statut: 'À traiter' })"} />
          </Field>
          <label className="flex items-start gap-2 text-xs text-gray-600">
            <input type="checkbox" checked={!!actionConfig.allow_trigger_write}
              onChange={e => onChange({ ...actionConfig, allow_trigger_write: e.target.checked })}
              disabled={readOnly} className="mt-0.5" />
            <span>
              Autoriser l'écriture d'une colonne-déclencheur
              <span className="block text-[11px] text-gray-400">
                Par défaut, le script ne peut pas écrire une colonne utilisée comme déclencheur d'une règle active (garde anti-cycle). À cocher en connaissance de cause.
              </span>
            </span>
          </label>
        </>
      )}

      {/* Variables chips */}
      {actionType !== 'script' && allVars.length > 0 && (
        <div className="pt-3 border-t">
          <p className="text-xs text-gray-500 mb-2">Variables disponibles (cliquer pour copier) :</p>
          <div className="flex flex-wrap gap-1.5">
            {allVars.map(v => (
              <button key={v} type="button"
                onClick={() => navigator.clipboard?.writeText(`{{${v}}}`)}
                className="px-2 py-0.5 text-[11px] font-mono bg-gray-100 text-gray-700 rounded hover:bg-brand-100 hover:text-brand-700">
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

function RetryQueuePanel({ items, maxAttempts, loading, retryingId, onRefresh, onRetry }) {
  const list = items || []
  return (
    <div className="bg-white rounded-lg border p-5" data-testid="retry-queue-panel">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <AlertTriangle size={14} className={list.length ? 'text-amber-500' : 'text-gray-400'} />
            File de retry des webhooks
            {list.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
                {list.length}
              </span>
            )}
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Modules dont la synchronisation Airtable a échoué et qui seront re-tentés automatiquement.
            « Retenter maintenant » force un traitement immédiat.
          </p>
        </div>
        <button onClick={onRefresh} disabled={loading}
          className="px-2.5 py-1 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Actualiser
        </button>
      </div>

      {items == null ? (
        <p className="text-xs text-gray-400 italic">Chargement…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2"
          data-testid="retry-queue-empty">
          ✓ Aucun module en échec — la file de retry est vide.
        </p>
      ) : (
        <div className="border rounded-lg divide-y overflow-hidden">
          {list.map(item => (
            <div key={item.id} className="px-3 py-2.5 text-xs" data-testid="retry-queue-item">
              <div className="flex items-center gap-3 mb-1">
                <span className="font-mono font-medium text-gray-800">{item.module}</span>
                <span className={`px-1.5 py-0.5 rounded-full font-medium ${
                  item.attempts >= maxAttempts ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                }`}>
                  {item.attempts}/{maxAttempts} tentative{item.attempts > 1 ? 's' : ''}
                </span>
                <button onClick={() => onRetry(item.id, item.module)} disabled={retryingId === item.id}
                  className="ml-auto px-2.5 py-1 text-xs bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5"
                  data-testid="retry-now-btn">
                  {retryingId === item.id
                    ? <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> Retry…</>
                    : <><RefreshCw size={12} /> Retenter maintenant</>}
                </button>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-gray-500">
                <span>Ajouté : <span className="font-mono text-gray-600">{formatLocal(item.created_at)}</span></span>
                <span>Prochain retry : <span className="font-mono text-gray-600">{formatLocal(item.next_retry_at)}</span></span>
              </div>
              {item.last_error && (
                <pre className="mt-1.5 text-red-600 whitespace-pre-wrap break-all bg-red-50 border border-red-200 rounded p-2 max-h-32 overflow-y-auto">{item.last_error}</pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DeferredQueuePanel({ data, loading, draining, onRefresh, onDrain }) {
  const depth = data?.depth ?? null
  const items = data?.items || []
  const batchSize = data?.batch_size || 50
  const hasBacklog = depth > 0

  return (
    <div className="bg-white rounded-lg border p-5" data-testid="deferred-queue-panel">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Gauge size={14} className={hasBacklog ? 'text-amber-500' : 'text-gray-400'} />
            File d'attente (backpressure)
            {hasBacklog && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium"
                data-testid="deferred-depth-badge">
                {depth}
              </span>
            )}
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Candidats en excédent du lot de {batchSize} par évaluation. Un job de fond
            les draine automatiquement (~2 min) ; « Drainer maintenant » force un lot.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={onRefresh} disabled={loading}
            className="px-2.5 py-1 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5"
            data-testid="deferred-refresh-btn">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Actualiser
          </button>
          {hasBacklog && (
            <button onClick={onDrain} disabled={draining}
              className="px-2.5 py-1 text-xs bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5"
              data-testid="deferred-drain-btn">
              {draining
                ? <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> Drain…</>
                : <><Play size={12} /> Drainer maintenant</>}
            </button>
          )}
        </div>
      </div>

      {data == null ? (
        <p className="text-xs text-gray-400 italic">Chargement…</p>
      ) : !hasBacklog ? (
        <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2"
          data-testid="deferred-queue-empty">
          ✓ Aucun candidat différé — la règle est à jour.
        </p>
      ) : (
        <>
          {data.oldest_enqueued_at && (
            <p className="text-xs text-gray-500 mb-2">
              Plus ancien en file : <span className="font-mono text-gray-600">{formatLocal(data.oldest_enqueued_at)}</span>
            </p>
          )}
          <div className="border rounded-lg divide-y max-h-64 overflow-y-auto bg-gray-50">
            {items.map(it => (
              <div key={`${it.record_table}-${it.record_id}`} className="px-3 py-1.5 text-xs flex items-center gap-3"
                data-testid="deferred-queue-item">
                <span className="font-mono text-gray-500 w-36 shrink-0">{formatLocal(it.enqueued_at)}</span>
                <span className="font-mono text-gray-700">{it.record_table}</span>
                <span className="text-gray-400">·</span>
                <span className="font-mono text-gray-700 break-all">{it.record_id}</span>
              </div>
            ))}
          </div>
          {depth > items.length && (
            <p className="text-[11px] text-gray-400 mt-1.5">+{depth - items.length} autre(s) non affiché(s)</p>
          )}
        </>
      )}
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
                <div><span className="text-gray-500">Tireraient :</span> <strong className="text-brand-700">{result.would_fire}</strong></div>
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
                    ? 'bg-brand-50 border-brand-300 text-brand-700'
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
  return fmtDateTime(iso)
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
        className="text-brand-600 hover:text-brand-800 underline decoration-dotted break-all">
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
    <div className={`rounded-lg border p-3 ${isError ? 'bg-red-50 border-red-200' : (result.dryRun ? 'bg-brand-50 border-brand-200' : 'bg-green-50 border-green-200')}`}>
      <div className="flex items-center gap-2 text-sm mb-2">
        <span className={`font-medium ${isError ? 'text-red-700' : (result.dryRun ? 'text-brand-700' : 'text-green-700')}`}>
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
                'bg-brand-100 text-brand-700'
              }`}>
                {d.action}
              </span>
              {d.company_id ? (
                <Link to={`/companies/${d.company_id}`} className="font-medium text-brand-700 hover:underline"
                  onClick={e => e.stopPropagation()}>
                  {d.company_name || d.company_id}
                </Link>
              ) : (
                <span className="font-medium">{d.company_name || '—'}</span>
              )}
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
  // null = let the server pick the first candidate; otherwise a chosen record id.
  const [selectedRecordId, setSelectedRecordId] = useState(null)
  // Sticky candidate list so the picker doesn't flicker/empty while reloading.
  const [candidates, setCandidates] = useState([])

  const load = useCallback(async (lang, recordId) => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.automations.emailPreview(automationId, lang || language, recordId)
      setPreview(data)
      if (Array.isArray(data.candidates)) setCandidates(data.candidates)
    } catch (e) {
      setError(e.message || 'Erreur de chargement')
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automationId, language])

  // Initial load + reload on language / selected-record change
  useEffect(() => { load(language, selectedRecordId) }, [language, selectedRecordId, load])

  // For field-rule emails: reload preview ~800ms after the user stops editing
  // (action_config is autosaved server-side every 500ms, so we wait a bit longer).
  const actionKey = JSON.stringify(actionConfig || {})
  useEffect(() => {
    if (isSystem) return
    const t = setTimeout(() => load(language, selectedRecordId), 800)
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
          <button onClick={() => load(language, selectedRecordId)} disabled={loading}
            className="px-2.5 py-1 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Actualiser
          </button>
        </div>
      </div>

      {/* Record picker — choisir le record d'exemple à rendre avant d'activer la règle */}
      {candidates.length > 0 && (
        <div className="mb-3 flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-gray-600">Record d'exemple</span>
          <div className="min-w-[260px]">
            <SearchableSelect
              testId="email-preview-record-select"
              className="w-full border rounded-lg px-3 py-1.5 text-xs bg-white"
              size="sm"
              value={selectedRecordId || (preview?.sample_record?.id ?? '')}
              options={candidates}
              getOptionValue={c => c.id}
              getOptionLabel={c => `${c.label || c.id}${c.already_fired ? ' • déjà déclenché' : ''}`}
              getOptionKey={c => c.id}
              onChange={v => setSelectedRecordId(v || null)}
              placeholder="— premier candidat —"
              searchPlaceholder="Rechercher un record…"
            />
          </div>
          <span className="text-[11px] text-gray-400">
            {preview?.candidates_total != null
              ? `${preview.candidates_total} candidat${preview.candidates_total > 1 ? 's' : ''}`
              : `${candidates.length} record${candidates.length > 1 ? 's' : ''}`}
          </span>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {preview && preview.available === false && (
        <p className="text-sm text-gray-500 italic">{preview.reason || preview.error || 'Aperçu non disponible.'}</p>
      )}

      {preview && preview.available && preview.matches_trigger === false && (
        <div className="mb-3 text-xs px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 flex items-start gap-1.5">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          Ce record ne correspond pas (encore) au déclencheur de la règle — il ne recevrait pas le courriel en l'état. L'aperçu reste utile pour valider le rendu du template.
        </div>
      )}

      {preview && preview.available && preview.render_error && (
        <div className="mb-3 text-xs px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 flex items-start gap-1.5">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          Erreur de rendu du template : {preview.render_error}
        </div>
      )}

      {preview && preview.available && !preview.render_error && (
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
                className="text-xs text-brand-600 hover:text-brand-800 flex items-center gap-1">
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
