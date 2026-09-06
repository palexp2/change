import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { newId } from '../utils/ids.js'
import { runAutomation } from '../services/automationEngine.js'
import { scheduleAutomation, unscheduleAutomation } from '../services/automationScheduler.js'
import { MANUAL_RUNNERS, logSystemRun, CONFIGURABLE_SYSTEM_AUTOMATIONS } from '../services/systemAutomations.js'
import { sendInstallationTestEmail, buildInstallationEmailHtml, selectEligibleCompanies } from '../services/installationFollowup.js'
import { dryRunFieldRule, runDateOffsetRuleNow, previewRuleForRecord, drainDeferredForAutomation, CANDIDATE_CAP } from '../services/fieldRuleEngine.js'
import { getAutomationFrom, listFromAddresses } from '../services/postmarkConfig.js'
import { processRetryQueue } from '../services/airtableWebhooks.js'
import { generateShortToken } from '../utils/shortToken.js'
import { runWebhook } from '../services/webhookEngine.js'
import { APP_URL } from '../config/appUrl.js'
import { parseLimit } from '../utils/pagination.js'

const IDENT_RE = /^[a-z_][a-z0-9_]*$/i
const VALID_ACTION_TYPES = new Set(['slack', 'email', 'task', 'script'])
// Webhook automations (kind='webhook') — surface déclarative validée côté serveur.
const WEBHOOK_TABLES = new Set(['tickets', 'projects', 'serial_numbers'])
const VALID_STEP_TYPES = new Set(['update', 'upsert', 'create'])
const VALID_VALUE_SOURCES = new Set(['literal', 'param', 'record'])

// Génère un token de webhook compact et non devinable (ex: hookB4FEHK9JYD4S4B).
function newWebhookToken() {
  return 'hook' + generateShortToken(14)
}

// Valide la config d'un webhook. Lève sur la première erreur.
function validateWebhook({ action_config, script }) {
  const ac = typeof action_config === 'string' ? JSON.parse(action_config || '{}') : (action_config || {})
  const mode = ac.mode === 'script' ? 'script' : 'declarative'
  if (mode === 'script') {
    if (!script || !String(script).trim()) throw new Error('script requis pour un webhook en mode script')
  } else {
    const steps = Array.isArray(ac.steps) ? ac.steps : []
    steps.forEach((s, i) => {
      const n = i + 1
      const type = s.type || 'update'
      if (!VALID_STEP_TYPES.has(type)) throw new Error(`Étape ${n}: type invalide (${type})`)
      if (!WEBHOOK_TABLES.has(s.table)) throw new Error(`Étape ${n}: table non autorisée (${s.table})`)
      if (type !== 'create') {
        if (!IDENT_RE.test(s.match?.field || '')) throw new Error(`Étape ${n}: champ de recherche requis`)
        if (!s.match?.param) throw new Error(`Étape ${n}: paramètre de recherche requis`)
      }
      for (const f of (s.fields || [])) {
        if (!IDENT_RE.test(f.column || '')) throw new Error(`Étape ${n}: colonne invalide (${f.column})`)
        if (f.source && !VALID_VALUE_SOURCES.has(f.source)) throw new Error(`Étape ${n}: source de valeur invalide (${f.source})`)
      }
    })
  }
  for (const r of (ac.response_rules || [])) {
    if (!r.param) throw new Error('Règle de réponse : paramètre requis')
  }
  if (ac.failure_recipient) {
    const allowed = listFromAddresses()
    if (!allowed.includes(ac.failure_recipient)) {
      throw new Error(`Destinataire d'échec « ${ac.failure_recipient} » non autorisé`)
    }
  }
}
// Comparison operators that require a finite numeric `value` and compare the
// column numerically (CAST AS REAL). Kept in sync with fieldRuleEngine.js.
const NUMERIC_OPS = new Set(['gt', 'gte', 'lt', 'lte'])
// `date_offset` is a date-relative trigger (« N jours avant/après un champ date »).
// It carries offset_days (signed int) + optional secondary filter instead of a value.
const VALID_OPS = new Set(['eq', 'ne', 'in', 'not_null', 'date_offset', ...NUMERIC_OPS])
// Operators allowed inside a date_offset secondary filter (everything except date_offset itself).
const FILTER_OPS = new Set(['eq', 'ne', 'in', 'not_null', ...NUMERIC_OPS])

// Validate a single { column, op, value } condition (used by multi-condition
// rules and the date_offset secondary filter). `label` prefixes error messages.
function validateCondition(cond, label) {
  if (!cond || typeof cond !== 'object') throw new Error(`${label} invalide`)
  if (!IDENT_RE.test(cond.column || '')) throw new Error(`${label}: colonne invalide`)
  const cop = cond.op || 'eq'
  if (!FILTER_OPS.has(cop)) throw new Error(`${label}: opérateur invalide (${cop})`)
  if (cop !== 'not_null' && cond.value === undefined) throw new Error(`${label}: valeur requise`)
  if (NUMERIC_OPS.has(cop) && !Number.isFinite(Number(cond.value))) {
    throw new Error(`${label}: valeur numérique requise pour l'opérateur ${cop}`)
  }
}

// Admin-facing field rule validation. Throws on first error.
function validateFieldRule({ trigger_config, action_type, action_config }) {
  const tc = typeof trigger_config === 'string' ? JSON.parse(trigger_config) : trigger_config
  if (!tc || typeof tc !== 'object') throw new Error('trigger_config invalide')
  if (!IDENT_RE.test(tc.erp_table || '')) throw new Error('trigger_config.erp_table invalide')
  const op = tc.op || 'eq'
  if (!VALID_OPS.has(op)) throw new Error(`trigger_config.op invalide: ${op}`)
  if (op === 'date_offset') {
    if (!IDENT_RE.test(tc.column || '')) throw new Error('trigger_config.column invalide')
    if (!Number.isInteger(Number(tc.offset_days))) {
      throw new Error('trigger_config.offset_days doit être un entier (négatif = avant, positif = après)')
    }
    if (tc.filter != null) {
      validateCondition(tc.filter, 'trigger_config.filter')
    }
  } else if (tc.conditions != null) {
    // Multi-condition AND/OR mode — { conjunction, rules: [{column, op, value}] }
    if (typeof tc.conditions !== 'object') throw new Error('trigger_config.conditions invalide')
    if (tc.conditions.conjunction !== 'AND' && tc.conditions.conjunction !== 'OR') {
      throw new Error('trigger_config.conditions.conjunction doit être AND ou OR')
    }
    const rules = tc.conditions.rules
    if (!Array.isArray(rules) || rules.length === 0) {
      throw new Error('trigger_config.conditions.rules requis (au moins une condition)')
    }
    rules.forEach((r, i) => validateCondition(r, `Condition ${i + 1}`))
  } else {
    if (!IDENT_RE.test(tc.column || '')) throw new Error('trigger_config.column invalide')
    if (op !== 'not_null' && tc.value === undefined) throw new Error('trigger_config.value requise')
    if (NUMERIC_OPS.has(op) && !Number.isFinite(Number(tc.value))) {
      throw new Error(`trigger_config.value doit être numérique pour l'opérateur ${op}`)
    }
  }
  const at = action_type || 'slack'
  if (!VALID_ACTION_TYPES.has(at)) throw new Error(`action_type invalide: ${at}`)
  const ac = typeof action_config === 'string' ? JSON.parse(action_config) : (action_config || {})
  // Anti-cycle: interdire une règle tâche qui écrirait dans la même table que le trigger
  if (at === 'task' && ac.link_company === false && tc.erp_table === 'tasks') {
    throw new Error('Garde anti-cycle: règle sur `tasks` avec action task interdite')
  }
  if (at === 'script' && (!ac.script || !String(ac.script).trim())) {
    throw new Error('action_config.script requis pour une règle de type script')
  }
  return { tc, ac, at }
}

// Per-system-automation test-email senders. A registered automation id can be
// previewed in an admin's inbox via POST /api/automations/:id/test-email.
const TEST_EMAIL_SENDERS = {
  sys_installation_followup: (opts) => sendInstallationTestEmail(db, { fromAddress: getAutomationFrom('sys_installation_followup'), ...opts }),
}

// System automations that send email and therefore accept a `from` override in
// action_config. Other system automations remain fully read-only.
const SYSTEM_EMAIL_AUTOMATIONS = new Set([
  'sys_installation_followup',
  'sys_shipment_tracking_email',
])

// Clés d'action_config éditables par automation système configurable, et tables
// autorisées pour la condition de déclenchement (la première est le défaut).
// Miroir de REVREC_ACCOUNT_OVERRIDES (quickbooks.js) pour les clés de comptes.
const CONFIGURABLE_SYSTEM_SPECS = {
  sys_revenue_recognition: {
    allowedTables: ['shipments', 'factures'],
    actionKeys: new Set(['deferred_acctnum', 'sale_acctnum', 'ar_cad_acctnum', 'ar_usd_acctnum']),
  },
  // Gel du coût total au moment de l'envoi : seule la condition de
  // déclenchement est éditable (quelle écriture sur la ligne de commande vaut
  // « la ligne part dans un envoi »). Le calcul lui-même vit dans le code —
  // d'où actionKeys vide, mais la clé doit exister : sans entrée ici, le PATCH
  // du déclencheur répondrait 400 « lecture seule ».
  sys_order_item_shipped_cost: {
    allowedTables: ['order_items'],
    actionKeys: new Set(),
  },
  // CTB - Suivi (Google Sheets) : seule l'action est configurable — le
  // déclencheur (publication d'un Bill QB / création d'une facture fournisseur)
  // vit dans le code. validateKey remplace la validation AcctNum par défaut.
  sys_ctb_programmation_paiement: {
    actionKeys: new Set(['spreadsheet_id', 'sheet_name', 'section_header', 'paid_section_header', 'payment_weekday', 'google_account_email']),
    validateKey: validateCtbSheetKey,
  },
  // Répartition de la paie : pourcentages, comptes et ajouts standards.
  sys_paie_repartition: {
    actionKeys: new Set(['splits', 'source_acctnum', 'phone_acctnum', 'phone_amount',
      'meals_acctnum', 'reimb_acctnum', 'aga_splits', 'aga_source_acctnum',
      'aga_vendor_name', 'aga_taxcode', 'aga_memo',
      'bank_acctnum', 'salary_vendor_name', 'salary_taxcode', 'phone_taxcode',
      'bank_account_name', 'bank_label_pattern', 'bank_window_before_days',
      'bank_window_after_days', 'aga_bank_label_pattern', 'aga_bank_window_days']),
    validateKey(key, v) {
      if (!v) return
      if (['salary_vendor_name', 'salary_taxcode', 'phone_taxcode', 'aga_vendor_name', 'aga_taxcode', 'aga_memo'].includes(key)) {
        if (v.length > 120) throw new Error(`${key} trop long (max 120 caractères)`)
        return
      }
      if (key === 'splits' || key === 'aga_splits') {
        if (!/^[0-9A-Za-z.-]{1,20}\s*:\s*[0-9]+([.,][0-9]+)?(\s*[,;]\s*[0-9A-Za-z.-]{1,20}\s*:\s*[0-9]+([.,][0-9]+)?)*$/.test(v.trim())) {
          throw new Error(`${key} : format attendu « compte:poids, compte:poids, … »`)
        }
        return
      }
      if (key === 'phone_amount') {
        if (!/^[0-9]+([.,][0-9]+)?$/.test(v)) throw new Error('phone_amount doit être un montant')
        return
      }
      // Recherche du débit au relevé : nom de compte et libellés sont du texte
      // libre (ce sont des morceaux de libellé bancaire), les fenêtres sont
      // des nombres de jours.
      if (['bank_account_name', 'bank_label_pattern', 'aga_bank_label_pattern'].includes(key)) {
        if (v.length > 120) throw new Error(`${key} trop long (max 120 caractères)`)
        return
      }
      if (['bank_window_before_days', 'bank_window_after_days', 'aga_bank_window_days'].includes(key)) {
        if (!/^\d{1,3}$/.test(v)) throw new Error(`${key} doit être un nombre de jours`)
        return
      }
      if (!ACCTNUM_RE.test(v)) throw new Error(`${key} : numéro de compte invalide`)
    },
  },
  // Lecture bancaire Plaid et rattachement des sorties connues : rien à
  // configurer côté action (les libellés vivent sur sys_paie_repartition et sur
  // les fiches de dettes), mais l'entrée doit exister — sans elle le PATCH
  // d'activation/désactivation répondrait 400 « lecture seule ».
  sys_plaid_sync: { actionKeys: new Set() },
  // Alerte « banque muette » : seuil, anti-spam, destinataires, canal Slack.
  sys_plaid_silence_alert: {
    actionKeys: new Set(['silence_hours', 'repeat_hours', 'notify_roles', 'slack_webhook_env']),
    validateKey(key, v) {
      if (!v) return
      if (key === 'silence_hours' || key === 'repeat_hours') {
        if (!/^\d{1,4}$/.test(v)) throw new Error(`${key} doit être un nombre d'heures`)
        return
      }
      if (key === 'notify_roles' && !/^[a-z_]+(\s*,\s*[a-z_]+)*$/i.test(v)) {
        throw new Error('notify_roles : rôles séparés par des virgules (admin, ops…)')
      }
      if (key === 'slack_webhook_env' && !/^[A-Z0-9_]{0,64}$/.test(v)) {
        throw new Error('slack_webhook_env : nom de variable d\'environnement')
      }
    },
  },
  sys_bank_debit_link: { actionKeys: new Set() },
  // Même cas : déclarées configurables sans spec, leur interrupteur répondait
  // 400 « lecture seule » — impossible de les mettre en pause depuis la page.
  // Rien à configurer côté action, mais l'entrée doit exister.
  sys_plaid_qb_audit: { actionKeys: new Set() },
  sys_treasury_qb_clear: { actionKeys: new Set() },
  sys_treasury_solde_sheet: { actionKeys: new Set() },
  sys_fiscal_anomalies_sheet: { actionKeys: new Set() },
  sys_invoice_collection: { actionKeys: new Set() },
  sys_bank_trx_sheet: { actionKeys: new Set() },
  sys_work_suggestions: { actionKeys: new Set() },
  sys_month_end_provisions: { actionKeys: new Set() },
  sys_address_check: { actionKeys: new Set() },
  sys_return_label: { actionKeys: new Set() },
  // Vérificateur de prix d'achats : bornes de détection et notification.
  sys_purchase_price_check: {
    actionKeys: new Set(['ratio_min', 'ratio_max', 'min_abs_diff', 'fallback_roles', 'notify']),
    validateKey(key, v) {
      if (!v) return
      if (['ratio_min', 'ratio_max', 'min_abs_diff'].includes(key) && !/^\d{1,6}([.,]\d{1,4})?$/.test(v)) {
        throw new Error(`${key} doit être un nombre positif`)
      }
      if (key === 'notify' && !/^[01]$/.test(v)) throw new Error('notify doit être 0 ou 1')
      if (key === 'fallback_roles' && v.length > 200) throw new Error('fallback_roles : 200 caractères maximum')
    },
  },
  // Corbeille : durée de rétention avant suppression définitive. Le compte à
  // rebours affiché sur chaque élément de /admin/corbeille suit ce réglage.
  sys_trash_auto_cleanup: {
    actionKeys: new Set(['retention_days']),
    validateKey(key, v) {
      if (key === 'retention_days') {
        if (!/^\d{1,4}$/.test(v || '') || Number(v) < 1) {
          throw new Error('retention_days doit être un nombre de jours supérieur à 0')
        }
      }
    },
  },
  // DigiKey : fenêtre d'historique balayée et nom du fournisseur porté par les
  // achats créés. Les identifiants OAuth vivent dans Connecteurs, pas ici.
  sys_digikey_orders: {
    actionKeys: new Set(['lookback_days', 'vendor_name']),
    validateKey(key, v) {
      if (!v) return
      if (key === 'lookback_days' && !/^\d{1,4}$/.test(v)) {
        throw new Error('lookback_days doit être un nombre de jours')
      }
      if (key === 'vendor_name' && v.length > 120) {
        throw new Error('vendor_name : 120 caractères maximum')
      }
    },
  },
  // Alerte solde CARM : point de départ du compte, seuil, comptes d'imputation.
  sys_carm_balance_alert: {
    actionKeys: new Set(['opening_balance', 'opening_date', 'threshold', 'ap_acctnum', 'duty_acctnum',
      'interest_acctnum', 'penalty_acctnum', 'card_acctnum', 'bank_acctnum', 'vendor_name',
      'gst_tax_code_name', 'notax_tax_code_name', 'post_since', 'max_batch', 'delta_tolerance',
      'broker_names', 'clearing_acctnum', 'slack_webhook_env']),
    validateKey(key, v) {
      if (!v) return
      if ((key === 'opening_balance' || key === 'threshold') && !/^-?\d{1,9}([.,]\d{1,2})?$/.test(v)) {
        throw new Error(`${key} doit être un montant`)
      }
      if ((key === 'opening_date' || key === 'post_since') && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        throw new Error(`${key} doit être une date AAAA-MM-JJ`)
      }
      if (key === 'max_batch' && !/^\d{1,3}$/.test(v)) throw new Error('max_batch doit être un entier (1-500)')
      if (key === 'delta_tolerance' && !/^\d{1,3}([.,]\d{1,2})?$/.test(v)) {
        throw new Error('delta_tolerance doit être un montant')
      }
      if ((key === 'vendor_name' || key === 'gst_tax_code_name' || key === 'notax_tax_code_name'
        || key === 'broker_names') && v.length > 200) {
        throw new Error(`${key} : 200 caractères maximum`)
      }
      if (key.endsWith('_acctnum') && !ACCTNUM_RE.test(v)) {
        throw new Error(`${key} : numéro de compte invalide`)
      }
      if (key === 'slack_webhook_env' && !/^[A-Z0-9_]{1,64}$/.test(v)) {
        throw new Error("slack_webhook_env doit être un nom de variable d'environnement (MAJUSCULES_ET_UNDERSCORES)")
      }
    },
  },
  // Onglet Pmt_Suivi (CTB - Suivi) : fichier, onglet, compte Google, plancher.
  sys_pmt_suivi_sheet: {
    actionKeys: new Set(['file_id', 'sheet_name', 'google_account_email', 'since_date']),
    validateKey(key, v) {
      if (!v) return // vide = retomber sur le défaut du service
      if (key === 'file_id' && !/^[A-Za-z0-9_-]{20,80}$/.test(v)) {
        throw new Error("file_id invalide — coller l'ID du fichier (entre /d/ et /edit dans l'URL)")
      }
      if (key === 'sheet_name' && v.length > 80) throw new Error('sheet_name trop long (max 80 caractères)')
      if (key === 'google_account_email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        throw new Error('google_account_email doit être une adresse courriel')
      }
      if (key === 'since_date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        throw new Error('since_date doit être une date AAAA-MM-JJ')
      }
    },
  },
  // Alerte trésorerie BNC : seuil, horizons, bruit Slack et canal.
  // Les clés absentes de actionKeys sont ignorées au PATCH — d'où la liste
  // complète des champs affichés par la fiche automation (alert_horizon_days,
  // slack_urgent_days et stale_reminder_slack y étaient éditables sans jamais
  // être sauvegardés).
  sys_treasury_alert: {
    actionKeys: new Set(['threshold', 'horizon_days', 'balance_stale_days', 'alert_horizon_days',
      'slack_negative_only', 'slack_negative_days', 'slack_urgent_days', 'stale_reminder_slack',
      'variance_slack', 'slack_webhook_env']),
    validateKey(key, v) {
      if (!v) return
      if (key === 'slack_webhook_env') {
        if (!/^[A-Z0-9_]{1,64}$/.test(v)) {
          throw new Error("slack_webhook_env doit être un nom de variable d'environnement (MAJUSCULES_ET_UNDERSCORES)")
        }
        return
      }
      if (key === 'slack_negative_only' || key === 'stale_reminder_slack' || key === 'variance_slack') {
        if (v !== '0' && v !== '1') throw new Error(`${key} doit valoir 0 ou 1`)
        return
      }
      if (!/^\d{1,7}$/.test(v)) throw new Error(`${key} doit être un entier positif`)
    },
  },
  // Comptabilisation QB des Stripe payouts : périmètre (date plancher), cap de
  // sécurité par passage, filet « en souffrance » et canal Slack du résumé.
  sys_stripe_weekly_payout_push: {
    actionKeys: new Set(['push_since', 'max_batch', 'stale_alert_days', 'slack_on_success', 'slack_webhook_env']),
    validateKey(key, v) {
      if (!v) return
      if (key === 'push_since' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        throw new Error('push_since doit être une date AAAA-MM-JJ')
      }
      if (key === 'slack_on_success' && v !== '0' && v !== '1') {
        throw new Error('slack_on_success doit valoir 0 ou 1')
      }
      if ((key === 'max_batch' || key === 'stale_alert_days') && !/^[1-9]\d{0,2}$/.test(v)) {
        throw new Error(`${key} doit être un entier positif`)
      }
      if (key === 'slack_webhook_env' && !/^[A-Z0-9_]{1,64}$/.test(v)) {
        throw new Error("slack_webhook_env doit être un nom de variable d'environnement (MAJUSCULES_ET_UNDERSCORES)")
      }
    },
  },
  // Rappel mensuel de paiement des cartes : libellé, échéance, jours travaillés, canal.
  sys_card_payment_reminder: {
    actionKeys: new Set(['cards', 'due_day', 'work_days', 'slack_webhook_env']),
    validateKey(key, v) {
      if (!v) return
      if (key === 'cards' && v.length > 120) throw new Error('cards trop long (max 120 caractères)')
      if (key === 'due_day' && !/^(?:[1-9]|[12][0-9]|3[01])$/.test(v)) {
        throw new Error('due_day doit être un jour du mois (1 à 31)')
      }
      if (key === 'work_days' && !/^[0-6](\s*,\s*[0-6])*$/.test(v)) {
        throw new Error('work_days : liste de jours 0 (dimanche) à 6 (samedi), séparés par des virgules')
      }
      if (key === 'slack_webhook_env' && !/^[A-Z0-9_]{1,64}$/.test(v)) {
        throw new Error("slack_webhook_env doit être un nom de variable d'environnement (MAJUSCULES_ET_UNDERSCORES)")
      }
    },
  },
  // Plafond des cartes : périmètre (comptes QB suivis), fenêtre J-N, seuil de
  // matérialité et canal. Les seuils PROPRES à chaque carte (limite, plafond,
  // jour de prélèvement) vivent dans card_ceilings et s'éditent sur le dashboard
  // comptabilité — les redoubler ici créerait deux vérités.
  sys_card_ceiling_alert: {
    actionKeys: new Set(['acctnums', 'lead_days', 'min_alert_amount', 'pending_lookback_days',
      'lead_always', 'slack_channel', 'slack_webhook_url', 'slack_webhook_env']),
    validateKey(key, v) {
      if (!v) return
      if (key === 'acctnums' && !/^\d{1,10}(\s*,\s*\d{1,10})*$/.test(v)) {
        throw new Error('acctnums : numéros de comptes QuickBooks séparés par des virgules')
      }
      if (key === 'lead_days' && !/^\d{1,2}$/.test(v)) {
        throw new Error('lead_days doit être un nombre de jours (0 à 99)')
      }
      if (key === 'min_alert_amount' && !/^\d{1,7}$/.test(v)) {
        throw new Error('min_alert_amount doit être un entier positif (CAD)')
      }
      if (key === 'pending_lookback_days' && !/^[1-9]\d{0,3}$/.test(v)) {
        throw new Error('pending_lookback_days doit être un nombre de jours positif')
      }
      if (key === 'lead_always' && v !== '0' && v !== '1') {
        throw new Error('lead_always doit valoir 0 ou 1')
      }
      if (key === 'slack_channel' && v.length > 120) {
        throw new Error('slack_channel trop long (max 120 caractères)')
      }
      if (key === 'slack_webhook_url' && !/^https:\/\/hooks\.slack\.com\//.test(v)) {
        throw new Error('slack_webhook_url doit être une URL https://hooks.slack.com/…')
      }
      if (key === 'slack_webhook_env' && !/^[A-Z0-9_]{1,64}$/.test(v)) {
        throw new Error("slack_webhook_env doit être un nom de variable d'environnement (MAJUSCULES_ET_UNDERSCORES)")
      }
    },
  },
  // Déboursés mensuels en pièces : compte de stock, dossier Drive, canal Slack.
  sys_pieces_disbursements: {
    actionKeys: new Set(['acctnum', 'drive_folder_id', 'google_account_email', 'slack_webhook_env', 'recipient']),
    validateKey(key, v) {
      if (!v) return
      if (key === 'acctnum' && !/^\d{3,8}$/.test(v)) {
        throw new Error('acctnum doit être un numéro de compte QuickBooks (chiffres)')
      }
      if (key === 'drive_folder_id' && !/^[A-Za-z0-9_-]{20,80}$/.test(v)) {
        throw new Error("drive_folder_id invalide — coller l'ID du dossier (après /folders/ dans l'URL)")
      }
      if (key === 'google_account_email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        throw new Error('google_account_email doit être une adresse courriel')
      }
      if (key === 'slack_webhook_env' && !/^[A-Z0-9_]{1,64}$/.test(v)) {
        throw new Error("slack_webhook_env doit être un nom de variable d'environnement (MAJUSCULES_ET_UNDERSCORES)")
      }
      if (key === 'recipient' && v.length > 60) throw new Error('recipient trop long (max 60 caractères)')
    },
  },
  // Alerte Slack du sondage de satisfaction. `slack_channel` est la voie
  // recommandée (bot token) ; les deux clés webhook restent le filet.
  sys_ticket_survey_slack: {
    actionKeys: new Set(['slack_channel', 'slack_webhook_url', 'slack_webhook_env', 'recipient', 'low_rating_max']),
    validateKey(key, v) {
      if (!v) return
      if (key === 'slack_channel' && !/^(#?[a-z0-9._-]{1,80}|@[A-Za-z0-9._-]{1,80}|[^\s@]+@[^\s@]+\.[^\s@]+|[CGDU][A-Z0-9]{6,})$/.test(v)) {
        throw new Error('slack_channel : « #canal », « @personne », un courriel ou un identifiant Slack')
      }
      if (key === 'slack_webhook_url' && !/^https:\/\/hooks\.slack\.com\//.test(v)) {
        throw new Error('slack_webhook_url doit commencer par https://hooks.slack.com/')
      }
      if (key === 'slack_webhook_env' && !/^[A-Z0-9_]{1,64}$/.test(v)) {
        throw new Error("slack_webhook_env doit être un nom de variable d'environnement (MAJUSCULES_ET_UNDERSCORES)")
      }
      if (key === 'recipient' && v.length > 60) throw new Error('recipient trop long (max 60 caractères)')
      if (key === 'low_rating_max' && !/^[1-5]$/.test(v)) throw new Error('low_rating_max : 1 à 5')
    },
  },
  // Prospects Instagram. Les trois automations sont `configurable: true` : sans
  // ces entrées, leur fiche affiche des champs que le PATCH refuse en 400.
  sys_instagram_prospect_intake: {
    actionKeys: new Set(['keywords']),
  },
  sys_instagram_comment_scrape: {
    actionKeys: new Set(['accounts', 'keywords', 'lookback_days', 'own_accounts', 'run_weekday', 'run_hour']),
    validateKey(key, v) {
      // `keywords` vide est légitime : cela capte tous les commentateurs.
      if (!v) return
      if ((key === 'accounts' || key === 'own_accounts') && !/^@?[A-Za-z0-9._]{1,30}(\s*,\s*@?[A-Za-z0-9._]{1,30})*$/.test(v)) {
        throw new Error(`${key} : noms d'usager Instagram séparés par des virgules`)
      }
      if (key === 'lookback_days' && !/^([1-9]|[1-9]\d|[12]\d{2}|3[0-5]\d|36[0-5])$/.test(v)) {
        throw new Error('lookback_days doit être un entier de 1 à 365 (jours)')
      }
      if (key === 'run_weekday' && !/^[1-7]$/.test(v)) throw new Error('run_weekday : 1 (lundi) à 7 (dimanche)')
      if (key === 'run_hour' && !/^([0-9]|1\d|2[0-3])$/.test(v)) throw new Error('run_hour : 0 à 23')
    },
  },
  sys_instagram_weekly_slack: {
    actionKeys: new Set(['send_weekday', 'send_hour', 'slack_webhook_url', 'slack_webhook_env', 'recipient']),
    validateKey(key, v) {
      if (!v) return
      if (key === 'send_weekday' && !/^[1-7]$/.test(v)) throw new Error('send_weekday : 1 (lundi) à 7 (dimanche)')
      if (key === 'send_hour' && !/^([0-9]|1\d|2[0-3])$/.test(v)) throw new Error('send_hour : 0 à 23')
      if (key === 'slack_webhook_url' && !/^https:\/\/hooks\.slack\.com\//.test(v)) {
        throw new Error('slack_webhook_url doit commencer par https://hooks.slack.com/')
      }
      if (key === 'slack_webhook_env' && !/^[A-Z0-9_]{1,64}$/.test(v)) {
        throw new Error("slack_webhook_env doit être un nom de variable d'environnement (MAJUSCULES_ET_UNDERSCORES)")
      }
      if (key === 'recipient' && v.length > 60) throw new Error('recipient trop long (max 60 caractères)')
    },
  },
  // Budget marketing — détection : comptes QB suivis, date de départ, fenêtre de
  // rebalayage. Sans cette entrée, la fiche affiche des champs que le PATCH
  // refuse en 400 (« lecture seule ») : toute automation `configurable: true`
  // DOIT avoir sa liste actionKeys ici.
  sys_marketing_expense_sync: {
    actionKeys: new Set(['accounts', 'start_date', 'lookback_days']),
    validateKey(key, v) {
      if (!v) return
      if (key === 'accounts' && !/^\d{3,8}(\s*,\s*\d{3,8})*$/.test(v)) {
        throw new Error('accounts : numéros de comptes QuickBooks séparés par des virgules (ex. 75910,75920)')
      }
      if (key === 'start_date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        throw new Error('start_date doit être une date AAAA-MM-JJ')
      }
      if (key === 'lookback_days' && !/^[1-9]\d{0,2}$/.test(v)) {
        throw new Error('lookback_days doit être un entier positif (jours)')
      }
    },
  },
  // Budget marketing — message hebdo : jour d'envoi, canal Slack, destinataire.
  sys_marketing_weekly_slack: {
    actionKeys: new Set(['send_weekday', 'slack_webhook_env', 'recipient']),
    validateKey(key, v) {
      if (!v) return
      if (key === 'send_weekday' && !/^[1-7]$/.test(v)) {
        throw new Error('send_weekday : jour ISO de 1 (lundi) à 7 (dimanche)')
      }
      if (key === 'slack_webhook_env' && !/^[A-Z0-9_]{1,64}$/.test(v)) {
        throw new Error("slack_webhook_env doit être un nom de variable d'environnement (MAJUSCULES_ET_UNDERSCORES)")
      }
      if (key === 'recipient' && v.length > 60) throw new Error('recipient trop long (max 60 caractères)')
    },
  },
}

function validateCtbSheetKey(key, v) {
  if (!v) return // vide = retomber sur le défaut du service
  if (key === 'spreadsheet_id' && !/^[A-Za-z0-9_-]{20,80}$/.test(v)) {
    throw new Error("spreadsheet_id invalide — coller l'ID du fichier (entre /d/ et /edit dans l'URL)")
  }
  if ((key === 'sheet_name' || key === 'section_header' || key === 'paid_section_header') && v.length > 120) {
    throw new Error(`${key} trop long (max 120 caractères)`)
  }
  if (key === 'payment_weekday' && !/^[1-7]$/.test(v)) {
    throw new Error('payment_weekday doit être 1 (lundi) à 7 (dimanche)')
  }
  if (key === 'google_account_email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    throw new Error('google_account_email invalide')
  }
}

// Colonnes utilisables dans la condition d'une automation système configurable :
// colonnes physiques + champs personnalisés actifs (matérialisés dans la vue
// <table>_v, que le watcher interroge quand la condition en référence un).
function configurableTriggerColumns(erpTable) {
  const physical = db.prepare(`PRAGMA table_info(${erpTable})`).all().map(c => c.name)
  const custom = db.prepare(
    // kind='native' exclu : ces lignes personnalisent une colonne déjà listée par
    // le PRAGMA (ou un champ calculé par la requête, sans colonne physique).
    "SELECT column_name FROM custom_fields WHERE erp_table = ? AND deleted_at IS NULL AND kind <> 'native'"
  ).all(erpTable).map(r => r.column_name)
  return new Set([...physical, ...custom])
}

// AcctNum QB : chiffres/lettres/point/tiret, 1 à 20 caractères. Vide = défaut.
const ACCTNUM_RE = /^[0-9A-Za-z.-]{1,20}$/

// Valide et fusionne l'édition (trigger_config / action_config) d'une automation
// système configurable. Seule la condition (colonne/op/valeur sur la table
// verrouillée) et les clés d'action whitelistées sont modifiables — kind, source
// et les clés inconnues du row courant sont préservés. Lève sur config invalide.
// Retourne { tcJson, acJson } (null quand la portion n'a pas été soumise).
function validateConfigurableSystemPatch(automation, { trigger_config, action_config }) {
  const spec = CONFIGURABLE_SYSTEM_SPECS[automation.id]
  if (!spec) throw new Error('Automation système — lecture seule')

  let tcJson = null
  if (trigger_config !== undefined) {
    if (!spec.allowedTables) throw new Error('Déclencheur non modifiable pour cette automation système')
    const incoming = typeof trigger_config === 'string' ? JSON.parse(trigger_config) : (trigger_config || {})
    const current = (() => { try { return JSON.parse(automation.trigger_config || '{}') } catch { return {} } })()
    const erpTable = incoming.erp_table ?? current.erp_table ?? spec.allowedTables[0]
    if (!spec.allowedTables.includes(erpTable)) {
      throw new Error(`Table de déclenchement non autorisée: ${erpTable} (choix : ${spec.allowedTables.join(', ')})`)
    }
    validateCondition(
      { column: incoming.column, op: incoming.op || 'eq', value: incoming.value },
      'Condition de déclenchement'
    )
    if (!configurableTriggerColumns(erpTable).has(incoming.column)) {
      throw new Error(`Colonne inexistante sur ${erpTable} (colonnes physiques et champs personnalisés): ${incoming.column}`)
    }
    const op = incoming.op || 'eq'
    const subject = erpTable === 'factures'
      ? "d'une facture (réévaluée aussi quand sa commande ou un envoi lié change)"
      : erpTable === 'order_items'
        ? "d'une ligne de commande"
        : "d'un shipment"
    const merged = {
      ...current,
      erp_table: erpTable,
      column: incoming.column,
      op,
      value: op === 'not_null' ? undefined : incoming.value,
      summary: `Déclenché à l'écriture DB ${subject} : ${incoming.column} ${op} ${
        op === 'not_null' ? '' : JSON.stringify(incoming.value)
      } (toute origine : UI, Novoxpress, sync Airtable)`.replace(/\s+/g, ' '),
    }
    if (merged.value === undefined) delete merged.value
    tcJson = JSON.stringify(merged)
  }

  let acJson = null
  if (action_config !== undefined) {
    const incoming = typeof action_config === 'string' ? JSON.parse(action_config) : (action_config || {})
    const current = (() => { try { return JSON.parse(automation.action_config || '{}') } catch { return {} } })()
    const merged = { ...current }
    for (const key of spec.actionKeys) {
      if (!(key in incoming)) continue
      const v = String(incoming[key] ?? '').trim()
      if (spec.validateKey) {
        spec.validateKey(key, v)
      } else if (v && !ACCTNUM_RE.test(v)) {
        throw new Error(`Numéro de compte invalide pour ${key}: « ${v} »`)
      }
      merged[key] = v
    }
    acJson = JSON.stringify(merged)
  }

  return { tcJson, acJson }
}

// ── Historique de versions ────────────────────────────────────────────────
// Chaque édition sauvegardée (POST create, PATCH update, restore) capture un
// snapshot complet de l'automation + qui/quand → audit + rollback. Les éditions
// rapprochées du même auteur (autosave debounce 500ms) sont coalescées dans la
// même ligne de version pour éviter une révision par frappe.
const VERSION_COALESCE_MS = 2 * 60 * 1000
const VERSION_FIELDS = ['name', 'description', 'trigger_type', 'trigger_config', 'action_type', 'action_config', 'script', 'active', 'kind']
const VERSION_FIELD_LABELS = {
  name: 'nom', description: 'description', trigger_type: 'type de déclencheur',
  trigger_config: 'déclencheur', action_type: 'type d\'action',
  action_config: 'action', script: 'script', active: 'statut', kind: 'genre',
}

// Normalise une valeur pour comparaison (active → 0/1 ; null/undefined → '').
function vnorm(field, val) {
  if (field === 'active') return val ? 1 : 0
  return val == null ? '' : String(val)
}
function sameVersionContent(a, b) {
  return VERSION_FIELDS.every(f => vnorm(f, a[f]) === vnorm(f, b[f]))
}
// Liste lisible des champs qui diffèrent entre deux snapshots.
function versionDiffSummary(prev, next) {
  if (!prev) return 'Création'
  const changed = VERSION_FIELDS.filter(f => vnorm(f, prev[f]) !== vnorm(f, next[f]))
  if (!changed.length) return 'Aucun changement'
  return changed.map(f => VERSION_FIELD_LABELS[f] || f).join(', ') + (changed.length > 1 ? ' modifiés' : ' modifié')
}
// Construit un snapshot versionnable depuis une ligne `automations`.
function snapshotFromRow(row) {
  return {
    name: row.name, description: row.description, trigger_type: row.trigger_type,
    trigger_config: row.trigger_config, action_type: row.action_type,
    action_config: row.action_config, script: row.script,
    active: row.active ? 1 : 0, kind: row.kind || null,
  }
}

// Enregistre une révision. No-op si identique à la dernière (sauf summary forcé).
// Coalesce les éditions rapprochées du même auteur (remplace la dernière ligne).
// opts.coalesce=false force une nouvelle ligne ; opts.summary force le résumé.
function recordAutomationVersion(automationId, snapshot, req, opts = {}) {
  const latest = db.prepare(
    'SELECT * FROM automation_versions WHERE automation_id = ? ORDER BY version DESC LIMIT 1'
  ).get(automationId)
  if (latest && sameVersionContent(latest, snapshot) && !opts.summary) return latest

  const userId = req?.user?.id || null
  const userName = req?.user?.name || null
  const coalesce = opts.coalesce !== false && latest &&
    userId != null && latest.edited_by === userId &&
    (Date.now() - Date.parse(latest.created_at || 0)) < VERSION_COALESCE_MS
  // Base du diff : la révision d'avant `latest` si on coalesce (on l'écrase), sinon `latest`.
  const diffBase = coalesce
    ? db.prepare('SELECT * FROM automation_versions WHERE automation_id = ? AND version < ? ORDER BY version DESC LIMIT 1').get(automationId, latest.version)
    : latest
  const summary = opts.summary || versionDiffSummary(diffBase, snapshot)

  if (coalesce) {
    db.prepare(`
      UPDATE automation_versions SET
        name=?, description=?, trigger_type=?, trigger_config=?, action_type=?,
        action_config=?, script=?, active=?, kind=?, edited_by=?, edited_by_name=?,
        change_summary=?, created_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id=?
    `).run(snapshot.name, snapshot.description, snapshot.trigger_type, snapshot.trigger_config,
      snapshot.action_type, snapshot.action_config, snapshot.script, snapshot.active ? 1 : 0,
      snapshot.kind, userId, userName, summary, latest.id)
    return db.prepare('SELECT * FROM automation_versions WHERE id = ?').get(latest.id)
  }

  const version = latest ? latest.version + 1 : 1
  const id = newId('version')
  db.prepare(`
    INSERT INTO automation_versions
      (id, automation_id, version, name, description, trigger_type, trigger_config,
       action_type, action_config, script, active, kind, edited_by, edited_by_name, change_summary)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, automationId, version, snapshot.name, snapshot.description, snapshot.trigger_type,
    snapshot.trigger_config, snapshot.action_type, snapshot.action_config, snapshot.script,
    snapshot.active ? 1 : 0, snapshot.kind, userId, userName, summary)
  return db.prepare('SELECT * FROM automation_versions WHERE id = ?').get(id)
}

// Garantit qu'une automation pré-existante a une révision « état initial » avant
// d'enregistrer l'édition courante — sinon impossible de revenir à l'état d'avant
// la première édition tracée.
function ensureBaselineVersion(automationRow) {
  const { c } = db.prepare('SELECT COUNT(*) c FROM automation_versions WHERE automation_id = ?').get(automationRow.id)
  if (c > 0) return
  const snap = snapshotFromRow(automationRow)
  db.prepare(`
    INSERT INTO automation_versions
      (id, automation_id, version, name, description, trigger_type, trigger_config,
       action_type, action_config, script, active, kind, edited_by, edited_by_name, change_summary)
    VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(newId('version'), automationRow.id, snap.name, snap.description, snap.trigger_type,
    snap.trigger_config, snap.action_type, snap.action_config, snap.script, snap.active ? 1 : 0,
    snap.kind, null, null, 'État initial (avant suivi de versions)')
}

const router = Router()
router.use(requireAuth)

// GET /api/automations
router.get('/', (req, res) => {
  const automations = db.prepare(`
    SELECT a.*,
           COALESCE(r.runs_30d, 0) AS runs_30d,
           COALESCE(r.errors_30d, 0) AS errors_30d
    FROM automations a
    LEFT JOIN (
      SELECT automation_id,
             COUNT(*) AS runs_30d,
             SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors_30d
      FROM automation_logs
      WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
      GROUP BY automation_id
    ) r ON r.automation_id = a.id
    WHERE a.deleted_at IS NULL
    ORDER BY a.created_at DESC
  `).all()
  res.json(automations)
})

// GET /api/automations/field-defs?erp_table=tickets
// Returns columns available for field-rule templating (native + airtable_field_defs).
// ⚠️ Doit être déclarée AVANT GET /:id, sinon le paramètre :id avale « field-defs »
// et la route répond 404 « Introuvable ».
router.get('/field-defs', (req, res) => {
  const erpTable = req.query.erp_table
  if (!erpTable || !IDENT_RE.test(erpTable)) {
    return res.status(400).json({ error: 'erp_table invalide' })
  }
  let native
  try {
    native = db.prepare(`PRAGMA table_info(${erpTable})`).all()
  } catch {
    return res.status(400).json({ error: `Table inconnue: ${erpTable}` })
  }
  if (!native.length) return res.status(400).json({ error: `Table inconnue: ${erpTable}` })
  // Champs de rendu kind='data' (fusion avec l'ex-airtable_field_defs — colonne
  // cf_* auto-générée OU colonne native adoptée) + mappings natifs sans rendu
  // (jamais adoptés dans custom_fields — whitelisting interne, cf. schema.js).
  const defs = db.prepare(`
    SELECT column_name, name AS airtable_field_name, type AS field_type
    FROM custom_fields WHERE erp_table = ? AND deleted_at IS NULL AND kind='data'
    UNION
    SELECT m.column_name, m.airtable_field_name, 'text' AS field_type
    FROM airtable_field_mappings m
    WHERE m.erp_table = ? AND m.column_name NOT IN (
      SELECT column_name FROM custom_fields WHERE erp_table = ? AND deleted_at IS NULL AND kind='data'
    )
    ORDER BY column_name
  `).all(erpTable, erpTable, erpTable)
  const nativeNames = new Set(native.map(c => c.name))
  const defColumns = new Set(defs.map(d => d.column_name))
  // Native columns that have no def/mapping row (id, created_at, etc.)
  const nativeOnly = native
    .filter(c => !defColumns.has(c.name))
    .map(c => ({ column_name: c.name, airtable_field_name: null, field_type: c.type?.toLowerCase() || 'text' }))
  const columns = [...defs, ...nativeOnly]
  // include_custom=1 : ajoute les champs personnalisés virtuels (lookup, rollup,
  // formule…) matérialisés dans la vue <table>_v. Utilisé par l'éditeur de
  // condition des automations système configurables — PAS par les field rules,
  // dont le moteur interroge la table physique uniquement.
  if (req.query.include_custom === '1') {
    const seen = new Set(columns.map(c => c.column_name))
    for (const cf of db.prepare(
      `SELECT column_name, name, kind, COALESCE(result_type, type) AS field_type
       FROM custom_fields WHERE erp_table = ? AND deleted_at IS NULL AND kind <> 'native'
       ORDER BY name`
    ).all(erpTable)) {
      if (seen.has(cf.column_name) || nativeNames.has(cf.column_name)) continue
      columns.push({
        column_name: cf.column_name,
        airtable_field_name: `${cf.name} (champ personnalisé)`,
        field_type: cf.field_type || cf.kind || 'text',
        custom: true,
      })
    }
  }
  res.json({ columns, native_names: [...nativeNames] })
})

// GET /api/automations/field-rule/tables — list of erp_tables that have rules or
// field defs. ⚠️ Même contrainte d'ordre que /field-defs (avant GET /:id).
router.get('/field-rule/tables', (req, res) => {
  const rows = db.prepare(
    `SELECT DISTINCT erp_table FROM airtable_field_mappings ORDER BY erp_table`
  ).all()
  res.json(rows.map(r => r.erp_table))
})

// GET /api/automations/:id
router.get('/:id', (req, res) => {
  const automation = db.prepare(
    'SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  res.json(automation)
})

// POST /api/automations
router.post('/', (req, res) => {
  const { name, description, trigger_type, trigger_config, script, active, kind, action_type, action_config } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' })
  if (!trigger_type && kind !== 'field_rule' && kind !== 'webhook') return res.status(400).json({ error: 'trigger_type requis' })

  const isFieldRule = kind === 'field_rule'
  const isWebhook = kind === 'webhook'
  let at = 'script', acJson = '{}', tcJson = trigger_config || '{}', tt = trigger_type
  let webhookToken = null
  if (isFieldRule) {
    try {
      validateFieldRule({ trigger_config, action_type, action_config })
    } catch (e) { return res.status(400).json({ error: e.message }) }
    at = action_type
    acJson = typeof action_config === 'string' ? action_config : JSON.stringify(action_config || {})
    tcJson = typeof trigger_config === 'string' ? trigger_config : JSON.stringify(trigger_config || {})
    tt = 'field_rule'
  } else if (isWebhook) {
    try {
      validateWebhook({ action_config, script })
    } catch (e) { return res.status(400).json({ error: e.message }) }
    at = 'webhook'
    tt = 'webhook'
    acJson = typeof action_config === 'string' ? action_config : JSON.stringify(action_config || {})
    tcJson = typeof trigger_config === 'string' ? trigger_config : JSON.stringify(trigger_config || {})
    webhookToken = newWebhookToken()
  }

  const id = newId('auto')
  db.prepare(`
    INSERT INTO automations (id, name, description, trigger_type, trigger_config, action_type, action_config, script, active, kind, webhook_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name.trim(), description || null, tt,
    tcJson, at, acJson, isFieldRule ? '' : (script || ''),
    active !== undefined ? active : 1, isFieldRule ? 'field_rule' : (isWebhook ? 'webhook' : null), webhookToken)

  const created = db.prepare('SELECT * FROM automations WHERE id = ?').get(id)
  recordAutomationVersion(id, snapshotFromRow(created), req, { coalesce: false })

  if (created.trigger_type === 'schedule' && created.active) {
    scheduleAutomation(created)
  }

  res.status(201).json(created)
})

// PATCH /api/automations/:id
router.patch('/:id', (req, res) => {
  const automation = db.prepare(
    'SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })

  const { name, description, trigger_type, trigger_config, script, active, action_type, action_config } = req.body

  // Automations système configurables (ex. sys_revenue_recognition) : la condition
  // de déclenchement et les clés d'action whitelistées sont éditables, en plus du
  // toggle actif. Nom, description et comportement restent verrouillés.
  if (automation.system && CONFIGURABLE_SYSTEM_AUTOMATIONS.has(automation.id)) {
    let patch
    try {
      patch = validateConfigurableSystemPatch(automation, { trigger_config, action_config })
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }
    ensureBaselineVersion(automation)
    db.prepare(`
      UPDATE automations SET
        active = COALESCE(?, active),
        trigger_config = COALESCE(?, trigger_config),
        action_config = COALESCE(?, action_config),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(active ?? null, patch.tcJson, patch.acJson, req.params.id)
    const updated = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id)
    recordAutomationVersion(updated.id, snapshotFromRow(updated), req)
    return res.json(updated)
  }

  // System scripted automations are read-only except for the `active` toggle
  // and — for email-sending ones — a `from` override in action_config.
  // System field-rules are editable on trigger_config/action_type/action_config
  // (their whole point is a declarative, UI-tunable template) — only name,
  // description, and kind stay locked, plus they can't be deleted.
  if (automation.system && automation.kind !== 'field_rule') {
    const hasActionConfigUpdate = action_config !== undefined
    if (active === undefined && !hasActionConfigUpdate) {
      return res.status(403).json({ error: 'Automation système — lecture seule (seul le statut peut être modifié)' })
    }
    let nextActionConfigJson = null
    if (hasActionConfigUpdate) {
      if (!SYSTEM_EMAIL_AUTOMATIONS.has(automation.id)) {
        return res.status(403).json({ error: 'Automation système — action_config non modifiable' })
      }
      const incoming = typeof action_config === 'string' ? JSON.parse(action_config) : (action_config || {})
      // Only `from` is honored — any other key is silently ignored to avoid
      // surprise changes to system behaviour.
      const current = (() => { try { return JSON.parse(automation.action_config || '{}') } catch { return {} } })()
      const merged = { ...current }
      if ('from' in incoming) {
        const from = incoming.from
        if (from == null || from === '') {
          delete merged.from
        } else {
          const allowed = listFromAddresses()
          if (!allowed.includes(from)) {
            return res.status(400).json({ error: `Adresse "${from}" non autorisée` })
          }
          merged.from = from
        }
      }
      nextActionConfigJson = JSON.stringify(merged)
    }
    ensureBaselineVersion(automation)
    db.prepare(`
      UPDATE automations SET
        active = COALESCE(?, active),
        action_config = COALESCE(?, action_config),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(active ?? null, nextActionConfigJson, req.params.id)
    const updated = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id)
    recordAutomationVersion(updated.id, snapshotFromRow(updated), req)
    return res.json(updated)
  }

  // Field-rule edits: validate trigger_config/action_config if any of them changed
  if (automation.kind === 'field_rule'
      && (trigger_config !== undefined || action_config !== undefined || action_type !== undefined)) {
    try {
      validateFieldRule({
        trigger_config: trigger_config ?? automation.trigger_config,
        action_type: action_type ?? automation.action_type,
        action_config: action_config ?? automation.action_config,
      })
    } catch (e) { return res.status(400).json({ error: e.message }) }
  }

  // Webhook edits: revalider la config déclarative / script si elle change.
  if (automation.kind === 'webhook' && (action_config !== undefined || script !== undefined)) {
    try {
      validateWebhook({
        action_config: action_config ?? automation.action_config,
        script: script ?? automation.script,
      })
    } catch (e) { return res.status(400).json({ error: e.message }) }
  }

  ensureBaselineVersion(automation)
  db.prepare(`
    UPDATE automations SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      trigger_type = COALESCE(?, trigger_type),
      trigger_config = COALESCE(?, trigger_config),
      action_type = COALESCE(?, action_type),
      action_config = COALESCE(?, action_config),
      script = COALESCE(?, script),
      active = COALESCE(?, active),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(
    automation.system ? null : (name !== undefined ? name.trim() : null),
    automation.system ? null : (description !== undefined ? description : null),
    trigger_type !== undefined ? trigger_type : null,
    trigger_config !== undefined
      ? (typeof trigger_config === 'string' ? trigger_config : JSON.stringify(trigger_config))
      : null,
    action_type !== undefined ? action_type : null,
    action_config !== undefined
      ? (typeof action_config === 'string' ? action_config : JSON.stringify(action_config))
      : null,
    script !== undefined ? script : null,
    active !== undefined ? active : null,
    req.params.id
  )

  const updated = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id)
  recordAutomationVersion(updated.id, snapshotFromRow(updated), req)

  // Mettre à jour le scheduler
  if (updated.trigger_type === 'schedule') {
    if (updated.active) scheduleAutomation(updated)
    else unscheduleAutomation(updated.id)
  } else {
    unscheduleAutomation(updated.id)
  }

  res.json(updated)
})

// DELETE /api/automations/:id
router.delete('/:id', (req, res) => {
  const automation = db.prepare(
    'SELECT id, system FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  if (automation.system) {
    return res.status(403).json({ error: 'Automation système — suppression interdite' })
  }

  db.prepare("UPDATE automations SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(req.params.id)
  unscheduleAutomation(req.params.id)
  res.json({ success: true })
})

// GET /api/automations/:id/logs
router.get('/:id/logs', (req, res) => {
  const automation = db.prepare(
    'SELECT id FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })

  const logs = db.prepare(`
    SELECT * FROM automation_logs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(req.params.id)
  res.json(logs)
})

// GET /api/automations/:id/versions
// Historique des révisions (snapshot complet + qui/quand), plus récent d'abord.
router.get('/:id/versions', (req, res) => {
  const automation = db.prepare(
    'SELECT id FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  const versions = db.prepare(`
    SELECT * FROM automation_versions WHERE automation_id = ? ORDER BY version DESC LIMIT 100
  `).all(req.params.id)
  res.json(versions)
})

// POST /api/automations/:id/versions/:versionId/restore
// Restaure la configuration (déclencheur/action/script) d'une révision passée.
// Le statut actif/inactif courant N'est PAS touché (éviter une réactivation
// surprise d'une règle désactivée). Crée une nouvelle révision marqueur.
router.post('/:id/versions/:versionId/restore', (req, res) => {
  const automation = db.prepare(
    'SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  if (automation.system) {
    return res.status(403).json({ error: 'Automation système — restauration interdite' })
  }
  const version = db.prepare(
    'SELECT * FROM automation_versions WHERE id = ? AND automation_id = ?'
  ).get(req.params.versionId, req.params.id)
  if (!version) return res.status(404).json({ error: 'Version introuvable' })

  // Revalider la config restaurée selon le genre (une vieille version peut être
  // invalide vis-à-vis de règles de validation ajoutées depuis).
  if (automation.kind === 'field_rule') {
    try {
      validateFieldRule({
        trigger_config: version.trigger_config,
        action_type: version.action_type,
        action_config: version.action_config,
      })
    } catch (e) { return res.status(400).json({ error: `Version invalide : ${e.message}` }) }
  } else if (automation.kind === 'webhook') {
    try {
      validateWebhook({ action_config: version.action_config, script: version.script })
    } catch (e) { return res.status(400).json({ error: `Version invalide : ${e.message}` }) }
  }

  ensureBaselineVersion(automation)
  db.prepare(`
    UPDATE automations SET
      name = ?, description = ?, trigger_type = ?, trigger_config = ?,
      action_type = ?, action_config = ?, script = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(version.name, version.description, version.trigger_type, version.trigger_config,
    version.action_type, version.action_config, version.script, req.params.id)

  const updated = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id)
  recordAutomationVersion(updated.id, snapshotFromRow(updated), req, {
    coalesce: false, summary: `Restauration de la version ${version.version}`,
  })

  if (updated.trigger_type === 'schedule') {
    if (updated.active) scheduleAutomation(updated)
    else unscheduleAutomation(updated.id)
  } else {
    unscheduleAutomation(updated.id)
  }

  res.json(updated)
})

// POST /api/automations/:id/run
// Body: { dryRun?: boolean } — only honoured for system automations with a registered manual runner.
router.post('/:id/run', async (req, res) => {
  const automation = db.prepare(
    'SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })

  if (automation.system) {
    const runner = MANUAL_RUNNERS[automation.id]
    if (!runner) {
      return res.status(403).json({ error: 'Automation système — non exécutable manuellement' })
    }
    const dryRun = !!req.body?.dryRun
    const t0 = Date.now()
    try {
      const out = await runner({ dryRun })
      const duration_ms = Date.now() - t0
      // Dry-runs don't pollute the run history — they're previews, not executions.
      if (!dryRun) {
        logSystemRun(automation.id, {
          status: 'success',
          result: `[Manuel] ${out.summary}\n\n${(out.details || []).map(d => `${d.action.toUpperCase()} — ${d.company_name || d.company_id} → ${d.to || '—'}${d.error ? ` · ${d.error}` : ''}`).join('\n')}`,
          duration_ms,
          triggerData: { trigger: 'manual', dryRun: false },
        })
      }
      return res.json({ status: 'success', dryRun, duration_ms, output: out })
    } catch (e) {
      const duration_ms = Date.now() - t0
      if (!dryRun) {
        logSystemRun(automation.id, { status: 'error', error: e.message, duration_ms })
      }
      return res.status(500).json({ status: 'error', error: e.message })
    }
  }

  const result = await runAutomation(automation, { trigger: 'manual' })
  res.json(result)
})

// GET /api/automations/:id/fires?limit=100
router.get('/:id/fires', (req, res) => {
  const automation = db.prepare(
    'SELECT id, kind FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  const limit = parseLimit(req.query.limit, { def: 100, max: 500 })
  const fires = db.prepare(`
    SELECT automation_id, record_table, record_id, fired_at
    FROM automation_rule_fires
    WHERE automation_id = ?
    ORDER BY fired_at DESC
    LIMIT ?
  `).all(req.params.id, limit)
  res.json(fires)
})

// POST /api/automations/:id/reset-fires — re-enable a rule to fire again on existing rows
router.post('/:id/reset-fires', (req, res) => {
  const automation = db.prepare(
    'SELECT id, kind FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  if (automation.kind !== 'field_rule') {
    return res.status(400).json({ error: 'Reset disponible uniquement pour les règles de champ' })
  }
  const info = db.prepare('DELETE FROM automation_rule_fires WHERE automation_id = ?').run(req.params.id)
  res.json({ success: true, deleted: info.changes })
})

// GET /api/automations/:id/deferred-queue — backpressure depth gauge.
// When an evaluation matches more rows than CANDIDATE_CAP can dispatch, the
// overflow is parked in automation_deferred_candidates and drained batch by batch.
// Exposes the current depth (+ oldest entry + a sample of pending ids) so a rule
// quietly chewing through thousands of matches becomes observable.
router.get('/:id/deferred-queue', (req, res) => {
  const automation = db.prepare(
    'SELECT id, kind FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  const { depth, oldest } = db.prepare(`
    SELECT COUNT(*) AS depth, MIN(enqueued_at) AS oldest
    FROM automation_deferred_candidates WHERE automation_id = ?
  `).get(req.params.id)
  const items = db.prepare(`
    SELECT record_table, record_id, enqueued_at
    FROM automation_deferred_candidates
    WHERE automation_id = ?
    ORDER BY enqueued_at ASC
    LIMIT 100
  `).all(req.params.id)
  res.json({ depth, oldest_enqueued_at: oldest, batch_size: CANDIDATE_CAP, items })
})

// POST /api/automations/:id/drain-deferred — force an immediate drain of one
// batch (CANDIDATE_CAP) from this rule's deferred queue. Dispatches real actions.
router.post('/:id/drain-deferred', async (req, res) => {
  const automation = db.prepare(
    'SELECT id, kind FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  if (automation.kind !== 'field_rule') {
    return res.status(400).json({ error: 'Disponible uniquement pour les règles de champ' })
  }
  try {
    const out = await drainDeferredForAutomation(req.params.id)
    res.json({ status: 'success', ...out })
  } catch (e) {
    res.status(400).json({ status: 'error', error: e.message })
  }
})

// POST /api/automations/:id/test
//  - field_rule : dry-run sans dispatch ni insertion de fires
//  - webhook    : dry-run déclaratif (matches + réponse calculés, AUCUNE écriture)
//                 avec les params fournis dans le body { params: {...} }
router.post('/:id/test', async (req, res) => {
  const automation = db.prepare(
    'SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })

  if (automation.kind === 'webhook') {
    try {
      const params = (req.body?.params && typeof req.body.params === 'object') ? req.body.params : {}
      const out = await runWebhook(automation, {
        method: 'POST', query: {}, body: params, params, headers: {}, dryRun: true,
      })
      return res.json(out)
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }
  }

  if (automation.kind !== 'field_rule') {
    return res.status(400).json({ error: 'Test disponible uniquement pour les règles de champ et les webhooks' })
  }
  try {
    const rule = {
      id: automation.id,
      trigger_config: JSON.parse(automation.trigger_config || '{}'),
      action_type: automation.action_type,
      action_config: JSON.parse(automation.action_config || '{}'),
    }
    const out = dryRunFieldRule(rule)
    res.json(out)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// POST /api/automations/:id/run-date-rule
// Exécute immédiatement une règle de date relative (op date_offset) « comme
// aujourd'hui » : dispatch réel des actions + enregistrement des fires (dedup).
// Sert au bouton « Lancer maintenant » et permet de tester sans attendre le cron.
router.post('/:id/run-date-rule', async (req, res) => {
  const automation = db.prepare(
    'SELECT id, kind FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  if (automation.kind !== 'field_rule') {
    return res.status(400).json({ error: 'Disponible uniquement pour les règles de champ' })
  }
  try {
    const out = await runDateOffsetRuleNow(req.params.id)
    res.json({ status: 'success', ...out })
  } catch (e) {
    res.status(400).json({ status: 'error', error: e.message })
  }
})

// POST /api/automations/:id/rotate-token — régénère le token d'un webhook (révoque l'ancien)
router.post('/:id/rotate-token', (req, res) => {
  const automation = db.prepare(
    'SELECT id, kind FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  if (automation.kind !== 'webhook') {
    return res.status(400).json({ error: 'Rotation disponible uniquement pour les webhooks' })
  }
  const token = newWebhookToken()
  db.prepare(`
    UPDATE automations SET webhook_token = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(token, req.params.id)
  res.json({ webhook_token: token })
})

// Max attempts before a webhook retry is abandoned — mirrors processRetryQueue()
// in server/src/services/airtableWebhooks.js. Keep in sync.
const WEBHOOK_RETRY_MAX_ATTEMPTS = 5

// GET /api/automations/:id/retry-queue
// Exposes the Airtable webhook retry queue (table webhook_sync_retry) so the
// "1 module(s) en échec (retry queue)" log line becomes actionable: which
// module, which error, how many attempts, and when the next retry fires.
// Only meaningful for sys_airtable_webhook_router.
router.get('/:id/retry-queue', (req, res) => {
  if (req.params.id !== 'sys_airtable_webhook_router') {
    return res.status(404).json({ error: 'File de retry indisponible pour cette automation' })
  }
  const rows = db.prepare(`
    SELECT id, module, attempts, last_error, created_at, next_retry_at
    FROM webhook_sync_retry
    ORDER BY next_retry_at ASC
  `).all()
  res.json({ items: rows, max_attempts: WEBHOOK_RETRY_MAX_ATTEMPTS })
})

// POST /api/automations/:id/retry-queue/:retryId/retry
// Force an immediate retry of one queued module: reset next_retry_at to now,
// then drain the due queue. Returns the refreshed queue.
router.post('/:id/retry-queue/:retryId/retry', async (req, res) => {
  if (req.params.id !== 'sys_airtable_webhook_router') {
    return res.status(404).json({ error: 'File de retry indisponible pour cette automation' })
  }
  const row = db.prepare('SELECT id FROM webhook_sync_retry WHERE id = ?').get(req.params.retryId)
  if (!row) return res.status(404).json({ error: 'Entrée de retry introuvable' })

  db.prepare(
    "UPDATE webhook_sync_retry SET next_retry_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ).run(req.params.retryId)

  await processRetryQueue()

  const items = db.prepare(`
    SELECT id, module, attempts, last_error, created_at, next_retry_at
    FROM webhook_sync_retry
    ORDER BY next_retry_at ASC
  `).all()
  res.json({ items, max_attempts: WEBHOOK_RETRY_MAX_ATTEMPTS })
})

// GET /api/automations/:id/email-preview?language=French
// Renders a sample of the email body for preview in the UI.
// Handles field-rule emails (first dry-run candidate) and sys_installation_followup.
router.get('/:id/email-preview', (req, res) => {
  const automation = db.prepare(
    'SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })

  const language = req.query.language === 'English' ? 'English' : 'French'
  const appUrl = APP_URL

  // System email automations — render template with a real candidate record
  // when one exists, otherwise fall back to hardcoded sample data.
  if (automation.id === 'sys_installation_followup') {
    const subject = language === 'French' ? "Comment s'est passé l'installation ?" : 'How did the installation go?'
    // Relaxed query: ignore the 21-day min and the idempotency flag so that
    // even after a campaign has rolled out, the preview still shows a real row.
    const eligibles = selectEligibleCompanies(db, {
      minDays: 0,
      earliestShipment: '1970-01-01',
      includeAlreadySent: true,
    })
    const candidates = eligibles.slice(0, 50).map(c => ({
      id: c.company_id, label: c.company_name,
    }))

    const requestedId = req.query.record_id ? String(req.query.record_id) : null
    let candidate = null
    if (requestedId) {
      candidate = eligibles.find(c => c.company_id === requestedId) || null
    }
    if (!candidate) {
      candidate = eligibles.find(c =>
        (language === 'French' ? (c.contact_language || c.company_language || '').toLowerCase().startsWith('fr') : true)
      ) || eligibles[0] || null
    }

    const firstName = candidate?.contact_first_name || 'Alex'
    const companyId = candidate?.company_id || '00000000-0000-0000-0000-000000000000'
    const bodyHtml = buildInstallationEmailHtml({
      language,
      firstName,
      companyId,
      emailId: 'preview-sample',
      appUrl,
    })
    return res.json({
      available: true, kind: 'system', automation_id: automation.id,
      subject, bodyHtml, bodyText: null,
      sample: true, languages: ['French', 'English'], language,
      sample_record: candidate
        ? { id: candidate.company_id, label: candidate.company_name }
        : null,
      candidates,
    })
  }

  if (automation.id === 'sys_shipment_tracking_email') {
    return res.json({
      available: false,
      reason: "L'aperçu de cette automation n'est pas encore implémenté — utilisez le bouton « Envoyer le suivi » d'un envoi pour tester.",
    })
  }

  // Field-rule email automations — dry-run first candidate
  if (automation.kind === 'field_rule' && automation.action_type === 'email') {
    // Ne pas avaler une config corrompue : un action_config JSON invalide
    // ferait tourner l'aperçu (et l'exécution) avec {} — l'automation paraît
    // marcher mais n'envoie rien. On remonte une erreur explicite.
    let actionConfig
    try {
      actionConfig = JSON.parse(automation.action_config || '{}')
    } catch (e) {
      return res.status(400).json({
        available: false,
        invalid_config: true,
        error: `Configuration de l'automation corrompue : action_config n'est pas du JSON valide (${e.message}). Corrigez-la avant d'utiliser cette automation.`,
      })
    }
    try {
      const rule = {
        id: automation.id,
        trigger_config: JSON.parse(automation.trigger_config || '{}'),
        action_type: 'email',
        action_config: actionConfig,
      }
      // previewLimit 50 → the picker lists up to 50 matching records; rendering
      // each is cheap and avoids a second query when one is selected.
      const out = dryRunFieldRule(rule, { previewLimit: 50 })
      const candidates = out.previews.map(p => ({
        id: p.id, label: p.label, already_fired: !!p.already_fired,
      }))

      // Pick the record to render: the explicitly-requested one (if any), else
      // the first candidate that renders cleanly.
      const requestedId = req.query.record_id ? String(req.query.record_id) : null
      let chosen = null
      if (requestedId) {
        chosen = out.previews.find(p => p.id === requestedId) || null
        // Requested record is outside the candidate set (doesn't match the
        // trigger, or beyond the 50-row window) — render it on demand so the
        // user can still preview any record they pick.
        if (!chosen) chosen = previewRuleForRecord(rule, requestedId)
        if (!chosen) {
          return res.status(404).json({
            available: false,
            error: `Record introuvable: ${requestedId}`,
          })
        }
      } else {
        chosen = out.previews.find(p => !p.error && p.rendered) || null
      }

      if (chosen && chosen.rendered) {
        return res.json({
          available: true, kind: 'field_rule', automation_id: automation.id,
          subject: chosen.rendered.subject || '',
          bodyHtml: chosen.rendered.bodyHtml || '',
          bodyText: chosen.rendered.bodyText || '',
          from: chosen.rendered.from || null,
          to: chosen.rendered.to || null,
          sample: true,
          sample_record: { id: chosen.id, label: chosen.label },
          matches_trigger: chosen.matches_trigger !== false,
          candidates,
          candidates_total: out.candidates_total,
        })
      }
      if (chosen && chosen.error) {
        // The chosen record exists but its template failed to render.
        return res.json({
          available: true, kind: 'field_rule', automation_id: automation.id,
          subject: '', bodyHtml: '', bodyText: '',
          from: actionConfig.from || null, to: actionConfig.to || null,
          sample: true,
          sample_record: { id: chosen.id, label: chosen.label },
          render_error: chosen.error,
          candidates,
          candidates_total: out.candidates_total,
        })
      }
      // No candidate matches — return the raw template (placeholders intact)
      return res.json({
        available: true, kind: 'field_rule', automation_id: automation.id,
        subject: actionConfig.subject || '',
        bodyHtml: actionConfig.bodyHtml || '',
        bodyText: actionConfig.bodyText || '',
        from: actionConfig.from || null,
        to: actionConfig.to || null,
        sample: false,
        candidates,
        candidates_total: 0,
      })
    } catch (e) {
      return res.status(400).json({ error: e.message, available: false })
    }
  }

  res.json({ available: false, reason: 'Cette automation n\'envoie pas de courriel ou son aperçu n\'est pas supporté.' })
})

// POST /api/automations/:id/test-email
// Body: { to: string, language?: 'French'|'English' }
router.post('/:id/test-email', async (req, res) => {
  const automation = db.prepare(
    'SELECT id, system FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  const sender = TEST_EMAIL_SENDERS[automation.id]
  if (!sender) return res.status(403).json({ error: 'Pas d\'aperçu disponible pour cette automation' })

  const { to, language } = req.body || {}
  if (!to || !/@/.test(to)) return res.status(400).json({ error: 'Adresse email invalide' })

  try {
    const out = await sender({ to, language })
    res.json({ status: 'success', ...out })
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message })
  }
})

export default router
