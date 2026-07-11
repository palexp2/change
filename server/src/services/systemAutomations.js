import db from '../db/database.js'
import { sendInstallationFollowups } from './installationFollowup.js'
import { getAutomationFrom } from './postmarkConfig.js'
import { syncAndPushStripePayouts } from './quickbooks.js'

// Registry of system automations that can be invoked manually from the UI
// (dry-run to preview, or run-now to execute). Omit an id here to keep it
// un-runnable — pure passive system automations (webhooks, post_sync) don't
// belong here.
//
// Each handler receives { dryRun } and returns a plain object that will be
// serialized into the automation_logs `result` field verbatim.
export const MANUAL_RUNNERS = {
  sys_installation_followup: async ({ dryRun }) => {
    const out = await sendInstallationFollowups(db, { dryRun, fromAddress: getAutomationFrom('sys_installation_followup') })
    return {
      summary: `${out.total} éligible(s) · ${out.sent} envoyé(s) · ${out.skipped} dry-run · ${out.errors} erreur(s)`,
      details: out.details,
    }
  },
  sys_stripe_weekly_payout_push: async ({ dryRun }) => {
    return await syncAndPushStripePayouts({ dryRun })
  },
}

// System automations: hard-coded triggers/actions that live in code, surfaced
// in the UI read-only so users can see trigger, behaviour, and run history.
// Add a new system automation here and instrument its code path with
// `logSystemRun(key, { status, result, error, duration_ms })`.
export const SYSTEM_AUTOMATIONS = [
  // `sys_slack_hardware_escalade` is now seeded as a field_rule (see
  // SYSTEM_FIELD_RULES below), not a hardcoded system automation. Its logs
  // remain linked through the same id for continuity.
  {
    id: 'sys_stripe_invoice_paid',
    name: 'Stripe invoice.paid → Facture',
    description:
      "À la réception d'un webhook Stripe invoice.paid, la table factures est mise à jour (status='Payé', total, company résolue par email/nom) et le PDF Stripe est téléchargé. " +
      "Idempotent : un second événement pour la même invoice met à jour la ligne existante (matching par invoice_id).",
    trigger_config: {
      kind: 'webhook',
      source: 'POST /api/stripe-webhooks',
      event: 'invoice.paid',
      summary: 'Webhook entrant Stripe sur événement invoice.paid',
    },
  },
  {
    id: 'sys_shipment_tracking_email',
    name: 'Envoi email de suivi (Postmark)',
    description:
      "Envoie un email bilingue (FR/EN selon la langue du contact) contenant le lien de suivi du transporteur. " +
      "L'envoi est fait via Postmark, un pixel invisible est inséré pour tracker l'ouverture (table emails), " +
      "une interaction de type 'email' est créée, et shipments.tracking_email_sent_at est mis à jour.",
    trigger_config: {
      kind: 'manual',
      source: 'POST /api/shipments/:id/send-tracking',
      summary: "Déclenché manuellement depuis la fiche envoi (bouton « Envoyer le suivi »)",
    },
  },
  {
    id: 'sys_revenue_recognition',
    name: 'Constat de vente à l\'expédition (Dr 23900|AR / Cr 40000)',
    description:
      "Quand un envoi satisfait la condition configurée (défaut : status = « Envoyé »), le revenu des factures kind='order' " +
      "liées à la commande est constaté en QB (JournalEntry Dr passif différé | AR / Cr Ventes — comptes configurables ci-dessous). " +
      "Déclenché par modification DB via un watcher qui tail change_log sur la table shipments (revenueRecognitionWatcher) — " +
      "plus aucune route front-end n'appelle la reconnaissance directement. " +
      "Idempotent (skip si déjà constaté, abonnement, pas d'envoi lié, ou payout Stripe en attente). " +
      "Les échecs (QB indisponible, montant manquant) sont persistés dans revenue_recognition_queue et retentés avec backoff " +
      "jusqu'au succès — le revenu n'est jamais silencieusement perdu. " +
      "La condition de déclenchement et les comptes QB sont modifiables ; désactiver l'automation suspend le constat (les " +
      "écritures survenues pendant la pause ne sont pas rejouées à la réactivation). " +
      "La condition peut aussi porter sur la table factures — y compris un champ personnalisé (ex. lookup « Date d'envoi de " +
      "la commande liée ») : la facture qui satisfait la condition est alors constatée directement, et elle est réévaluée " +
      "quand la facture, sa commande ou un envoi de la commande change.",
    // Partie éditable (colonne/op/valeur sur shipments) — voir CONFIGURABLE_SYSTEM_AUTOMATIONS.
    trigger_config: {
      kind: 'db_change',
      source: 'change_log(shipments) → revenueRecognitionWatcher',
      summary: "Déclenché à l'écriture DB d'un shipment status='Envoyé' (toute origine : UI, Novoxpress, sync Airtable)",
      erp_table: 'shipments',
      column: 'status',
      op: 'eq',
      value: 'Envoyé',
    },
    // Overrides de comptes QB (AcctNum) lus par postRevenueRecognitionJE.
    action_config: {
      deferred_acctnum: '23900',
      sale_acctnum: '40000',
      ar_cad_acctnum: '12000',
      ar_usd_acctnum: '12100',
    },
    configurable: true,
  },
  {
    id: 'sys_stripe_charge_refunded',
    name: 'Stripe charge.refunded → Facture (Remboursement)',
    description:
      "À la réception d'un webhook Stripe charge.refunded, une ligne est créée dans la table factures pour chaque refund avec succès " +
      "(status='Remboursement', sync_source='Remboursements Stripe', invoice_id=re_xxx). " +
      "La company est résolue via stripe_customer_id puis fallback email/nom. " +
      "Les doublons sont évités par dedup sur invoice_id+sync_source. Ne touche pas aux refunds historiques importés depuis Airtable (qui utilisent ch_xxx comme invoice_id).",
    trigger_config: {
      kind: 'webhook',
      source: 'POST /api/stripe-webhooks',
      event: 'charge.refunded',
      summary: 'Webhook entrant Stripe sur événement charge.refunded',
    },
  },
  {
    id: 'sys_stripe_refunds_backfill',
    name: 'Backfill remboursements Stripe → Factures',
    description:
      "Parcourt tous les stripe_balance_transactions de type 'refund'/'payment_refund' déjà synchronisés, " +
      "et insère pour chacun une facture (status='Remboursement', sync_source='Remboursements Stripe'). " +
      "Dedup par invoice_id (re_xxx). Utilisé pour rattraper l'historique avant que le webhook charge.refunded soit en place.",
    trigger_config: {
      kind: 'manual',
      source: 'POST /api/stripe-payouts/backfill-refunds',
      summary: 'Déclenché manuellement pour backfill historique',
    },
  },
  {
    id: 'sys_stripe_bulk_bt_sync',
    name: 'Sync balance_transactions sur tous les payouts',
    description:
      "Itère tous les stripe_payouts qui n'ont pas encore de balance_transactions synchronisés, " +
      "et appelle syncStripeBalanceTransactions pour chacun. Avec onlyMissing=false, force le resync de tous les payouts. " +
      "Source des refund/charge/fee/dispute pour QB et pour le backfill remboursements.",
    trigger_config: {
      kind: 'manual',
      source: 'POST /api/stripe-payouts/sync-all-transactions',
      summary: 'Déclenché manuellement pour sync bulk',
    },
  },
  {
    id: 'sys_stripe_batch_factures_sync',
    name: 'Batch Stripe → Factures (sync complet)',
    description:
      "Récupère toutes les factures depuis Stripe via l'API list, puis UPSERT chacune dans la table factures " +
      "(status, total, devise, date, numéro, subscription liée, company matchée). " +
      "Utilisé pour rattraper les factures ratées par le webhook, ou lors d'une resync manuelle.",
    trigger_config: {
      kind: 'manual',
      source: 'POST /api/stripe-queue/batch-enrich',
      summary: 'Déclenché manuellement depuis l\'interface Stripe / QuickBooks',
    },
  },
  {
    id: 'sys_airtable_webhook_router',
    name: 'Router webhooks Airtable',
    description:
      "À chaque ping webhook d'Airtable, récupère les payloads (modifications/créations/suppressions) via l'API, " +
      "groupe les changements par table puis par module, et déclenche les sync functions appropriées (syncAirtable, syncProjets, syncBillets, etc.). " +
      "Les échecs sont placés dans une queue de retry. Le cursor est avancé immédiatement pour éviter le retraitement.",
    trigger_config: {
      kind: 'webhook',
      source: 'POST /api/connectors/airtable/webhook-ping',
      summary: 'Ping Airtable reçu → fetch payloads → dispatch par module',
    },
  },
  {
    id: 'sys_gmail_sync',
    name: 'Sync Gmail (heure)',
    description:
      "Synchronise toutes les boîtes Gmail connectées (via OAuth) : récupère les nouveaux messages, " +
      "les associe aux contacts/entreprises, crée des interactions + emails. " +
      "Ingère comme factures fournisseurs (sale_receipts + extraction IA) tout message portant le label ERP/Factures " +
      "OU adressé/livré à factures@orisha.io — aucun label requis ; dédup inter-boîtes par Message-ID RFC822. " +
      "Resynchronise d'abord le répertoire fournisseurs (table vendor_directory) depuis le Google Doc " +
      "« Fournisseurs_Particularités », injecté ensuite dans le prompt d'extraction. " +
      "Exécute aussi rematchCalls() pour relier les appels orphelins à des contacts. " +
      "Démarre 30s après le boot puis s'exécute toutes les heures.",
    trigger_config: {
      kind: 'schedule',
      source: 'index.js:scheduleGmailSync',
      cron: '0 * * * * (interval 1h)',
      summary: 'Scheduler interne — toutes les heures',
    },
  },
  {
    id: 'sys_airtable_fallback_sync',
    name: 'Fallback sync Airtable (24h)',
    description:
      "Resync complet de tous les modules Airtable (projets, pièces, commandes, billets, serials, envois, soumissions, retours, adresses, BOM, assemblages, factures, stock movements). " +
      "Sert de filet de sécurité si les webhooks Airtable manquent des événements. " +
      "Purge aussi les logs de sync > 7 jours. Une exécution dure plusieurs minutes.",
    trigger_config: {
      kind: 'schedule',
      source: 'index.js:scheduleAirtableFallback',
      cron: 'every 24h',
      summary: 'Scheduler interne — une fois par jour',
    },
  },
  {
    id: 'sys_airtable_token_refresh',
    name: 'Refresh proactif token Airtable (10min)',
    description:
      "Vérifie toutes les 10 minutes si le token OAuth Airtable expire dans moins de 15 minutes. " +
      "Si oui, force un refresh pour éviter qu'un webhook ou un sync échoue avec un token expiré. " +
      "Premier check à +60s du boot.",
    trigger_config: {
      kind: 'schedule',
      source: 'index.js:refreshExpiringAirtableTokens',
      cron: 'every 10min',
      summary: 'Scheduler interne — toutes les 10 minutes',
    },
  },
  {
    id: 'sys_installation_followup',
    name: "Email de suivi d'installation (J+21)",
    description:
      "Envoie un email bilingue aux nouveaux clients 21 jours après le premier envoi de leur commande. " +
      "Nouveau client = une seule commande + pas d'email déjà envoyé. Le courriel va au contact lié à l'adresse de livraison du premier envoi. " +
      "Le clic sur « Je suis bloqué » ou « C'était pénible » crée une tâche automatique assignée à Marc-Antoine (liée au contact). " +
      "Le flag companies.installation_followup_sent_at empêche tout double envoi. " +
      "⚠️ Désactivé par défaut au premier déploiement — activer manuellement depuis cette page après vérification.",
    trigger_config: {
      kind: 'schedule',
      source: 'index.js:scheduleInstallationFollowup',
      cron: 'every 24h at 09:00',
      summary: 'Scheduler interne — une fois par jour à 9h (local)',
    },
    default_active: 0,
  },
  {
    id: 'sys_stripe_weekly_payout_push',
    name: 'Sync + push QB des Stripe payouts (lundi midi)',
    description:
      "Chaque lundi à 12h00 (local) : pull incrémental des nouveaux Stripe payouts, sync des balance_transactions manquantes, " +
      "puis push automatique de chaque dépôt QuickBooks pour les payouts réglés (status='paid') pas encore poussés. " +
      "GARDE ANTI-ERREUR : avant chaque push, le Deposit est construit en dry build et inspecté — tout payout générant un warning " +
      "(client QB non résolu, taxe sur frais non imputée, TaxCode manquant…) est laissé en attente de revue manuelle, jamais poussé à l'aveugle. " +
      "Idempotent : un payout déjà lié à un Deposit (qb_deposit_id) est ignoré. " +
      "⚠️ Désactivé par défaut au premier déploiement — activer manuellement depuis cette page après vérification. " +
      "Exécutable en dry-run (preview) ou run-now depuis cette page.",
    trigger_config: {
      kind: 'schedule',
      source: 'index.js:scheduleStripeWeeklyPayoutPush',
      cron: '0 12 * * 1 (lundi 12h00 local)',
      summary: 'Scheduler interne — tous les lundis à midi (local)',
    },
    default_active: 0,
  },
  {
    id: 'sys_airtable_webhooks_init',
    name: 'Enregistrement webhooks Airtable (boot)',
    description:
      "Au démarrage du serveur (+5s), enregistre les webhooks Airtable côté API Airtable pour les bases/tables configurées. " +
      "Les webhooks existants sont réutilisés si valides, sinon recréés. " +
      "Sans ce step, Airtable n'envoie aucun ping et le fallback 24h devient la seule source de sync.",
    trigger_config: {
      kind: 'startup',
      source: 'index.js:initAirtableWebhooks',
      summary: 'Démarrage du serveur (+5s après listen())',
    },
  },
]

// System automations dont trigger_config/action_config sont partiellement
// éditables par l'utilisateur (routes/automations.js PATCH + AutomationDetail.jsx).
// Le seed ne doit PAS écraser leur configuration au boot — seed-on-first-insert
// puis merge additif des clés par défaut manquantes (migration douce).
export const CONFIGURABLE_SYSTEM_AUTOMATIONS = new Set(
  SYSTEM_AUTOMATIONS.filter(sa => sa.configurable).map(sa => sa.id)
)

// Merge additif : ajoute dans le JSON stocké les clés par défaut absentes, sans
// toucher aux valeurs existantes (les éditions utilisateur priment). Retourne la
// chaîne JSON à persister, ou null si rien à changer.
function mergeMissingKeys(storedJson, defaults) {
  let stored
  try { stored = JSON.parse(storedJson || '{}') } catch { stored = {} }
  let changed = false
  for (const [k, v] of Object.entries(defaults || {})) {
    if (stored[k] === undefined) { stored[k] = v; changed = true }
  }
  return changed ? JSON.stringify(stored) : null
}

export function seedSystemAutomations() {
  // ON CONFLICT doesn't touch `active`, so user toggles persist across seeds.
  // On first insert we honour `default_active` (default 1) — use 0 to ship a
  // new automation disabled until an operator flips it on.
  const insertStmt = db.prepare(`
    INSERT INTO automations
      (id, name, description, trigger_type, trigger_config, action_type, action_config, active, system, created_at, updated_at)
    VALUES (?, ?, ?, 'system', ?, 'system', ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      trigger_config = excluded.trigger_config,
      system = 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `)
  // Variante configurable : ne réécrit jamais trigger_config au boot.
  const insertConfigurableStmt = db.prepare(`
    INSERT INTO automations
      (id, name, description, trigger_type, trigger_config, action_type, action_config, active, system, created_at, updated_at)
    VALUES (?, ?, ?, 'system', ?, 'system', ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      system = 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `)

  for (const sa of SYSTEM_AUTOMATIONS) {
    const stmt = sa.configurable ? insertConfigurableStmt : insertStmt
    stmt.run(
      sa.id, sa.name, sa.description,
      JSON.stringify(sa.trigger_config),
      JSON.stringify(sa.action_config || {}),
      sa.default_active ?? 1,
    )
    if (sa.configurable) {
      // Migration douce : complète le row existant avec les clés éditables
      // introduites depuis (ex. column/op/value absents de l'ancien shape).
      const row = db.prepare('SELECT trigger_config, action_config FROM automations WHERE id = ?').get(sa.id)
      const tc = mergeMissingKeys(row?.trigger_config, sa.trigger_config)
      const ac = mergeMissingKeys(row?.action_config, sa.action_config)
      if (tc || ac) {
        db.prepare(`
          UPDATE automations SET
            trigger_config = COALESCE(?, trigger_config),
            action_config = COALESCE(?, action_config),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?
        `).run(tc, ac, sa.id)
      }
    }
  }
  console.log(`✅ System automations seeded (${SYSTEM_AUTOMATIONS.length})`)

  seedSystemFieldRules()
}

// Declarative field-value rules shipped as system defaults. Same `id` as the
// original hardcoded automations so automation_logs continuity is preserved.
// Each rule is evaluated by services/fieldRuleEngine.js when FEATURE_FIELD_RULES=true.
export const SYSTEM_FIELD_RULES = [
  {
    id: 'sys_slack_hardware_escalade',
    name: 'Escalade Hardware → Slack',
    description:
      "Quand le champ Escalade d'un billet devient « Hardware », envoie une notification Slack via SLACK_WEBHOOK_HARDWARE. " +
      "Chaque billet n'est notifié qu'une seule fois (tracking dans automation_rule_fires).",
    trigger_config: {
      erp_table: 'tickets',
      column: 'escalade',
      op: 'eq',
      value: 'Hardware',
      fire_on: 'per_record_once',
    },
    action_type: 'slack',
    action_config: {
      webhookEnv: 'SLACK_WEBHOOK_HARDWARE',
      text:
        '🔧 *Escalade Hardware* — {{title}}\n' +
        'Entreprise : {{company_name}}\n' +
        'Type : {{type}} | Statut : {{status}}\n' +
        '<{{app_url}}/erp/tickets/{{id}}|Voir le billet>',
    },
  },
]

function seedSystemFieldRules() {
  // Seed on first insert only — trigger_config/action_config/action_type are
  // user-tunable templates, so don't overwrite admin edits on subsequent boots.
  // Only identity/flag columns (name, description, kind, system) are re-synced
  // each time the seed definition changes upstream.
  const upsert = db.prepare(`
    INSERT INTO automations
      (id, name, description, kind, trigger_type, trigger_config, action_type, action_config, active, system, created_at, updated_at)
    VALUES (?, ?, ?, 'field_rule', 'field_rule', ?, ?, ?, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      kind = 'field_rule',
      trigger_type = 'field_rule',
      system = 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `)
  for (const r of SYSTEM_FIELD_RULES) {
    upsert.run(
      r.id, r.name, r.description,
      JSON.stringify(r.trigger_config),
      r.action_type,
      JSON.stringify(r.action_config),
    )
  }
  console.log(`✅ System field rules seeded (${SYSTEM_FIELD_RULES.length})`)
}

// Returns true if the system automation is enabled (active=1). Used by
// schedulers to short-circuit when a sysadmin has toggled the automation off.
export function isSystemAutomationActive(id) {
  const row = db.prepare('SELECT active FROM automations WHERE id = ? AND system = 1').get(id)
  return !!(row && row.active)
}

// Log one execution of a system automation. `key` is the automation id.
// `result` is a human-readable string (or object — will be JSON-stringified).
export function logSystemRun(key, { status, result, error, duration_ms, triggerData } = {}) {
  try {
    const exists = db.prepare('SELECT 1 FROM automations WHERE id = ? AND system = 1').get(key)
    if (!exists) return // skip silently if not seeded (e.g. fresh DB at boot)

    const logId = `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const resultStr = result == null ? null : (typeof result === 'string' ? result : JSON.stringify(result, null, 2))
    const errorStr = error == null ? null : (error instanceof Error ? error.message : String(error))
    const triggerDataStr = triggerData == null ? null : JSON.stringify(triggerData)

    db.prepare(`
      INSERT INTO automation_logs (id, automation_id, status, trigger_data, result, error, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(logId, key, status, triggerDataStr, resultStr, errorStr, duration_ms ?? null)

    db.prepare(`
      UPDATE automations SET last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_run_status = ? WHERE id = ?
    `).run(status, key)
  } catch (e) {
    console.error(`⚠️  logSystemRun(${key}) failed:`, e.message)
  }
}

// Log one execution of a declarative field-rule automation. Same shape as
// logSystemRun but scoped to kind='field_rule' rows (which may be system=0
// when created by admins via the UI).
export function logRuleRun(automationId, { status, result, error, duration_ms, triggerData } = {}) {
  try {
    const exists = db.prepare(
      "SELECT 1 FROM automations WHERE id = ? AND kind = 'field_rule'"
    ).get(automationId)
    if (!exists) return

    const logId = `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const resultStr = result == null ? null : (typeof result === 'string' ? result : JSON.stringify(result, null, 2))
    const errorStr = error == null ? null : (error instanceof Error ? error.message : String(error))
    const triggerDataStr = triggerData == null ? null : JSON.stringify(triggerData)

    db.prepare(`
      INSERT INTO automation_logs (id, automation_id, status, trigger_data, result, error, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(logId, automationId, status, triggerDataStr, resultStr, errorStr, duration_ms ?? null)

    db.prepare(
      "UPDATE automations SET last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_run_status = ? WHERE id = ?"
    ).run(status, automationId)
  } catch (e) {
    console.error(`⚠️  logRuleRun(${automationId}) failed:`, e.message)
  }
}
