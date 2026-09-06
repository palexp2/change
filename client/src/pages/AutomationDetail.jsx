import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { ArrowLeft, Play, ChevronDown, Lock, FlaskConical, Mail, Zap, RotateCcw, X, Eye, RefreshCw, AlertTriangle, Gauge } from 'lucide-react'
import { useToast } from '../contexts/ToastContext.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { api } from '../lib/api.js'
import { fmtDateTime } from '../lib/formatDate.js'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { WebhookEditor } from '../components/WebhookEditor.jsx'
import { AUTOMATION_ACTION_LABELS as ACTION_TYPE_LABELS } from '../components/Badge.jsx'
// Alias : cette page a déjà un composant local `Field` (paramètres d'action).
import { Field as TableField } from '../components/Field.jsx'
import Spinner from '../components/Spinner.jsx'

// Mirrors MANUAL_RUNNERS in server/src/services/systemAutomations.js. Keep in sync.
const SYSTEM_MANUAL_RUNNABLE = new Set(['sys_installation_followup', 'sys_ctb_programmation_paiement', 'sys_treasury_alert', 'sys_paie_repartition', 'sys_card_payment_reminder', 'sys_card_ceiling_alert', 'sys_stripe_weekly_payout_push'])

// Connexion Google Sheets « CTB - Suivi » — config d'action éditable, trigger
// en lecture seule, bouton unique de diagnostic (aucune écriture).
const CTB_AUTOMATION_ID = 'sys_ctb_programmation_paiement'

// Mirrors SYSTEM_EMAIL_AUTOMATIONS in server/src/routes/automations.js — system
// automations whose `from` address is overridable via the picker.
const SYSTEM_EMAIL_AUTOMATIONS = new Set(['sys_installation_followup', 'sys_shipment_tracking_email'])

// System automation whose Airtable webhook retry queue is surfaced in the detail page.
// Mirrors the id gate in server/src/routes/automations.js (/:id/retry-queue).
const WEBHOOK_RETRY_AUTOMATION_ID = 'sys_airtable_webhook_router'

// Mirrors CONFIGURABLE_SYSTEM_AUTOMATIONS in server/src/services/systemAutomations.js —
// system automations whose action keys are user-editable.
const CONFIGURABLE_SYSTEM_AUTOMATIONS = new Set([
  'sys_revenue_recognition', CTB_AUTOMATION_ID,
  'sys_treasury_alert', 'sys_paie_repartition', 'sys_card_payment_reminder',
  'sys_card_ceiling_alert', 'sys_stripe_weekly_payout_push', 'sys_ticket_survey_slack',
  'sys_order_item_shipped_cost',
])

// Champs de config des automations à éditeur générique clé-valeur.
const GENERIC_CONFIG_FIELDS = {
  sys_pmt_suivi_sheet: {
    title: 'Reprise de l\'onglet Pmt_Suivi',
    intro: 'Fichier lu toutes les 30 minutes pour rapatrier les paiements émis saisis à la main. Vider un champ revient au défaut.',
    fields: [
      { key: 'file_id', label: 'Fichier (ID du Google Sheets)', def: '13rd8x_xy5AQJemDwE6yWp8ffvkj3bEo7kq3cuogRGyQ', hint: 'Défaut : CTB - Suivi. L\'ID est la portion entre /d/ et /edit dans l\'URL.' },
      { key: 'sheet_name', label: 'Onglet', def: 'Pmt_Suivi' },
      { key: 'google_account_email', label: 'Compte Google qui lit le fichier', def: '(le plus récemment connecté)', hint: 'Doit avoir accès au fichier (page Connecteurs).' },
      { key: 'since_date', label: 'Ne reprendre que les lignes à partir du (AAAA-MM-JJ)', def: '2026-01-01', hint: 'Plancher d\'import : l\'historique antérieur est déjà en base.' },
    ],
  },
  sys_treasury_alert: {
    title: 'Alerte trésorerie BNC',
    intro: 'Seuil et horizon de la projection, et canal Slack de l\'alerte. Slack ne reçoit qu\'un découvert imminent — tout le reste est loggé ici. Vider un champ revient au défaut.',
    fields: [
      { key: 'threshold', label: 'Seuil d\'alerte (CAD)', def: '5000' },
      { key: 'horizon_days', label: 'Horizon d\'affichage de la projection (jours)', def: '42' },
      { key: 'alert_horizon_days', label: 'Fenêtre d\'action (jours)', def: '14', hint: 'La trésorerie est gérée au fur et à mesure : l\'alerte et le virement suggéré ne regardent que cette fenêtre. Le point bas au-delà est affiché à titre indicatif.' },
      { key: 'slack_negative_only', label: 'Slack seulement si découvert (0 / 1)', def: '1', hint: '1 = Slack ne parle QUE si le solde projeté devient négatif (un point bas simplement sous le seuil de confort reste en « veille », visible ici et sur la page Trésorerie). 0 = comportement historique : le franchissement du seuil notifie aussi.' },
      { key: 'slack_negative_days', label: 'Fenêtre du découvert Slack (jours)', def: '3', hint: 'Un découvert projeté d\'ici ce nombre de jours envoie l\'alerte. Plus lointain : « veille », aucune notification.' },
      { key: 'slack_urgent_days', label: 'Fenêtre d\'urgence Slack (jours) — mode historique', def: '2', hint: 'Utilisé seulement si « Slack seulement si découvert » est à 0 : Slack parle si le seuil est franchi d\'ici ce nombre de jours.' },
      { key: 'stale_reminder_slack', label: 'Rappel Slack « solde non noté » (0 / 1)', def: '0', hint: '0 = rappel loggé seulement (tuile ambre sur la page Trésorerie). 1 = envoi Slack au plus une fois par 20 h.' },
      { key: 'variance_slack', label: 'Slack sur écart de réconciliation (0 / 1)', def: '0', hint: '0 = l\'écart entre le solde réel saisi et le solde projeté est journalisé seulement (visible sur la page Trésorerie). 1 = envoi Slack quand l\'écart dépasse la tolérance.' },
      { key: 'slack_webhook_env', label: 'Webhook Slack — nom de la variable d\'environnement', def: 'SLACK_WEBHOOK_TREASURY', hint: 'Créer un incoming webhook Slack vers le DM d\'Antoine Lambert et ajouter la variable dans server/.env.' },
    ],
  },
  sys_card_payment_reminder: {
    title: 'Rappel de paiement des cartes',
    intro: 'Le rappel part le dernier jour travaillé qui tombe encore avant la date cible. Vider un champ revient au défaut.',
    fields: [
      { key: 'cards', label: 'Cartes à rappeler', def: 'Visa CAD, Visa USD', hint: 'Texte libre repris tel quel dans le message Slack.' },
      { key: 'due_day', label: 'Date cible de paiement (jour du mois)', def: '24', hint: 'L\'échéance réelle des cartes est vers le 26-27 ; la cible du 24 garde une marge.' },
      { key: 'work_days', label: 'Jours travaillés', def: '2,6', hint: '0 = dimanche, 1 = lundi … 6 = samedi. Défaut « 2,6 » = mardi et samedi.' },
      { key: 'slack_webhook_env', label: 'Webhook Slack — nom de la variable d\'environnement', def: 'SLACK_WEBHOOK_PERSO', hint: 'Message privé Slack (DM Antoine Lambert), distinct du canal de l\'alerte trésorerie. Si la variable est absente de server/.env, repli sur SLACK_WEBHOOK_TREASURY (signalé dans le journal).' },
    ],
  },
  sys_card_ceiling_alert: {
    title: 'Plafond des cartes de crédit',
    intro: 'Périmètre et canal de l\'alerte. La limite, le plafond cible et le jour de prélèvement de CHAQUE carte se règlent sur la carte « Plafond des cartes » du dashboard comptabilité — un seul endroit. Vider un champ revient au défaut.',
    fields: [
      { key: 'acctnums', label: 'Comptes QuickBooks suivis (numéros)', def: '22000', hint: 'Séparés par des virgules. Une carte hors de cette liste reste affichée dans l\'ERP mais n\'alerte pas. 22000 = Mastercard Banque Nationale.' },
      { key: 'lead_days', label: 'Alerter combien de jours avant le prélèvement', def: '5' },
      { key: 'min_alert_amount', label: 'Dépassement minimal pour alerter ($)', def: '100', hint: 'Un franchissement de quelques dollars n\'est pas une information.' },
      { key: 'pending_lookback_days', label: 'Ancienneté maximale d\'une transaction « en attente » (jours)', def: '90', hint: 'Au-delà, une transaction du relevé encore non comptabilisée est un retard de tenue de livres, pas un achat qui manque au solde — son relevé est payé depuis longtemps. Elle est affichée à part, sans être comptée.' },
      { key: 'lead_always', label: 'Rappel systématique à J-N (0 / 1)', def: '0', hint: '0 = l\'alerte J-N ne part que s\'il y a réellement un paiement à faire. 1 = elle part chaque mois, même quand la carte est loin du plafond.' },
      { key: 'slack_channel', label: 'Canal ou personne Slack', def: '#comptabilite', hint: 'Passe par le bot Slack de l\'ERP et prime sur les deux champs webhook ci-dessous. Pour un canal privé, inviter le bot dans le canal.' },
      { key: 'slack_webhook_url', label: 'Webhook Slack — URL collée directement', def: '(aucune)', hint: 'Voie de secours si le bot n\'est pas utilisé.' },
      { key: 'slack_webhook_env', label: 'Webhook Slack — nom de la variable d\'environnement', def: 'SLACK_WEBHOOK_TREASURY', hint: 'Dernier recours : même canal que l\'alerte trésorerie.' },
    ],
  },
  sys_stripe_weekly_payout_push: {
    title: 'Comptabilisation QB des Stripe payouts',
    intro: 'Les payouts CAD sont déposés dans « Compte chèques Banque Nationale », les USD dans « Venn USD ». Vider un champ revient au défaut.',
    fields: [
      { key: 'push_since', label: 'Ne pousser que les payouts arrivés depuis (AAAA-MM-JJ)', def: '2026-04-21', hint: 'Borne de périmètre : tout payout antérieur est de l\'historique déjà comptabilisé autrement — il ne sera jamais poussé vers QuickBooks. Ne reculer cette date que si on sait exactement ce qu\'on fait.' },
      { key: 'max_batch', label: 'Payouts maximum par passage', def: '8', hint: 'Cap de sécurité : une semaine normale compte 2 payouts (1 CAD + 1 USD). L\'excédent est reporté au passage suivant et signalé sur Slack.' },
      { key: 'stale_alert_days', label: 'Alerte « en souffrance » après (jours)', def: '3', hint: 'Un payout réglé depuis plus de N jours toujours sans Deposit QB (bloqué par la garde, transactions non synchronisées…) est relancé sur Slack à chaque passage jusqu\'à résolution.' },
      { key: 'slack_on_success', label: 'Résumé Slack des passages réussis (0 / 1)', def: '0', hint: '0 = Slack ne parle que quand quelque chose coince (bloqué, erreur, payout en souffrance) ; un passage qui n\'a fait que pousser des dépôts reste dans le journal. 1 = résumé de chaque passage.' },
      { key: 'slack_webhook_env', label: 'Webhook Slack — nom de la variable d\'environnement', def: 'SLACK_WEBHOOK_TREASURY', hint: 'Canal du résumé (payouts bloqués, en erreur, en souffrance). Même canal que l\'alerte trésorerie par défaut.' },
    ],
  },
  sys_ticket_survey_slack: {
    title: 'Alerte Slack du sondage de satisfaction',
    intro: 'Destinataire de l\'alerte et seuil de note basse. Le plus simple : écrire le canal ou la personne dans le premier champ — le bot Slack de l\'ERP s\'occupe du reste, aucun webhook à créer. Vider un champ revient au défaut.',
    fields: [
      { key: 'slack_channel', label: 'Canal ou personne Slack', def: '(aucun — repli sur le webhook)', hint: 'Exemples : « #support », « @philippe », ou son courriel pour un message privé. Passe par le bot Slack (SLACK_BOT_TOKEN) et prime sur les deux champs webhook ci-dessous. Pour un canal privé, inviter le bot dans le canal.' },
      { key: 'slack_webhook_url', label: 'Webhook Slack — URL collée directement', def: '(aucune)', hint: 'Voie de secours si le bot n\'est pas utilisé : URL d\'un incoming webhook, figée sur un seul canal.' },
      { key: 'slack_webhook_env', label: 'Webhook Slack — nom de la variable d\'environnement', def: 'SLACK_WEBHOOK_PHILIPPE', hint: 'Dernier recours. Si la variable est absente de server/.env, le message part sur SLACK_WEBHOOK_TREASURY avec un préfixe d\'avertissement.' },
      { key: 'recipient', label: 'Nom du destinataire (affichage)', def: 'Philippe', hint: 'Sert uniquement au libellé du message de repli.' },
      { key: 'low_rating_max', label: 'Note maximale considérée « insatisfait »', def: '2', hint: 'Une note inférieure ou égale déclenche l\'alerte. Les notes supérieures n\'alertent que si le client accepte un appel ou modifie sa réponse.' },
    ],
  },
  sys_paie_repartition: {
    title: 'Répartition de la paie — comptes et pourcentages',
    intro: 'Format des répartitions : « compte:poids, compte:poids, … ». Vider un champ revient au défaut.',
    fields: [
      { key: 'splits', label: 'Répartition de la paie (%)', def: '62100:33.6, 62200:5.1, 62201:11.8, 62300:49.5' },
      { key: 'source_acctnum', label: 'Compte source (crédité — paie comptabilisée là initialement)', def: '62200' },
      { key: 'phone_acctnum', label: 'Compte téléphone Martin', def: '76000' },
      { key: 'phone_amount', label: 'Montant téléphone par paie ($, taxes incluses)', def: '25' },
      { key: 'meals_acctnum', label: 'Compte allocation repas', def: '75930' },
      { key: 'reimb_acctnum', label: 'Compte remb. dépenses (23XXX)', def: '', hint: 'Vide = les remboursements restent dans le compte source (avertissement dans l\'aperçu).' },
      { key: 'aga_splits', label: 'Prorata AGA (poids par compte)', def: '62100:890.86, 62200:311.78, 62201:260.11, 62300:1275.20', hint: 'Pas de compte d\'assurance : la prime est ventilée dans les comptes de salaires. Poids = montants réels des dépenses QB d\'avril à juillet 2026 (32,5375 / 11,3874 / 9,5002 / 46,575 %).' },
      { key: 'aga_source_acctnum', label: 'Compte bancaire AGA (débité)', def: '10000', hint: 'Compte d\'où sort le prélèvement — porté sur la dépense elle-même (10000 · BNC).' },
      { key: 'aga_vendor_name', label: 'Fournisseur QB de l\'AGA', def: 'Groupe Financier AGA' },
      { key: 'aga_taxcode', label: 'Code de taxe AGA', def: 'Exonéré', hint: 'Doit être un code à 0 % — la prime d\'assurance est exonérée. Un code taxable est refusé à la publication.' },
      { key: 'aga_memo', label: 'Mémo de la dépense AGA', def: 'AGA ASS. COLL. (répartition au prorata entre les départements)' },
    ],
  },
}
// Sous-ensemble dont la condition de déclenchement est aussi éditable (le CTB
// n'en fait pas partie : son trigger vit dans le code, lecture seule). Les
// tables offertes reflètent CONFIGURABLE_SYSTEM_SPECS.allowedTables
// (server/src/routes/automations.js) — un PATCH sur une autre table est refusé.
const CONFIGURABLE_TRIGGER_TABLES = {
  sys_revenue_recognition: [
    { value: 'shipments', label: 'Envois (shipments)' },
    { value: 'factures', label: 'Factures' },
  ],
  sys_order_item_shipped_cost: [
    { value: 'order_items', label: 'Lignes de commande (order_items)' },
  ],
}
const CONFIGURABLE_TRIGGER_AUTOMATIONS = new Set(Object.keys(CONFIGURABLE_TRIGGER_TABLES))

// Comptes QB éditables du constat de vente — mirrors REVREC_ACCOUNT_OVERRIDES
// (server/src/services/quickbooks.js). `hint` explique le rôle Dr/Cr du compte.
const REVREC_ACCOUNT_FIELDS = [
  { key: 'deferred_acctnum', label: 'Passif — revenus perçus d\'avance', def: '23900', hint: 'Débité quand la commande était déjà encaissée (libère le passif)' },
  { key: 'sale_acctnum', label: 'Revenu — ventes', def: '40000', hint: 'Crédité à chaque constat (le revenu constaté)' },
  { key: 'ar_cad_acctnum', label: 'Comptes clients CAD', def: '12000', hint: 'Débité pour une commande non payée en CAD (vente à crédit)' },
  { key: 'ar_usd_acctnum', label: 'Comptes clients USD', def: '12100', hint: 'Débité pour une commande non payée en USD (vente à crédit)' },
]

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
  const isConfigurableSystem = isSystem && CONFIGURABLE_SYSTEM_AUTOMATIONS.has(id)
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
      } else if (auto.system && CONFIGURABLE_SYSTEM_AUTOMATIONS.has(auto.id)) {
        try { setActionConfig(JSON.parse(auto.action_config || '{}')) } catch { setActionConfig({}) }
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
      if (CONFIGURABLE_SYSTEM_AUTOMATIONS.has(id)) {
        // Le serveur ne retient que la condition (colonne/op/valeur) et les clés
        // d'action whitelistées — le reste du config reste verrouillé côté serveur.
        // Le trigger n'est envoyé que si éditable (le serveur rejette sinon).
        if (CONFIGURABLE_TRIGGER_AUTOMATIONS.has(id)) body.trigger_config = JSON.stringify(triggerConfig)
        body.action_config = JSON.stringify(actionConfig)
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
    const liveMessage = id === 'sys_stripe_weekly_payout_push'
      ? 'Lancer maintenant ? Les payouts Stripe en attente seront comptabilisés pour vrai dans QuickBooks (création de Deposits).'
      : 'Lancer maintenant ? Cela peut envoyer de vrais emails aux clients ciblés.'
    if (!dryRun && !(await confirm({ title: 'Lancer en mode live', message: liveMessage, confirmLabel: 'Lancer', danger: true }))) return
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
            <PageTitle>
              {isNew ? 'Nouvelle automation' : name}
              {isSystem && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-brand-50 text-brand-700 border border-brand-200">
                  <Lock size={12} /> Système
                </span>
              )}
            </PageTitle>
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
            {id === CTB_AUTOMATION_ID
              ? <>Cette automation est intégrée au code de l'application, mais la <strong>connexion au fichier Google Sheets</strong> (fichier, onglet, compte Google) est configurable ci-dessous. Le déclencheur vit dans le code.</>
              : id === 'sys_revenue_recognition'
              ? <>Cette automation est intégrée au code de l'application, mais sa <strong>condition de déclenchement</strong> et ses <strong>comptes QuickBooks</strong> sont configurables ci-dessous. Le comportement (idempotence, file de retry) reste géré par le code.</>
              : isConfigurableSystem && CONFIGURABLE_TRIGGER_AUTOMATIONS.has(id)
              ? <>Cette automation est intégrée au code de l'application, mais sa <strong>condition de déclenchement</strong> est configurable ci-dessous. Le calcul lui-même reste géré par le code.</>
              : isConfigurableSystem
              ? <>Cette automation est intégrée au code de l'application, mais sa <strong>configuration</strong> est modifiable ci-dessous. Son déclencheur et son comportement restent gérés par le code.</>
              : <>Cette automation est intégrée au code de l'application. Son trigger, son comportement et son script sont en lecture seule. Seul le statut (actif/inactif) peut être modifié.</>}
          </div>
        )}

        {/* Infos générales */}
        <div className="bg-white rounded-lg border p-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <TableField table="automations" id="name" label="Nom" variant="form" >
              <input type="text" value={name} onChange={e => setName(e.target.value)} disabled={isSystem}
                className="input disabled:bg-gray-50 disabled:text-gray-600" />
            </TableField>
            <TableField table="automations" id="active" label="Statut" variant="form" >
              <label className="flex items-center gap-2 mt-2 cursor-pointer">
                <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
                <span className="text-sm">{active ? 'Activée' : 'Désactivée'}</span>
              </label>
            </TableField>
          </div>
          <TableField table="automations" id="description" label={isSystem ? 'Comportement' : 'Description'} variant="form" >
            {isSystem ? (
              <div className="input bg-gray-50 text-gray-700 whitespace-pre-wrap leading-relaxed">
                {description || '—'}
              </div>
            ) : (
              <input type="text" value={description} onChange={e => setDescription(e.target.value)}
                className="input" />
            )}
          </TableField>
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
          ) : isConfigurableSystem && CONFIGURABLE_TRIGGER_AUTOMATIONS.has(id) ? (
            <ConfigurableSystemTriggerEditor
              triggerConfig={triggerConfig}
              onChange={setTriggerConfig}
              tables={CONFIGURABLE_TRIGGER_TABLES[id]}
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

        {/* Comptes QB — automation système configurable (constat de vente) */}
        {isConfigurableSystem && id === 'sys_revenue_recognition' && (
          <RevRecAccountsEditor actionConfig={actionConfig} onChange={setActionConfig} />
        )}

        {/* Connexion Google Sheets — CTB - Suivi (programmation des paiements) */}
        {isSystem && id === CTB_AUTOMATION_ID && (
          <CtbSheetConfigEditor actionConfig={actionConfig} onChange={setActionConfig} />
        )}

        {/* Config générique clé-valeur (trésorerie, répartition de paie) */}
        {isSystem && GENERIC_CONFIG_FIELDS[id] && (
          <GenericConfigEditor
            spec={GENERIC_CONFIG_FIELDS[id]}
            actionConfig={actionConfig}
            onChange={setActionConfig}
          />
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
                className="input"
                size="sm"
                value={systemFrom}
                options={postmarkInfo?.addresses || []}
                getOptionValue={a => a}
                getOptionLabel={a => a}
                getOptionKey={a => a}
                onChange={setSystemFrom}
                emptyOption="— Défaut global —"
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
                <h2 className="text-sm font-semibold">
                  {id === CTB_AUTOMATION_ID ? 'Tester la connexion' : 'Exécution manuelle'}
                </h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  {id === CTB_AUTOMATION_ID
                    ? <>Vérifie l'accès au fichier Google Sheets et localise l'onglet et les sections utilisés. <strong>Aucune écriture</strong> n'est faite dans le fichier.</>
                    : id === 'sys_stripe_weekly_payout_push'
                    ? <>Le <strong>dry-run</strong> synchronise les payouts puis montre ce qui serait poussé, bloqué par la garde ou en souffrance — <strong>aucun Deposit créé</strong>, aucun Slack.
                      Le <strong>lancement</strong> comptabilise pour vrai dans QuickBooks.</>
                    : <>Le <strong>dry-run</strong> liste les clients qui seraient ciblés sans rien envoyer ni persister.
                      Le <strong>lancement</strong> déclenche immédiatement l'automation (envois, flags, logs inclus).</>}
                </p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => handleManualRun(true)} disabled={manualRunning !== null}
                  data-testid="manual-dry-run"
                  className="px-3 py-1.5 text-sm border border-brand-300 text-brand-700 rounded-lg hover:bg-brand-50 disabled:opacity-50 flex items-center gap-1.5">
                  {manualRunning === 'dryRun'
                    ? <><div className="w-3 h-3 border-2 border-brand-700 border-t-transparent rounded-full animate-spin" /> {id === CTB_AUTOMATION_ID ? 'Test...' : 'Simulation...'}</>
                    : <><FlaskConical size={14} /> {id === CTB_AUTOMATION_ID ? 'Tester la connexion' : 'Simuler (dry-run)'}</>}
                </button>
                {id !== CTB_AUTOMATION_ID && (
                <button onClick={() => handleManualRun(false)} disabled={manualRunning !== null || !active}
                  title={!active ? 'Activez l\'automation avant de pouvoir la lancer manuellement' : ''}
                  className="px-3 py-1.5 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5">
                  {manualRunning === 'live'
                    ? <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> Exécution...</>
                    : <><Play size={14} /> Lancer maintenant</>}
                </button>
                )}
              </div>
            </div>
            {manualResult && <ManualRunResult result={manualResult} />}

            {id === 'sys_installation_followup' && (
            <div className="mt-4 pt-4 border-t">
              <div className="flex items-end gap-2 flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <label className="label">Envoyer un email de test</label>
                  <input type="email" value={testTo} onChange={e => setTestTo(e.target.value)}
                    className="w-full border rounded-lg px-3 py-1.5 text-sm" />
                </div>
                <div>
                  <label className="label">Langue</label>
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
            )}
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
              className="w-full border rounded-lg px-4 py-3 font-mono text-sm bg-gray-900 text-green-400 focus:outline-none focus:ring-2 focus:ring-brand-400" />
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
          <label className="label">Table ERP</label>
          <SearchableSelect
            value={triggerConfig?.erp_table || ''}
            options={tables}
            getOptionValue={t => t}
            getOptionLabel={t => t}
            getOptionKey={t => t}
            emptyOption="— choisir —"
            onChange={v => onChange({ ...triggerConfig, erp_table: v, column: '' })}
            disabled={readOnly}
            size="sm"
            className="input disabled:bg-gray-50"
            testId="automation-erp-table"
          />
        </div>
        <div>
          <label className="label">Colonne</label>
          <SearchableSelect
            value={triggerConfig?.column || ''}
            options={cols}
            getOptionValue={c => c.column_name}
            getOptionLabel={c => c.airtable_field_name ? `${c.airtable_field_name} (${c.column_name})` : c.column_name}
            getOptionKey={c => c.column_name}
            emptyOption="— choisir —"
            onChange={v => onChange({ ...triggerConfig, column: v })}
            disabled={readOnly || !triggerConfig?.erp_table}
            size="sm"
            className="input disabled:bg-gray-50"
            testId="automation-column"
          />
        </div>
      </div>
      <div className="grid grid-cols-[180px_1fr] gap-3">
        <div>
          <label className="label">Opérateur</label>
          <select
            value={op}
            onChange={e => handleOpChange(e.target.value)}
            disabled={readOnly}
            className="input disabled:bg-gray-50"
            data-testid="automation-op"
          >
            {Object.entries(OP_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {op !== 'not_null' && op !== 'date_offset' && (
          <div>
            <label className="label">
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
              className="input disabled:bg-gray-50"
            />
          </div>
        )}
      </div>

      {/* Déclencheur de date relative — « N jours avant/après un champ date » */}
      {op === 'date_offset' && (
        <div className="rounded-lg border border-brand-200 bg-brand-50/40 p-3 space-y-3" data-testid="date-offset-panel">
          <div className="flex items-end gap-2 flex-wrap">
            <div>
              <label className="label">Nombre de jours</label>
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
              <label className="label">Sens</label>
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
                  size="sm"
                  className="input disabled:bg-gray-50"
                  testId="date-offset-filter-column"
                />
                <select value={fop} onChange={e => setFilter({ op: e.target.value })} disabled={readOnly}
                  className="input disabled:bg-gray-50">
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
                  className="input disabled:bg-gray-50"
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
              className="input-mono disabled:bg-gray-50" />
          </Field>
          <Field label="Texte (template)">
            <textarea rows={4} value={actionConfig.text || ''}
              onChange={e => onChange({ ...actionConfig, text: e.target.value })} readOnly={readOnly}
              className="input-mono disabled:bg-gray-50" />
          </Field>
        </>
      )}

      {actionType === 'email' && (
        <>
          <Field label="Expéditeur" hint={postmark?.default_from ? `Vide = défaut global (${postmark.default_from})` : 'Vide = défaut global Postmark'}>
            <SearchableSelect
              testId="action-from-select"
              className="input disabled:bg-gray-50"
              size="sm"
              value={actionConfig.from || ''}
              options={postmark?.addresses || []}
              getOptionValue={a => a}
              getOptionLabel={a => a}
              getOptionKey={a => a}
              onChange={v => onChange({ ...actionConfig, from: v || undefined })}
              emptyOption="— Défaut global —"
              searchPlaceholder="Rechercher une adresse…"
              disabled={readOnly}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Destinataire (env var)" hint="POSTMARK_TO_OPS, ou laisser vide et utiliser le champ direct ci-dessous">
              <input type="text" value={actionConfig.toEnv || ''}
                onChange={e => onChange({ ...actionConfig, toEnv: e.target.value })} readOnly={readOnly}
                className="input-mono disabled:bg-gray-50" />
            </Field>
            <Field label="Destinataire (direct)">
              <input type="text" value={actionConfig.to || ''}
                onChange={e => onChange({ ...actionConfig, to: e.target.value })} readOnly={readOnly}
                className="input disabled:bg-gray-50" />
            </Field>
          </div>
          <Field label="Sujet">
            <input type="text" value={actionConfig.subject || ''}
              onChange={e => onChange({ ...actionConfig, subject: e.target.value })} readOnly={readOnly}
              className="input disabled:bg-gray-50" />
          </Field>
          <Field label="Corps HTML">
            <textarea rows={6} value={actionConfig.bodyHtml || ''}
              onChange={e => onChange({ ...actionConfig, bodyHtml: e.target.value })} readOnly={readOnly}
              className="w-full border rounded-lg px-3 py-2 text-xs font-mono disabled:bg-gray-50" />
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
              className="input disabled:bg-gray-50" />
          </Field>
          <Field label="Description">
            <textarea rows={4} value={actionConfig.description || ''}
              onChange={e => onChange({ ...actionConfig, description: e.target.value })} readOnly={readOnly}
              className="input-mono disabled:bg-gray-50" />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Priorité">
              <select value={actionConfig.priority || 'Normal'}
                onChange={e => onChange({ ...actionConfig, priority: e.target.value })} disabled={readOnly}
                className="input disabled:bg-gray-50">
                <option>Basse</option><option>Normal</option><option>Haute</option><option>Urgent</option>
              </select>
            </Field>
            <Field label="Échéance (jours)">
              <input type="number" min="0" value={actionConfig.due_in_days ?? ''}
                onChange={e => {
                  const n = e.target.value === '' ? null : parseInt(e.target.value, 10)
                  onChange({ ...actionConfig, due_in_days: isNaN(n) ? null : n })
                }} readOnly={readOnly}
                className="input disabled:bg-gray-50" />
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
              className="w-full border rounded-lg px-3 py-2 text-xs font-mono disabled:bg-gray-50" />
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
      <label className="label">{label}</label>
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
        <p className="text-xs text-gray-400 italic"><Spinner size="xs" label="Chargement…" /></p>
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
        <p className="text-xs text-gray-400 italic"><Spinner size="xs" label="Chargement…" /></p>
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
          {loading && <p className="text-sm text-gray-500"><Spinner size="xs" label="Chargement…" /></p>}
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
          className="input">
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
              className="input-mono" />
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
      {!isError && out.hint && (
        <p className="text-xs text-gray-600 mb-2">{out.hint}</p>
      )}
      {/* Diagnostic CTB - Suivi : factures actuellement programmées dans le sheet */}
      {!isError && Array.isArray(out.existing) && out.existing.length > 0 && (
        <div className="max-h-72 overflow-y-auto border rounded bg-white divide-y" data-testid="ctb-existing-rows">
          {out.existing.map((e, i) => (
            <div key={i} className="px-3 py-1.5 text-xs flex items-center gap-3">
              <span className="font-medium flex-1">{e.vendor}</span>
              <span className="text-gray-700 font-mono">{e.amount}</span>
              <span className="text-gray-500">dû {e.due || '—'}</span>
              <span className="text-brand-700">paiement {e.prog || '—'}</span>
            </div>
          ))}
        </div>
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
      {!isError && details.length === 0 && !out.summary && (
        <p className="text-xs text-gray-500 italic">Aucun client éligible actuellement.</p>
      )}
    </div>
  )
}

// Éditeur de condition pour une automation système configurable : table,
// colonne — y compris champs personnalisés — opérateur et valeur. Les tables
// offertes viennent de CONFIGURABLE_TRIGGER_TABLES (miroir de
// CONFIGURABLE_SYSTEM_SPECS.allowedTables côté serveur). La source (watcher
// change_log) reste affichée en lecture seule.
function ConfigurableSystemTriggerEditor({ triggerConfig, onChange, tables }) {
  const [fieldDefs, setFieldDefs] = useState({ columns: [] })
  const tableChoices = tables?.length ? tables : CONFIGURABLE_TRIGGER_TABLES.sys_revenue_recognition
  const erpTable = triggerConfig?.erp_table || tableChoices[0].value

  useEffect(() => {
    // includeCustom : la condition peut cibler un champ personnalisé (lookup,
    // rollup, formule) — le watcher interroge alors la vue <table>_v.
    api.automations.ruleFieldDefs(erpTable, { includeCustom: true })
      .then(setFieldDefs)
      .catch(() => setFieldDefs({ columns: [] }))
  }, [erpTable])

  const op = triggerConfig?.op || 'eq'
  const cols = fieldDefs.columns || []
  // Pas de date_offset ici — le watcher réagit aux écritures, pas au calendrier.
  const opChoices = Object.entries(OP_LABELS).filter(([v]) => v !== 'date_offset')

  return (
    <div className="space-y-3" data-testid="configurable-system-trigger">
      <div className="flex gap-3 text-sm">
        <span className="w-28 text-gray-500 shrink-0">Source</span>
        <span className="text-gray-800 font-mono text-xs break-all">{triggerConfig?.source || '—'}</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Table ERP</label>
          <SearchableSelect
            value={erpTable}
            options={tableChoices}
            getOptionValue={t => t.value}
            getOptionLabel={t => t.label}
            getOptionKey={t => t.value}
            onChange={v => onChange({ ...triggerConfig, erp_table: v, column: '' })}
            size="sm"
            className="input"
            testId="revrec-trigger-table"
          />
        </div>
        <div>
          <label className="label">Colonne</label>
          <SearchableSelect
            value={triggerConfig?.column || ''}
            options={cols}
            getOptionValue={c => c.column_name}
            getOptionLabel={c => c.airtable_field_name ? `${c.airtable_field_name} (${c.column_name})` : c.column_name}
            getOptionKey={c => c.column_name}
            emptyOption="— choisir —"
            onChange={v => onChange({ ...triggerConfig, column: v })}
            size="sm"
            className="input"
            testId="revrec-trigger-column"
          />
        </div>
      </div>
      <div className="grid grid-cols-[180px_1fr] gap-3">
        <div>
          <label className="label">Opérateur</label>
          <select
            value={op}
            onChange={e => {
              const tc = { ...triggerConfig, op: e.target.value }
              if (e.target.value === 'not_null') delete tc.value
              onChange(tc)
            }}
            className="input"
            data-testid="revrec-trigger-op"
          >
            {opChoices.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {op !== 'not_null' && (
          <div>
            <label className="label">
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
              className="input"
              data-testid="revrec-trigger-value"
            />
          </div>
        )}
      </div>
      <p className="text-xs text-gray-500">
        {erpTable === 'order_items'
          ? <>Le gel est déclenché à chaque écriture DB d'une ligne de commande qui satisfait cette condition
              (toute origine : fiche commande, mode expédition, Novoxpress, sync Airtable des envois). Une
              ligne dont le coût est déjà gelé n'est jamais recalculée.</>
          : erpTable === 'factures'
          ? <>La facture qui satisfait cette condition est constatée directement. Elle est réévaluée à chaque
              écriture DB de la facture, de sa commande ou d'un envoi de la commande (toute origine : UI,
              Novoxpress, sync Airtable) — utile pour déclencher sur un champ personnalisé de type lookup
              (ex. « Date d'envoi de la commande liée » est renseignée).</>
          : <>Le constat est déclenché à chaque écriture DB d'un envoi qui satisfait cette condition
              (toute origine : UI, Novoxpress, sync Airtable). Un envoi doit aussi être lié à une commande.</>}
      </p>
    </div>
  )
}

// Comptes QB du constat de vente — overrides par AcctNum, vide = défaut.
function RevRecAccountsEditor({ actionConfig, onChange }) {
  return (
    <div className="bg-white rounded-lg border p-5" data-testid="revrec-accounts">
      <h2 className="text-sm font-semibold mb-1">Comptes QuickBooks</h2>
      <p className="text-xs text-gray-500 mb-4">
        Numéros de compte (AcctNum) utilisés par l'écriture de journal du constat de vente.
        Vider un champ revient au compte par défaut. Un numéro introuvable en QB bloque le
        constat avec une erreur explicite (visible dans les exécutions ci-dessous).
      </p>
      <div className="grid grid-cols-2 gap-4">
        {REVREC_ACCOUNT_FIELDS.map(f => (
          <div key={f.key}>
            <label className="label">{f.label}</label>
            <input
              type="text"
              value={actionConfig?.[f.key] ?? ''}
              onChange={e => onChange({ ...actionConfig, [f.key]: e.target.value })}
              placeholder={f.def}
              className="input-mono"
              data-testid={`revrec-account-${f.key}`}
            />
            <p className="text-[11px] text-gray-400 mt-1">{f.hint} — défaut {f.def}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// Jours de paiement offerts pour la programmation CTB (ISO : 1=lundi … 7=dimanche).
const CTB_WEEKDAYS = [
  { value: '1', label: 'Lundi' }, { value: '2', label: 'Mardi' }, { value: '3', label: 'Mercredi' },
  { value: '4', label: 'Jeudi' }, { value: '5', label: 'Vendredi' }, { value: '6', label: 'Samedi' },
  { value: '7', label: 'Dimanche' },
]

// Défauts affichés en placeholder — mirrors CTB_DEFAULT_CONFIG (services/ctbSheet.js).
const CTB_DEFAULTS = {
  spreadsheet_id: '13rd8x_xy5AQJemDwE6yWp8ffvkj3bEo7kq3cuogRGyQ',
  sheet_name: 'Sommaire',
  section_header: 'PROGRAMMATION DES FACTURES À PAYER',
  google_account_email: 'pap@orisha.io',
}

// Accepte l'URL complète du Google Sheets collée telle quelle et en extrait l'ID.
function extractSpreadsheetId(raw) {
  const m = /\/d\/([A-Za-z0-9_-]{20,})/.exec(raw || '')
  return m ? m[1] : (raw || '').trim()
}

// Connexion Google Sheets « CTB - Suivi » : fichier, onglet, section(s), jour
// de paiement et compte Google.
function CtbSheetConfigEditor({ actionConfig, onChange }) {
  const [googleAccounts, setGoogleAccounts] = useState([])
  useEffect(() => {
    api.connectors.gmailAccounts().then(setGoogleAccounts).catch(() => setGoogleAccounts([]))
  }, [])

  const set = (key, value) => onChange({ ...actionConfig, [key]: value })
  const spreadsheetId = actionConfig?.spreadsheet_id ?? ''
  const defaults = CTB_DEFAULTS

  return (
    <div className="bg-white rounded-lg border p-5" data-testid="ctb-sheet-config">
      <h2 className="text-sm font-semibold mb-1">Connexion Google Sheets</h2>
      <p className="text-xs text-gray-500 mb-4">
        Fichier et sections où les factures à payer sont programmées puis marquées payées.
        Vider un champ revient au défaut. Le compte Google doit avoir accès en écriture au fichier
        et avoir été connecté depuis la page Connecteurs <strong>après</strong> l'ajout du scope Sheets.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label className="label">Fichier (ID ou URL du Google Sheets)</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={spreadsheetId}
              onChange={e => set('spreadsheet_id', extractSpreadsheetId(e.target.value))}
              placeholder={CTB_DEFAULTS.spreadsheet_id}
              className="flex-1 border rounded-lg px-3 py-2 text-sm font-mono"
              data-testid="ctb-spreadsheet-id"
            />
            <a
              href={`https://docs.google.com/spreadsheets/d/${spreadsheetId || CTB_DEFAULTS.spreadsheet_id}/edit`}
              target="_blank" rel="noreferrer"
              className="text-xs text-brand-600 hover:underline whitespace-nowrap">
              Ouvrir le fichier ↗
            </a>
          </div>
          <p className="text-[11px] text-gray-400 mt-1">Coller l'URL complète fonctionne — l'ID est extrait automatiquement. Défaut : CTB - Suivi.</p>
        </div>
        <div>
          <label className="label">Onglet</label>
          <input
            type="text"
            value={actionConfig?.sheet_name ?? ''}
            onChange={e => set('sheet_name', e.target.value)}
            placeholder={defaults.sheet_name}
            className="input"
            data-testid="ctb-sheet-name"
          />
        </div>
        <div>
          <label className="label">Titre de la section (programmation)</label>
          <input
            type="text"
            value={actionConfig?.section_header ?? ''}
            onChange={e => set('section_header', e.target.value)}
            placeholder={CTB_DEFAULTS.section_header}
            className="input"
            data-testid="ctb-section-header"
          />
          <p className="text-[11px] text-gray-400 mt-1">Recherché dans l'onglet, insensible à la casse et aux accents.</p>
        </div>
        <div>
          <label className="label">Titre de la section (factures payées)</label>
          <input
            type="text"
            value={actionConfig?.paid_section_header ?? ''}
            onChange={e => set('paid_section_header', e.target.value)}
            className="input"
            data-testid="ctb-paid-section-header"
          />
          <p className="text-[11px] text-gray-400 mt-1">Une facture passée à « Payée » y est ajoutée et sa ligne de programmation retirée.</p>
        </div>
        <div>
          <label className="label">Jour de paiement des factures</label>
          <select
            value={actionConfig?.payment_weekday ?? '2'}
            onChange={e => set('payment_weekday', e.target.value)}
            className="input"
            data-testid="ctb-payment-weekday"
          >
            {CTB_WEEKDAYS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
          <p className="text-[11px] text-gray-400 mt-1">
            La programmation = ce jour, la semaine qui précède l'échéance (défaut : mardi).
          </p>
        </div>
        <div>
          <label className="label">Compte Google</label>
          <SearchableSelect
            value={actionConfig?.google_account_email ?? ''}
            options={googleAccounts}
            getOptionValue={a => a.account_email}
            getOptionLabel={a => a.account_email}
            getOptionKey={a => a.account_email}
            onChange={v => set('google_account_email', v)}
            emptyOption={`— Défaut (${CTB_DEFAULTS.google_account_email}) —`}
            placeholder={`— Défaut (${CTB_DEFAULTS.google_account_email}) —`}
            size="sm"
            className="input"
            testId="ctb-google-account"
          />
        </div>
      </div>
    </div>
  )
}

// Éditeur générique clé-valeur pour les automations système à config plate
// (spec = { title, intro, fields: [{key, label, def, hint?}] }).
function GenericConfigEditor({ spec, actionConfig, onChange }) {
  const set = (key, value) => onChange({ ...actionConfig, [key]: value })
  return (
    <div className="bg-white rounded-lg border p-5" data-testid="generic-config">
      <h2 className="text-sm font-semibold mb-1">{spec.title}</h2>
      <p className="text-xs text-gray-500 mb-4">{spec.intro}</p>
      <div className="grid grid-cols-2 gap-4">
        {spec.fields.map(f => (
          <div key={f.key} className={f.key === 'splits' || f.key === 'aga_splits' ? 'col-span-2' : ''}>
            <label className="label">{f.label}</label>
            <input
              type="text"
              value={actionConfig?.[f.key] ?? ''}
              onChange={e => set(f.key, e.target.value)}
              placeholder={f.def || '—'}
              className="input"
              data-testid={`generic-config-${f.key}`}
            />
            {f.hint && <p className="text-[11px] text-gray-400 mt-1">{f.hint}</p>}
          </div>
        ))}
      </div>
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
