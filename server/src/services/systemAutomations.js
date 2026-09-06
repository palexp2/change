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
  // Diagnostic de la connexion au Google Sheets CTB - Suivi : vérifie l'accès,
  // localise la section « Programmation des factures à payer » et rapporte la
  // prochaine ligne d'insertion. Jamais d'écriture (dry-run et run-now identiques).
  sys_ctb_programmation_paiement: async () => {
    const { diagnoseCtbSheet } = await import('./ctbSheet.js')
    return await diagnoseCtbSheet()
  },
  // Alerte trésorerie : dry-run = projection + diagnostic sans envoi ;
  // run-now = vérification réelle (envoie l'alerte Slack si sous le seuil).
  sys_treasury_alert: async ({ dryRun }) => {
    const { diagnoseTreasury, checkTreasuryAlert } = await import('./treasury.js')
    if (dryRun) return await diagnoseTreasury()
    return await checkTreasuryAlert({ force: true, trigger: 'manuel' })
  },
  // Sync du fichier « Maintien du solde disponible BNC » : dry-run = lecture du
  // Sheet + différences détectées sans rien écrire ; run-now = sync réelle
  // (le fichier fait foi, les ajustements sont appliqués).
  sys_treasury_solde_sheet: async ({ dryRun }) => {
    const { syncSoldeSheet } = await import('./treasurySoldeSheet.js')
    return await syncSoldeSheet({ trigger: 'manuel', apply: !dryRun })
  },
  // Reprise de l'onglet Pmt_Suivi (fichier CTB - Suivi) : dry-run = lignes qui
  // seraient ajoutées / mises à jour sans rien écrire ; run-now = import réel.
  sys_pmt_suivi_sheet: async ({ dryRun }) => {
    const { importPmtSuivi } = await import('./pmtSuiviImport.js')
    return await importPmtSuivi({ trigger: 'manuel', apply: !dryRun })
  },
  // Détection du « passé à la banque » via le grand livre QuickBooks : dry-run =
  // correspondances trouvées sans rien cocher ; run-now = cochage des
  // appariements sûrs, le reste reste à confirmer sur la page.
  sys_treasury_qb_clear: async ({ dryRun }) => {
    const { syncQbClear } = await import('./treasuryQbClear.js')
    return await syncQbClear({ trigger: 'manuel', apply: !dryRun })
  },
  // Sync du fichier TRX_Orisha (relevés des 11 comptes) : dry-run = lecture du
  // fichier + transactions qui seraient importées + audit d'anomalies, sans
  // écrire ; run-now = import réel + matching + liaison QB + alerte Slack.
  sys_digikey_orders: async ({ dryRun }) => {
    const { isDigikeyConfigured } = await import('../connectors/digikey.js')
    if (!isDigikeyConfigured()) {
      return { result: 'DigiKey non configuré (client_id / client_secret manquants dans Connecteurs)' }
    }
    const { syncDigikey } = await import('./digikey.js')
    const out = await syncDigikey({ trigger: 'manuel', dryRun })
    return {
      result: dryRun
        ? `${out.orders} commande(s) sur la fenêtre ${out.startDate} → ${out.endDate} · ${out.created} nouvelle(s), ${out.skipped} déjà connue(s) — rien écrit`
        : `${out.created} achat(s) créé(s), ${out.updated} mis à jour, ${out.pdfs} facture(s) PDF téléchargée(s)`
        + (out.errors.length ? ` · ${out.errors.length} erreur(s) : ${out.errors.slice(0, 2).join(' · ')}` : ''),
    }
  },

  sys_invoice_collection: async ({ dryRun }) => {
    const { refreshInvoiceNeeds, dueNeedsForAccount } = await import('./scrapers/invoiceNeeds.js')
    const { runAllScrapers } = await import('./scrapers/index.js')
    const counts = refreshInvoiceNeeds()
    if (dryRun) {
      // Simulation : on montre la liste de travail sans ouvrir un seul portail.
      const db = (await import('../db/database.js')).default
      const accounts = db.prepare(
        'SELECT id, label FROM scraper_accounts WHERE deleted_at IS NULL AND enabled=1'
      ).all()
      const perAccount = accounts.map(a => `${a.label} : ${dueNeedsForAccount(a.id).length} facture(s) à chercher`)
      return {
        result: [
          `${counts.withCollector} transaction(s) avec collecteur, ${counts.without} sans`,
          ...perAccount,
        ].join(' · '),
      }
    }
    const results = await runAllScrapers('manual')
    return {
      result: results.map(r => `${r.vendor}: ${r.status}${r.imported ? ` (${r.imported} importée(s))` : ''}`).join(' · ')
        || 'aucun compte de collecte actif',
    }
  },

  // Vérificateur d'adresses postales : dry-run = liste ce qui serait signalé
  // sans persister de verdict ni notifier ; run-now = passe complète.
  sys_address_check: async ({ dryRun }) => {
    const { runAddressCheck } = await import('./addressCheck.js')
    const out = runAddressCheck({ trigger: 'manuel', apply: !dryRun, log: false })
    return { summary: out.summary, counts: out.counts, problems: out.problems.slice(0, 50) }
  },

  // Corbeille : dry-run = ce qui partirait, sans rien détruire ; run-now =
  // suppression définitive immédiate (même si l'automation est en pause).
  // `log: false` — la route run-now journalise déjà l'exécution.
  sys_trash_auto_cleanup: async ({ dryRun }) => {
    const { runTrashAutoCleanup } = await import('./trash.js')
    const out = runTrashAutoCleanup({ dryRun: !!dryRun, trigger: 'manuel', force: true, log: false })
    // Pas de clé `details` : la route run-now la formate comme une liste
    // d'envois d'emails (`d.action.toUpperCase()`) et planterait dessus.
    return { summary: out.summary, retention_days: out.retention_days, tables: out.details, blocked: out.blocked_details }
  },

  // Vérificateur de prix des achats : dry-run = liste des prix suspects sans
  // persister de verdict ni notifier ; run-now = passe complète.
  sys_purchase_price_check: async ({ dryRun }) => {
    const { runPurchasePriceCheck } = await import('./purchasePriceCheck.js')
    const out = runPurchasePriceCheck({ trigger: 'manuel', apply: !dryRun, log: false })
    return { summary: out.summary, counts: out.counts, problems: out.problems.slice(0, 50) }
  },

  sys_bank_trx_sheet: async ({ dryRun }) => {
    const { syncTrxSheet } = await import('./bankTrxSheet.js')
    return await syncTrxSheet({ trigger: 'manuel', apply: !dryRun })
  },
  // Rattachement des sorties connues au relevé : dry-run et run-now font la
  // même chose (le rattachement n'écrit qu'un lien, jamais une écriture
  // comptable) — on lance le passage et on rend ce qui a été rattaché.
  sys_bank_debit_link: async () => {
    const { linkKnownDebits, summarizeLinks } = await import('./bankDebitLink.js')
    const out = await linkKnownDebits()
    return { ...out, summary: summarizeLinks(out) }
  },
  // Banque silencieuse : dry-run = état de chaque connexion sans notifier ;
  // run-now = vérifie et notifie tout de suite, sans attendre l'anti-spam.
  sys_plaid_silence_alert: async ({ dryRun }) => {
    const { checkPlaidSilence, getSilenceConfig, silenceVerdict, humanDuration } = await import('./plaidSilenceAlert.js')
    if (!dryRun) return await checkPlaidSilence({ force: true, trigger: 'manuel' })
    const { listItems, itemHealth } = await import('../connectors/plaid.js')
    const cfg = getSilenceConfig()
    const silenceHours = Number(cfg.silence_hours) || 36
    const rows = []
    for (const item of listItems()) {
      let health
      try { health = await itemHealth(item.itemId) } catch (e) { health = { institution_name: item.institution_name, health_error: e.message } }
      const v = silenceVerdict(health, { silenceHours })
      rows.push({ institution: health.institution_name, last_successful_update: health.last_successful_update || null,
        would_alert: !!v.alert, kind: v.kind || null, silence: v.hours != null ? humanDuration(v.hours) : null })
    }
    return { config: cfg, connections: rows,
      summary: rows.map((r) => `${r.institution} : ${r.would_alert ? `ALERTE (${r.kind === 'reauth' ? 'à réautoriser' : r.silence})` : `à jour${r.silence ? ` (${r.silence})` : ''}`}`).join(' · ') || 'aucune connexion' }
  },
  // Sync bancaire Plaid : dry-run = état de la connexion compte par compte
  // (fraîcheur, nombre de transactions, comptes mappés mais vides) ;
  // run-now = passage immédiat sur tous les items.
  sys_plaid_sync: async ({ dryRun }) => {
    const { scheduledPlaidSync, plaidSyncStatus } = await import('./plaidSync.js')
    if (dryRun) {
      const st = await plaidSyncStatus()
      const empty = st.accounts.filter((a) => a.empty).map((a) => a.account_name)
      const mute = st.items.filter((i) => i.last_successful_update && i.last_successful_update < new Date(Date.now() - 36 * 3600e3).toISOString())
      return {
        ...st,
        summary: st.accounts.map((a) => `${a.account_name}: ${a.plaid_count} trx${a.last_txn_date ? `, dernière ${a.last_txn_date}` : ''}`).join(' · ')
          + (empty.length ? ` — À RELIRE (mappés mais vides) : ${empty.join(', ')}` : '')
          + (mute.length ? ` — BANQUE MUETTE : ${mute.map((i) => `${i.institution} depuis le ${i.last_successful_update.slice(0, 10)}`).join(', ')}` : ''),
      }
    }
    const results = await scheduledPlaidSync()
    return { results, summary: results.map((r) => r.error ? `${r.institution || r.item_id}: échec (${r.error})` : `${r.institution || r.item_id}: ${r.inserted} nouvelle(s)`).join(' · ') || 'aucune connexion Plaid' }
  },
  // Revérification QuickBooks des comptes Plaid : dry-run n'existe pas vraiment
  // ici (la recherche ne modifie que qb_txn_id/statut, jamais les montants) —
  // on lance simplement le passage complet dans les deux cas.
  sys_plaid_qb_audit: async () => {
    const { scheduledPlaidQbAudit } = await import('./plaidQbAudit.js')
    const results = await scheduledPlaidQbAudit()
    return { summary: (results || []).map((r) => r.error ? `${r.account_name}: échec (${r.error})` : `${r.account_name}: ${r.linked} lié(s)/${r.scanned} vérifiée(s)`).join(' · ') || 'aucun compte Plaid mappé à QuickBooks', results }
  },
  // Rappel cartes : dry-run = prochaine date de rappel + aperçu du message ;
  // run-now = envoi immédiat du rappel Slack (ignore la date et l'idempotence).
  // Anomalies fiscales du mentor : dry-run = lignes du Sheet + profils qui
  // seraient mis à jour, sans écrire ; run-now = application aux profils.
  sys_fiscal_anomalies_sheet: async ({ dryRun }) => {
    const { syncFiscalAnomalies } = await import('./fiscalAnomaliesSheet.js')
    return await syncFiscalAnomalies({ trigger: 'manuel', apply: !dryRun })
  },
  // Alerte solde CARM : dry-run = calcul du solde + message qui partirait ;
  // run-now = vérification immédiate avec envoi (ignore l'anti-spam de 20 h).
  sys_carm_balance_alert: async ({ dryRun }) => {
    const { carmAccountState, carmAlertText, checkCarmBalanceAlert } = await import('./carmAccount.js')
    if (dryRun) {
      const state = carmAccountState()
      return { state, would_alert: state.low, message: state.low ? carmAlertText(state) : null }
    }
    return await checkCarmBalanceAlert({ force: true, trigger: 'manuel' })
  },
  sys_card_payment_reminder: async ({ dryRun }) => {
    const { diagnoseCardPaymentReminder, checkCardPaymentReminder } = await import('./cardPaymentReminder.js')
    if (dryRun) return diagnoseCardPaymentReminder()
    return await checkCardPaymentReminder({ force: true, trigger: 'manuel' })
  },
  // Plafond des cartes : dry-run = les chiffres lus dans QuickBooks + ce qui
  // partirait sur Slack, sans envoi ; run-now = envoie l'alerte immédiatement
  // (en court-circuitant la fenêtre J-N et l'anti-doublon du mois).
  sys_card_ceiling_alert: async ({ dryRun }) => {
    const { diagnoseCardCeilings, checkCardCeilings } = await import('./cardCeiling.js')
    if (dryRun) return await diagnoseCardCeilings()
    return await checkCardCeilings({ force: true, trigger: 'manuel' })
  },
  // Déboursés de pièces : dry-run = les trois montants du mois écoulé, calculés
  // depuis QuickBooks, sans fichier ni notification ; run-now = préparation
  // complète (calcul + dépôt du Google Sheet + notification à valider).
  // Aucun des deux n'envoie le message à Guillaume — cet envoi reste un bouton
  // de la page « Écritures de fin de mois », après validation du montant.
  sys_pieces_disbursements: async ({ dryRun }) => {
    const { preparePiecesMonth } = await import('./piecesDisbursements.js')
    return await preparePiecesMonth({ trigger: 'manuel', dryRun })
  },
  // Suggestions de travaux : dry-run = le contexte qui serait soumis au modèle
  // (sans appel) ; run-now = passage complet, les nouvelles suggestions
  // apparaissent dans /travaux.
  sys_work_suggestions: async ({ dryRun }) => {
    const { buildContextDigest, buildIntegrationDigest, runSuggestionEngines } = await import('./workSuggestions.js')
    if (dryRun) {
      const d = buildContextDigest()
      const i = buildIntegrationDigest()
      return {
        travaux_recurrents: d.recurring.split('\n').filter(Boolean).length,
        prompts_recents: d.recentPrompts.split('\n').filter(Boolean).length,
        suggestions_connues: d.known.split('\n').filter(Boolean).length,
        erreurs_sync: d.syncErrors ? d.syncErrors.split('\n').length : 0,
        outils_deja_branches: i.oauth.split('\n').filter(Boolean).length + i.envTools.split('\n').filter(Boolean).length,
        integrations_deja_proposees: i.known.split('\n').filter(Boolean).length,
      }
    }
    return await runSuggestionEngines()
  },
  // Répartition de la paie : diagnostic = aperçu de l'écriture de la dernière
  // paie, sans publication (la publication se fait depuis la page Paie).
  // Fin de mois : le dry-run recalcule les provisions du mois écoulé sans
  // importer les heures ni notifier.
  sys_month_end_provisions: async ({ dryRun }) => {
    const { prepareMonthEnd } = await import('./monthEndAutomation.js')
    return await prepareMonthEnd({ dryRun: !!dryRun, trigger: 'manuel' })
  },
  // Budget marketing : dry-run = rien n'est écrit, on rapporte l'état de la
  // file ; run-now = sync GL immédiate (les nouvelles dépenses arrivent « à
  // valider » dans la page Budget marketing).
  sys_marketing_expense_sync: async ({ dryRun }) => {
    const { syncMarketingExpenses, pendingCount, getMarketingSyncConfig } = await import('./marketingBudget.js')
    if (dryRun) {
      const cfg = getMarketingSyncConfig()
      return {
        summary: `Comptes suivis : ${cfg.accounts} · depuis le ${cfg.start_date} · ${pendingCount()} dépense(s) en attente de validation`,
      }
    }
    return await syncMarketingExpenses({ trigger: 'manuel', force: true })
  },
  // Message hebdo à Émilie : dry-run = aperçu du message sans envoi ;
  // run-now = envoi immédiat (ignore le jour et l'idempotence hebdomadaire).
  sys_marketing_weekly_slack: async ({ dryRun }) => {
    const { previewWeeklyMarketingSlack, checkWeeklyMarketingSlack } = await import('./marketingBudget.js')
    if (dryRun) return previewWeeklyMarketingSlack()
    return await checkWeeklyMarketingSlack({ force: true, trigger: 'manuel' })
  },
  // Intake ManyChat : diagnostic seulement. Pas de run-now — on ne fabrique pas
  // un faux prospect, et le déclencheur réel est un appel HTTP de ManyChat.
  sys_instagram_prospect_intake: async () => {
    const { previewIntake } = await import('./instagramProspects.js')
    return previewIntake()
  },
  // Liste hebdo à Philippe : dry-run = aperçu du message sans envoi ni marquage ;
  // run-now = envoi immédiat (ignore jour, heure et idempotence hebdomadaire).
  // Lecture des commentaires Instagram : dry-run = état de la configuration
  // (aucun appel à Instagram) ; run-now = tournée immédiate (ignore jour/heure).
  sys_instagram_comment_scrape: async ({ dryRun }) => {
    const { previewCommentScrape, runCommentScrape } = await import('./instagramCommentScrape.js')
    if (dryRun) return previewCommentScrape()
    return await runCommentScrape({ force: true, trigger: 'manuel' })
  },
  sys_instagram_weekly_slack: async ({ dryRun }) => {
    const { previewWeeklyProspectDigest, runWeeklyProspectDigest } = await import('./instagramProspects.js')
    if (dryRun) return previewWeeklyProspectDigest()
    return await runWeeklyProspectDigest({ force: true, trigger: 'manuel' })
  },
  sys_paie_repartition: async () => {
    const { computePaieRepartition } = await import('./paieRepartition.js')
    const last = db.prepare('SELECT id, number FROM paies ORDER BY period_end DESC LIMIT 1').get()
    if (!last) return { summary: 'Aucune paie en base' }
    const p = computePaieRepartition(last.id)
    const linesTxt = p.lines.map(l => `${l.type === 'Debit' ? 'Dt' : 'Ct'} ${l.acctnum} ${l.amount.toFixed(2)} $ (${l.label})`).join(' · ')
    return {
      summary: `Paie #${last.number ?? '?'} — total ${p.total.toFixed(2)} $, remb. ${p.reimb.toFixed(2)} $, base ${p.base.toFixed(2)} $ → ${linesTxt}` +
        (p.warnings.length ? ` · ⚠️ ${p.warnings.join(' / ')}` : '') +
        (p.paie.repartition_je_id ? ` · Déjà publiée (JE ${p.paie.repartition_je_id})` : ''),
    }
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
    name: 'Sync Gmail (3 min)',
    description:
      "Synchronise toutes les boîtes Gmail connectées (via OAuth) : récupère les nouveaux messages, " +
      "les associe aux contacts/entreprises, crée des interactions + emails. " +
      "Ingère comme factures fournisseurs (sale_receipts + extraction IA) tout message portant le label ERP/Factures " +
      "OU adressé/livré à factures@orisha.io — aucun label requis ; dédup inter-boîtes par Message-ID RFC822. " +
      "Le répertoire fournisseurs (profils /fournisseurs) est injecté dans le prompt d'extraction. " +
      "Démarre 30s après le boot puis s'exécute toutes les 3 minutes ; une passe encore en cours " +
      "absorbe l'appel suivant (verrou côté service) plutôt que d'en lancer une seconde. " +
      "Un passage sans rien à importer avance la date de dernière exécution sans écrire de journal : " +
      "l'historique ci-dessous ne garde que les passages qui ont importé quelque chose ou échoué. " +
      "Le rematch des appels orphelins, qui tournait dans cette passe, a son propre battement horaire.",
    trigger_config: {
      kind: 'schedule',
      source: 'index.js:scheduleGmailSync',
      cron: '*/3 * * * * (interval 3 min)',
      summary: 'Scheduler interne — toutes les 3 minutes',
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
    name: 'Comptabilisation QB des Stripe payouts (quotidienne)',
    description:
      "Deux passages par jour (8h et 18h, heure de Montréal) : pull incrémental des nouveaux Stripe payouts, sync des balance_transactions manquantes, " +
      "puis push automatique du Deposit QuickBooks de chaque payout réglé (status='paid') pas encore poussé — " +
      "CAD vers « Compte chèques Banque Nationale », USD vers « Venn USD ». " +
      "PÉRIMÈTRE : seuls les payouts arrivés depuis push_since sont poussés — l'historique antérieur est déjà comptabilisé autrement et ne part jamais vers QB. " +
      "Au plus max_batch payouts par passage (cap de sécurité — l'excédent est reporté au passage suivant et signalé). " +
      "GARDE ANTI-ERREUR : avant chaque push, le Deposit est construit en dry build et inspecté — tout payout générant un warning " +
      "(client QB non résolu, taxe sur frais non imputée, TaxCode manquant…) est laissé en attente de revue manuelle, jamais poussé à l'aveugle, et retenté au passage suivant. " +
      "Idempotent : un payout déjà lié à un Deposit (qb_deposit_id) est ignoré. " +
      "VISIBILITÉ : un résumé Slack part seulement quand quelque chose COINCE — payout bloqué par une garde, erreur, ou payout réglé depuis plus de stale_alert_days jours toujours sans Deposit (relancé quotidiennement). " +
      "Un passage qui n'a fait que pousser des dépôts sans anicroche est silencieux pour ne pas encombrer le canal comptabilité (slack_on_success=1 pour recevoir le résumé de chaque passage). Jamais d'échec silencieux : tout reste dans le journal ci-dessous. " +
      "Exécutable en dry-run (preview complète, aucun Deposit créé, aucun Slack) ou run-now depuis cette page.",
    trigger_config: {
      kind: 'schedule',
      source: 'index.js cron 0 12,22 * * * UTC → syncAndPushStripePayouts',
      cron: '0 12,22 * * * UTC (8h et 18h à Montréal, tous les jours)',
      summary: 'Scheduler interne — deux fois par jour (8h et 18h, Montréal)',
    },
    action_config: {
      push_since: '2026-04-21',
      max_batch: '8',
      stale_alert_days: '3',
      slack_on_success: '0',
      slack_webhook_env: 'SLACK_WEBHOOK_TREASURY',
    },
    configurable: true,
    default_active: 0,
  },
  {
    id: 'sys_ctb_programmation_paiement',
    name: 'CTB - Suivi : programmation des factures à payer (Google Sheets)',
    description:
      "Quand une facture à payer est ajoutée dans l'ERP — reçu publié sur QuickBooks en type « Facture (Bill) », achat fournisseur de type facture créé à la main ou publié sur QB — une ligne est ajoutée dans la section « PROGRAMMATION DES FACTURES À PAYER » de l'onglet Sommaire du Google Sheets « CTB - Suivi » : Fournisseur | $ | Dû le | Programmation du paiement. " +
      "La programmation du paiement = le jour de paiement hebdomadaire (mardi par défaut) qui précède la date d'échéance ; si ce mardi est déjà passé, le prochain mardi à venir. Sans date d'échéance, « - » est inscrit. " +
      "Dédup : une ligne déjà présente pour le même fournisseur et la même échéance n'est pas ré-ajoutée. " +
      "Quand une facture fournisseur passe au statut « Payée » dans l'ERP, elle est aussi inscrite dans la section « FACTURES PAYÉES CETTE SEMAINE » (Fournisseur | $ | Déboursé le) et sa ligne est retirée de la Programmation. " +
      "Le spreadsheet, l'onglet, le jour de paiement et le compte Google utilisés sont configurables ci-dessous. " +
      "Le bouton « Exécuter » fait un diagnostic sans écriture (accès au fichier + localisation des sections). " +
      "Prérequis : API Google Sheets activée dans le projet Cloud, et compte Google reconnecté depuis la page Connecteurs (scope Sheets ajouté).",
    trigger_config: {
      kind: 'app_event',
      source: 'quickbooks.js pushSaleReceiptToQB(bill) · pushAchatToQB(bill) · POST /achats-fournisseurs (bill) · PUT/PATCH achat → statut Payée',
      summary: "Déclenché à l'ajout d'une facture à payer (publication Bill QB ou création manuelle) et au passage d'une facture au statut « Payée »",
    },
    action_config: {
      spreadsheet_id: '13rd8x_xy5AQJemDwE6yWp8ffvkj3bEo7kq3cuogRGyQ',
      sheet_name: 'Sommaire',
      section_header: 'PROGRAMMATION DES FACTURES À PAYER',
      paid_section_header: 'FACTURES PAYÉES CETTE SEMAINE',
      payment_weekday: '2',
      google_account_email: 'pap@orisha.io',
    },
    configurable: true,
  },
  {
    id: 'sys_treasury_alert',
    name: 'Trésorerie BNC : alerte solde projeté sous le seuil',
    description:
      "Chaque matin (7h30) et à chaque saisie du solde disponible réel (page Trésorerie), projette le solde du compte BNC CAD sur l'horizon configuré : " +
      "solde saisi + payouts Stripe à venir − factures fournisseurs CAD programmées (jour de paiement hebdomadaire avant l'échéance) − sorties récurrentes (paie, loyer, dettes…). " +
      "Si le point bas projeté passe sous le seuil, l'état est loggé et affiché sur la page Trésorerie. " +
      "SLACK NE PARLE QUE POUR UN DÉCOUVERT IMMINENT : solde projeté NÉGATIF d'ici slack_negative_days jours (défaut 3). " +
      "Un point bas simplement sous le seuil de confort, ou un découvert plus lointain, restent en « VEILLE » — visibles ici et sur la page Trésorerie, jamais dans le canal comptabilité (le canal doit rester quasi silencieux). " +
      "Mettre slack_negative_only à 0 pour revenir au comportement historique (seuil franchi d'ici slack_urgent_days jours). " +
      "L'alerte porte le virement suggéré selon la procédure : virer via le compte VENN CAD (convertir des USD au besoin en gardant un minimum de 15 000 USD), virement Interac de préférence. " +
      "Anti-spam : au plus une alerte par 20 h. Sont loggés SANS Slack : le rappel « solde non noté depuis plus de balance_stale_days jours » (stale_reminder_slack à 1 pour le réactiver) " +
      "et l'écart de réconciliation solde réel vs projeté au-delà de variance_tolerance (variance_slack à 1 pour le réactiver). " +
      "Le bouton « Simuler » affiche la projection sans rien envoyer.",
    trigger_config: {
      kind: 'schedule',
      source: 'cron 30 7 * * * (index.js) + POST /api/treasury/balance',
      summary: 'Vérification quotidienne à 7h30 et à chaque saisie de solde',
    },
    action_config: {
      threshold: '5000',
      horizon_days: '42',
      balance_stale_days: '7',
      slack_negative_only: '1',
      slack_negative_days: '3',
      slack_urgent_days: '2',
      stale_reminder_slack: '0',
      variance_slack: '0',
      slack_webhook_env: 'SLACK_WEBHOOK_TREASURY',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_pmt_suivi_sheet',
    name: 'Paiements émis : reprise de l\'onglet Pmt_Suivi (fichier CTB - Suivi)',
    description:
      "Toutes les 30 minutes (et sur demande via le bouton « Synchroniser la feuille » de la page Paiements émis), relit l'onglet « Pmt_Suivi » du Google Sheet « CTB - Suivi » — le suivi manuel des virements, chèques et paiements de carte — et reprend dans l'ERP les paiements ajoutés au fichier. " +
      "La couleur VERTE de la colonne « Montant » vaut « passé à la banque » : une ligne qui passe au vert dans le fichier coche le paiement correspondant ici. " +
      "IDEMPOTENT : chaque ligne a une clé naturelle (date + libellé + montant + référence + rang d'occurrence), donc relancer la sync met à jour au lieu de doubler ; les paiements SAISIS dans l'ERP (sans clé d'import) ne sont jamais touchés. " +
      "Un paiement importé est relié à la facture fournisseur qu'il règle quand c'est sans ambiguïté (même fournisseur, montant exact) — sans ce lien, la facture resterait projetée à son échéance EN PLUS du paiement. " +
      "Chaque passage enchaîne ensuite l'appariement au relevé bancaire importé (compte BNC CAD). " +
      "since_date est le plancher d'import (l'historique antérieur est déjà en base) ; google_account_email vide = le compte Google connecté le plus récemment. " +
      "Lecture par export Drive (xlsx, couleurs incluses) : le compte Google configuré doit avoir accès au fichier. " +
      "Le bouton « Simuler » compte ce qui serait ajouté / mis à jour sans rien écrire ; « Exécuter » lance l'import immédiatement.",
    trigger_config: {
      kind: 'schedule',
      source: 'setInterval 30 min (index.js) → services/pmtSuiviImport.js + POST /api/treasury/payments/import-sheet',
      summary: 'Sync automatique toutes les 30 min + bouton « Synchroniser la feuille » de la page Paiements émis',
    },
    action_config: {
      file_id: '13rd8x_xy5AQJemDwE6yWp8ffvkj3bEo7kq3cuogRGyQ',
      sheet_name: 'Pmt_Suivi',
      google_account_email: '',
      since_date: '2026-01-01',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_treasury_qb_clear',
    name: 'Paiements émis : détection du « passé à la banque » via QuickBooks',
    description:
      "Toutes les heures (et sur demande depuis le bouton « Synchroniser avec QuickBooks » de la page Paiements émis), lit le grand livre QuickBooks du compte bancaire projeté et coche « passé à la banque » les paiements émis dont l'argent est réellement sorti. " +
      "SIGNAL : le rapport GeneralLedger expose par écriture un marqueur de compensation — « C » = appariée au flux bancaire (le mouvement EST au compte), « R » = en plus validée dans un rapprochement, VIDE = saisie dans QuickBooks mais jamais vue à la banque (chèque non encaissé, paiement post-daté). Seules les écritures « C » et « R » comptent : « l'écriture existe dans QuickBooks » ne prouve rien, elle existe dès la saisie. " +
      "PRUDENCE : cocher à tort retire une sortie de la projection et masque un découvert. Un appariement n'est appliqué automatiquement que si le NOM du tiers chez QuickBooks concorde avec le fournisseur (ou le bénéficiaire) du paiement — le montant seul ne suffit pas, deux fournisseurs facturent le même 103,48 $ — ou, pour un virement interne (que QuickBooks ne nomme pas), si le montant concorde au cent près à moins de 2 jours d'écart. Tout le reste, ainsi que les factures fournisseurs encore « à payer » dans l'ERP alors que QuickBooks a une écriture compensée à ce fournisseur, est PROPOSÉ sur la page pour confirmation d'un clic — jamais appliqué tout seul. " +
      "auto_apply=0 désactive le cochage automatique : tout passe alors par la confirmation manuelle. Le bouton « Simuler » liste les correspondances sans rien écrire.",
    trigger_config: {
      kind: 'schedule',
      source: 'setInterval 60 min (index.js) → services/treasuryQbClear.js + POST /api/treasury/payments/qb-clear',
      summary: 'Sync horaire + bouton « Synchroniser avec QuickBooks » de la page Paiements émis',
    },
    action_config: {
      account_name: 'BNC CAD',
      day_window: '6',
      lookback_days: '75',
      auto_apply: '1',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_treasury_solde_sheet',
    name: 'Trésorerie BNC : sync du fichier « Maintien du solde disponible » (Google Sheet)',
    description:
      "Toutes les 60 minutes, à l'heure pile (et sur demande depuis la page Comptabilité), lit l'onglet « Compte chèque » du Google Sheet « Maintien du solde disponible BNC » — que l'utilisateur continue de tenir à la main — et le compare à la projection de trésorerie de l'ERP. LE FICHIER FAIT FOI : " +
      "1) le solde disponible réel du fichier, s'il est plus récent ou différent de la dernière saisie ERP, devient une nouvelle saisie de solde (avec la même réconciliation prévu/réel et la même vérification d'alerte qu'une saisie manuelle) ; " +
      "2) un paiement planifié du fichier que l'ERP ne projette pas déjà (ni facture fournisseur à son échéance, ni sortie récurrente, ni paiement émis) est ajouté comme paiement projeté — idempotent, une ligne retirée du fichier est retirée de la projection ; " +
      "3) le bloc « Sorties récurrentes » ajuste les montants et jours des récurrentes mensuelles de l'ERP et crée celles qui manquent. " +
      "Ce qui ne peut pas être ajusté sans risque de double compte (ligne déjà couverte, récurrente non mensuelle, montant « voir le relevé ») est rapporté dans le journal ci-dessous et sur la page Comptabilité — sans alerte Slack (slack_anomalies=0 ; mettre à 1 pour notifier les anomalies de lecture nouvelles). " +
      "Le bouton « Simuler » liste les différences sans rien écrire ; « Exécuter » applique la sync immédiatement. " +
      "Lecture par export Drive (xlsx) : le compte Google configuré doit avoir accès au fichier.",
    trigger_config: {
      kind: 'schedule',
      source: "cron '0 * * * *' (index.js) → services/treasurySoldeSheet.js + POST /api/treasury/solde-sheet/sync",
      summary: 'Sync toutes les 60 min (à l\'heure pile) + bouton « Synchroniser » de la page Comptabilité',
    },
    action_config: {
      spreadsheet_id: '1ETlbHIcwClZTiskwQh8PWYuDxZGwqJBKU-0p2iWoxgo',
      sheet_name: 'Compte chèque',
      google_account_email: 'pap@orisha.io',
      match_window_days: '10',
      slack_anomalies: '0',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_carm_balance_alert',
    name: 'Douanes ASFC : alerte de solde bas du compte CARM',
    description:
      "Chaque matin (8h) et après chaque import de relevé, calcule le solde du compte CARM de l'ASFC — solde d'ouverture saisi + paiements − évaluations, intérêts et pénalités du relevé importé — et alerte sur Slack quand il passe sous le seuil configuré. " +
      "MODÈLE COMPTABLE : le compte ASFC est le solde du fournisseur ASFC dans les Comptes fournisseurs (ap_acctnum) — aucun compte de passage à créer. Notre versement est une dépense sur la carte (card_acctnum) imputée à ce compte fournisseur, sans taxe ; l'évaluation B3 devient une facture fournisseur ventilée en droits de douane (duty_acctnum) et en TPS à l'importation, 100 % récupérable en CTI ; les intérêts vont dans interest_acctnum et les pénalités dans penalty_acctnum, hors champ de taxe. Une ligne réglée par un courtier (broker_names : FedEx, UPS, Axxess paient l'ASFC puis nous refacturent) n'est JAMAIS comptabilisée ici — sa dépense et sa TPS arrivent par la facture du courtier — et le dépôt de garantie de 597 $ est ignoré, déjà dans les livres. " +
      "opening_balance / opening_date fixent le point de départ : le relevé du portail ne contient que l'activité, sans lui le solde n'est qu'une variation. " +
      "Anti-spam : au plus une alerte par 20 h. Le bouton « Simuler » calcule le solde et affiche le message sans rien envoyer.",
    trigger_config: {
      kind: 'schedule',
      source: 'cron 0 8 * * * (index.js) + POST /api/carm/import',
      summary: 'Vérification quotidienne à 8h et à chaque import de relevé',
    },
    action_config: {
      opening_balance: '0',
      opening_date: '',
      threshold: '50',
      ap_acctnum: '21000',
      duty_acctnum: '65000',
      interest_acctnum: '79200',
      penalty_acctnum: '70100',
      card_acctnum: '22000',
      bank_acctnum: '10000',
      vendor_name: 'ASFC',
      gst_tax_code_name: 'TPS',
      notax_tax_code_name: 'Hors champ',
      post_since: '',
      max_batch: '50',
      delta_tolerance: '0.02',
      broker_names: 'Federal Express Canada, United Parcells, AXXESS INTERNAtional',
      slack_webhook_env: 'SLACK_WEBHOOK_TREASURY',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_fiscal_anomalies_sheet',
    name: 'Statut fiscal : sync des anomalies TPS/TVQ du mentor vers les profils fournisseurs',
    description:
      "Deux fois par jour, lit l'onglet « Fournisseurs_TPS_TVQ_Anomalies » du Google Sheet « Sommaire_Statut fiscal des taxes » — le journal de corrections tenu par le mentor comptable (date, compte, fournisseur, montant, ce qui a été fait, ce qui aurait dû être fait, explication) — et applique chaque correction NOUVELLE au profil du fournisseur concerné : code de taxe QuickBooks par devise (Détaxé / Exonéré / Hors champ) et, quand l'explication le permet (« business to business », « transport de marchandises », « produit alimentaire »…), type de transaction. " +
      "Les prochaines factures du même fournisseur partent donc du bon statut fiscal, sans report manuel. " +
      "Prudence : une correction « Taxable » n'est jamais appliquée (le code dépend des taxes réellement facturées) ; deux lignes contradictoires pour le même fournisseur et la même devise (ex. Amazon : café détaxé vs remboursement taxable) bloquent la mise à jour et sont rapportées ; une ligne déjà traitée n'est jamais rejouée, donc une modification faite ensuite dans /fournisseurs ne peut pas être réécrasée. " +
      "Le bouton « Simuler » liste ce qui serait changé sans rien écrire ; « Exécuter » applique immédiatement. Lecture par export Drive (xlsx) : le compte Google configuré doit avoir accès au fichier.",
    trigger_config: {
      kind: 'schedule',
      source: 'setInterval 12 h (index.js) → services/fiscalAnomaliesSheet.js',
      summary: 'Sync 2×/jour de l\'onglet des anomalies fiscales',
    },
    action_config: {
      spreadsheet_id: '1ZJafa3fuuQwfuROyLfWlLPzg99k8jLqlv9jnNao8Ed0',
      sheet_name: 'Fournisseurs_TPS_TVQ_Anomalies',
      google_account_email: 'pap@orisha.io',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_digikey_orders',
    name: 'DigiKey : commandes et factures rapatriées par l\u2019API',
    description:
      "Chaque jour à 6 h (heure de Montréal), interroge l\u2019API DigiKey (historique des commandes puis détail de chacune) sur les lookback_days derniers jours et, pour chaque commande facturée, crée une facture fournisseur DigiKey EN BROUILLON dans Fournisseurs → Achats, avec ses lignes d\u2019articles, ses taxes et son total. " +
      "Le PDF de la facture est téléchargé et attaché à l\u2019achat (visible dans sa fiche). " +
      "RIEN N\u2019EST PUBLIÉ DANS QUICKBOOKS : le brouillon attend une relecture et un clic sur « Publier vers QuickBooks ». Un achat déjà publié n\u2019est jamais réécrit par une tournée suivante. " +
      "La déduplication porte sur le numéro de facture DigiKey (à défaut le numéro de commande) : relancer la sync ne crée pas de doublon, et une facture déjà saisie autrement (courriel, collecte de portail, import QuickBooks) est reconnue au lieu d\u2019être dupliquée. " +
      "Sens unique DigiKey → ERP : rien n\u2019est jamais écrit chez DigiKey. " +
      "Les identifiants OAuth (client_id / client_secret du plan développeur DigiKey) se saisissent dans Connecteurs → DigiKey ; tant qu\u2019ils manquent, la tournée ne fait rien. " +
      "Le bouton « Simuler » liste ce qui serait importé sans rien écrire ni télécharger.",
    trigger_config: {
      kind: 'schedule',
      source: "cron '0 10 * * *' (index.js) → services/digikey.js syncDigikey()",
      summary: 'Tournée quotidienne à 10 h UTC (6 h à Montréal) + bouton « Importer les commandes » de Connecteurs → DigiKey',
    },
    action_config: {
      lookback_days: '30',
      vendor_name: 'DigiKey',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_invoice_collection',
    name: 'Collecte des factures fournisseurs sur leurs portails',
    description:
      "Chaque nuit à 5 h (heure de Montréal), pour chaque compte de la page « Collecte de factures » : part des transactions bancaires NON COMPTABILISÉES (statut « à traiter » ou « facture reçue », sans document lié), reconnaît le fournisseur dans le libellé du relevé, se connecte à son portail et ne télécharge QUE les factures dont le montant correspond. " +
      "La facture descend dans l'extracteur de données comme n'importe quel reçu, puis la transaction bancaire lui est liée automatiquement — elle passe alors à « facture reçue ». " +
      "LA PUBLICATION QUICKBOOKS RESTE MANUELLE : rien n'entre dans les livres sans un clic depuis la fiche du reçu. " +
      "La concordance est exacte au cent près ; un écart jusqu'à match_tolerance_pct est accepté seulement s'il n'y a qu'une seule facture dans cette marge (conversion de devise, frais bancaires). Deux candidates au même montant → rien n'est téléchargé, la transaction est marquée « ambiguë ». " +
      "Le montant qui fait foi pour lier est celui EXTRAIT DU PDF, pas celui annoncé par le portail. " +
      "Une facture introuvable est retentée à 1, 3 puis 7 jours (un fournisseur publie parfois plusieurs jours après avoir débité), puis abandonnée. " +
      "needs_lookback_days est la profondeur d'historique balayée dans le relevé. " +
      "Le bouton « Simuler » liste les besoins et les concordances sans se connecter à aucun portail ni rien télécharger.",
    trigger_config: {
      kind: 'schedule',
      source: "cron '0 9 * * *' (index.js) → services/scrapers/index.js runAllScrapers()",
      summary: 'Tournée quotidienne à 9 h UTC (5 h à Montréal) + bouton « Collecter » de la page Collecte de factures',
    },
    action_config: {
      needs_lookback_days: '120',
      match_tolerance_pct: '2',
      retry_delays_days: '1,3,7',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_bank_trx_sheet',
    name: 'Rapprochement bancaire : sync du fichier TRX_Orisha (Drive)',
    description:
      "Toutes les 20 minutes (et sur demande depuis la page Rapprochement bancaire), lit le fichier TRX_Orisha.xlsx du Drive — un onglet par compte bancaire, où l'utilisateur colle les relevés de ses 11 comptes — et importe les transactions nouvelles dans le rapprochement de l'ERP (mêmes lignes que l'import par collage). " +
      "Chaque compte passe ensuite au matching automatique (achats, reçus, payouts Stripe) et à la liaison QuickBooks (grand livre, montant + date). " +
      "Puis un AUDIT croise le relevé et le grand livre QB sur la fenêtre audit_window_days : transaction au relevé sans écriture QB, écriture QB jamais passée au relevé, ligne « à traiter » plus vieille que anomaly_age_days — chaque anomalie est accompagnée d'une explication probable " +
      "(décalage de date, écart de montant ≈ frais bancaires ou conversion, doublon possible dans QB, facture manquante). " +
      "AUCUNE ALERTE SLACK n'est envoyée (slack_anomalies=0, demande de l'utilisateur) : les anomalies vivent uniquement sur la page Rapprochement bancaire et dans le journal ci-dessous. Mettre slack_anomalies à 1 pour retrouver l'alerte des anomalies nouvelles dans le canal slack_webhook_env. " +
      "La déduplication est tolérante (date + montant signé) : recoller un relevé dans le fichier ou relancer la sync ne double jamais une transaction, et une transaction supprimée à la main dans l'ERP ne ressuscite pas. " +
      "since_date est le plancher d'import (l'historique antérieur est déjà en base) ; overlap_days est la fenêtre re-scannée avant la dernière transaction connue de chaque compte. " +
      "Le bouton « Simuler » liste ce qui serait importé et les anomalies sans rien écrire ni alerter.",
    trigger_config: {
      kind: 'schedule',
      source: 'setInterval 20 min (index.js) → services/bankTrxSheet.js + POST /api/bank/trx-sheet/sync',
      summary: 'Sync aux 20 minutes + bouton « Synchroniser » de la page Rapprochement bancaire',
    },
    action_config: {
      file_id: '1fRE0c1zv5zks70pwzgpojB7LZz-V5lHR',
      google_account_email: 'michel@orisha.io',
      since_date: '2026-07-01',
      overlap_days: '7',
      anomaly_age_days: '7',
      audit_window_days: '45',
      audit_grace_days: '4',
      slack_anomalies: '0',
      slack_webhook_env: 'SLACK_WEBHOOK_TREASURY',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_bank_debit_link',
    name: 'Comptabilité : reconnaître au relevé les sorties déjà connues',
    description:
      "À chaque arrivée de transactions bancaires, rapproche du relevé les sorties d'argent que l'ERP attendait déjà : le débit de la paie (libellé Nethris, 2 à 4 jours après la fin de période) et les versements des dettes à long terme (BDC, Ville de Québec, DEC). " +
      "La paie rattachée s'ouvre avec son montant et sa date déjà remplis dans « Comptabilisation de la paie » — le montant passé au compte BNC ne se recopie plus du relevé à la main. " +
      "AUCUNE écriture n'est publiée dans QuickBooks par ce passage : publier reste un geste humain, au clic. " +
      "Un versement de dette rattaché affiche « passé à la banque » sur la page Dettes à long terme, ce qui distingue enfin « l'écriture existe dans QuickBooks » de « l'argent est sorti ». " +
      "Rien n'est deviné : sans libellé configuré, sans candidat unique, ou sur un montant qui s'écarte de plus de 2 % de l'attendu, la transaction reste à traiter plutôt que d'être mal rattachée. " +
      "Les libellés se règlent sur l'automation « Répartition de la paie » (paie, assurance collective) et sur la fiche de chaque dette.",
    trigger_config: {
      kind: 'event',
      source: 'services/bankReconciliation.js:runPostImportHooks (collage, TRX_Orisha, Plaid)',
      summary: "À chaque arrivée de transactions bancaires, quelle qu'en soit la source",
    },
    action_config: {},
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_plaid_silence_alert',
    name: 'Alerte : une banque ne livre plus rien',
    description:
      "Vérifie trois fois par jour depuis quand chaque banque connectée a livré des transactions pour la dernière fois, et prévient dans Boréal (cloche de notification, plus Slack si un canal est configuré) quand une connexion se tait depuis plus longtemps que le seuil. " +
      "POURQUOI : une connexion bancaire ne tombe pas en panne bruyamment, elle se tait. Du 2 au 6 septembre 2026, la BNC n'a plus rien livré pendant quatre jours sans la moindre erreur — le rapprochement, le solde de la projection de trésorerie et la recherche du débit de la paie travaillaient sur des données figées sans que rien ne le signale. " +
      "Le chiffre surveillé est celui de Plaid (« dernière livraison réussie »), pas notre propre dernière tentative : demander sans rien recevoir n'est pas une connexion en santé. " +
      "Une autorisation expirée (la banque redemande de se connecter) est signalée à part et en priorité : elle ne se répare jamais toute seule. " +
      "Le seuil par défaut est de 36 heures, ce qui laisse passer une fin de semaine creuse. Une même connexion n'est pas re-signalée avant 24 heures. " +
      "Le journal reste silencieux quand tout va bien. « Simuler » montre l'état de chaque connexion sans notifier ; « Exécuter » vérifie et notifie immédiatement.",
    trigger_config: {
      kind: 'schedule',
      source: "cron '0 11,17,23 * * *' UTC (index.js) → services/plaidSilenceAlert.js",
      cron: '0 11,17,23 * * * UTC (7 h, 13 h et 19 h à Montréal)',
      summary: 'Trois vérifications par jour ; alerte au-delà du seuil de silence',
    },
    action_config: {
      silence_hours: '36',
      repeat_hours: '24',
      notify_roles: 'admin',
      slack_webhook_env: 'SLACK_WEBHOOK_TREASURY',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_plaid_sync',
    name: 'Connexion bancaire : lecture des transactions et du solde (Plaid)',
    description:
      "Toutes les 30 minutes, relit auprès de Plaid les nouvelles transactions de chaque institution connectée (BNC, Desjardins) et les verse dans le rapprochement bancaire, puis note le solde du compte BNC CAD utilisé par la projection de trésorerie. " +
      "Plaid prévient normalement l'ERP tout de suite (webhook) — ce passage est le FILET : un webhook perdu, une signature refusée ou une coupure réseau et les transactions cessaient d'arriver sans que rien ne le signale (c'est ce qui s'est produit début septembre 2026). " +
      "Lecture seule : aucune capacité de virement ou de paiement n'est demandée à la banque. " +
      "« Simuler » n'appelle pas la banque, il affiche l'état de la connexion compte par compte — dont les comptes mappés qui n'ont AUCUNE transaction, signe que la lecture a commencé avant que le compte soit associé : il faut alors relire tout l'historique depuis la page Connecteurs.",
    trigger_config: {
      kind: 'schedule',
      source: 'setInterval 30 min (index.js) → services/plaidSync.js + POST /api/plaid/sync/:itemId',
      summary: 'Lecture aux 30 minutes, en plus des avis instantanés de la banque (webhook)',
    },
    action_config: {},
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_plaid_qb_audit',
    name: 'Rapprochement bancaire : vérification QuickBooks des comptes Plaid',
    description:
      "Toutes les 20 minutes (et sur demande depuis la page Rapprochement bancaire, bouton « Revérifier avec QuickBooks »), pour chaque compte branché à Plaid (BNC) et mappé à QuickBooks : cherche dans le grand livre QB, avec le moteur de recherche approfondie (tolérance de montant, ±30 jours, virements internes, devises — services/bankQbSearch.js), une écriture correspondant à chaque transaction bancaire non encore rapprochée. " +
      "Remplace, pour ces comptes, l'audit qui vivait dans la sync du fichier TRX_Orisha.xlsx (désormais désactivée pour eux — voir services/bankTrxSheet.js) : le statut « Comptabilisé »/« Rapproché » de ces comptes ne dépend plus que d'une preuve QuickBooks réelle, jamais d'une couleur peinte à la main dans un fichier Excel. " +
      "Le passage automatique couvre une fenêtre glissante de 90 jours ; le bouton manuel couvre tout l'historique non reconcilié (utile pour rattraper les transactions 2024-2025 jamais vérifiées par l'ancien audit, plafonné à 45 jours).",
    trigger_config: {
      kind: 'schedule',
      source: 'setInterval 20 min (index.js) → services/plaidQbAudit.js + POST /api/bank/accounts/:id/qb-audit',
      summary: 'Vérification aux 20 minutes + bouton « Revérifier avec QuickBooks » de la page Rapprochement bancaire',
    },
    action_config: {},
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_card_payment_reminder',
    name: 'Rappel mensuel : payer les cartes (Visa CAD / Visa USD)',
    description:
      "Rappelle chaque mois de payer les soldes des cartes de crédit avant la date cible (défaut : le 24 — l'échéance réelle des cartes est vers le 26-27, la cible garde une marge). " +
      "Le rappel n'est pas envoyé « N jours avant » mais le DERNIER jour travaillé encore à temps — le dernier mardi ou samedi qui tombe le 24 ou avant " +
      "(ex. le 24 est un lundi → rappel le samedi 22 ; le 24 est un samedi → rappel le jour même). " +
      "Envoi en message privé Slack (DM Antoine Lambert) via le webhook SLACK_WEBHOOK_PERSO — canal distinct de l'alerte trésorerie. " +
      "Si cette variable est absente de server/.env, le rappel part quand même sur SLACK_WEBHOOK_TREASURY et le journal le signale. Le scan tourne tous les matins (8 h, heure de Montréal) et ne logge que les jours où le rappel part — " +
      "un seul envoi par mois, même si le serveur redémarre plusieurs fois. " +
      "Configurable : libellé des cartes, jour d'échéance, jours travaillés (0 = dimanche … 6 = samedi) et webhook Slack. " +
      "Le bouton « Simuler » affiche la prochaine date de rappel et l'aperçu du message sans rien envoyer ; « Exécuter » envoie le rappel immédiatement.",
    trigger_config: {
      kind: 'schedule',
      source: 'cron 0 12 * * * UTC (index.js) → services/cardPaymentReminder.js',
      summary: 'Scan quotidien à 8 h (Montréal) ; envoi le dernier jour travaillé avant la date limite',
    },
    action_config: {
      cards: 'Visa CAD, Visa USD',
      due_day: '24',
      work_days: '2,6',
      slack_webhook_env: 'SLACK_WEBHOOK_PERSO',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_card_ceiling_alert',
    name: 'Plafond des cartes de crédit (MasterCard BNC)',
    description:
      "Surveille la PLACE qui reste sur les cartes de crédit d'opération — question distincte du rappel « payer les cartes » ci-dessus, qui reste actif : la Mastercard BNC sert à payer des fournisseurs et son paiement est pré-programmé le 4, donc un solde trop haut la rend inutilisable jusqu'au prélèvement. " +
      "Le solde est lu dans QuickBooks (solde comptabilisé du compte de carte, résolu par NUMÉRO de compte) puis complété par les transactions du relevé bancaire connues de l'ERP mais pas encore comptabilisées — sans elles on sous-estimerait le solde, l'erreur exactement dans le mauvais sens. Les deux chiffres restent affichés séparément. " +
      "Deux alertes possibles, chacune au plus une fois par carte et par mois : (a) J-5 avant le prélèvement, avec le montant à payer pour repasser sous le plafond (arrondi au dollar supérieur) et la date de paiement ramenée au jour ouvrable précédent si le prélèvement tombe une fin de semaine ou un férié ; (b) immédiatement, hors fenêtre, si le solde projeté franchit le plafond. " +
      "Par défaut l'alerte J-5 ne part que s'il y a réellement un paiement à faire — le canal comptabilité ne porte que ce qui appelle une action. Mettre « Rappel systématique » à 1 pour la recevoir chaque mois. " +
      "Limite de crédit, plafond cible, jour de prélèvement et compte QuickBooks de CHAQUE carte se règlent sur la carte « Plafond des cartes » du dashboard comptabilité (autosave) — un seul endroit, pas deux. Ici se règlent le périmètre et le canal. " +
      "Le bouton « Simuler » affiche les chiffres et le message qui partirait, sans rien envoyer ; « Exécuter » envoie l'état actuel immédiatement, sans condition — et ne consomme pas l'alerte du mois, la vraie partira quand même le moment venu.",
    trigger_config: {
      kind: 'schedule',
      source: 'cron 5 12 * * * UTC (index.js) → services/cardCeiling.js',
      summary: 'Scan quotidien à 8 h (Montréal) ; alerte à J-5 du prélèvement ou dès le franchissement du plafond',
    },
    action_config: {
      acctnums: '22000',
      lead_days: '5',
      min_alert_amount: '100',
      pending_lookback_days: '90',
      lead_always: '0',
      slack_channel: '#comptabilite',
      slack_webhook_url: '',
      slack_webhook_env: 'SLACK_WEBHOOK_TREASURY',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_pieces_disbursements',
    name: 'Déboursés mensuels en pièces : calcul, fichier Drive et message à Guillaume',
    description:
      "Le 7 de chaque mois (9 h, Montréal), exécute la procédure « Pièces_Déboursés » sur le mois qui vient de se terminer. " +
      "1) CALCUL : le grand livre QuickBooks du compte acctnum (14000 Stock de Pièces) est lu sur le mois ; toutes les écritures de journal sont écartées — ne restent que les « Dépense » et les « Facture à payer », en dollars canadiens. " +
      "Achats du mois = leur total. « À payer au début » = le « À payer à la fin » du mois précédent (les factures dues à la fin du mois passé sont déboursées ce mois-ci). " +
      "« À payer à la fin » = les factures fournisseurs du mois encore impayées au dernier jour du mois, déterminé par les paiements liés dans QuickBooks — ce que le comptable allait vérifier fournisseur par fournisseur. " +
      "Déboursés du mois = Achats + À payer au début − À payer à la fin. " +
      "2) FICHIER : un Google Sheet « Pièces_Déboursés_<Mois><AA> » est déposé dans le dossier Drive configuré (Comptabilité/…/Stocks/Déboursés_Pièces), avec le tableau des opérations, le bloc sommaire en formules et la liste des factures encore dues. Régénérer un mois remplace le fichier existant, il n'y a jamais deux fichiers pour le même mois. " +
      "3) VALIDATION : une notification prévient les admins que le montant est prêt. LE MESSAGE SLACK À GUILLAUME NE PART JAMAIS TOUT SEUL — l'utilisateur vérifie le montant sur la page « Écritures de fin de mois », corrige au besoin les deux montants « à payer », puis clique pour envoyer. " +
      "Les corrections manuelles l'emportent sur le calcul et se reportent au mois suivant. " +
      "Le bouton « Simuler » calcule et affiche les montants sans déposer de fichier ni notifier ; « Exécuter » relance la préparation complète du mois écoulé.",
    trigger_config: {
      kind: 'schedule',
      source: 'cron 0 13 7 * * UTC (index.js) → services/piecesDisbursements.js',
      summary: 'Le 7 de chaque mois à 9 h (Montréal), sur le mois qui vient de se terminer',
    },
    action_config: {
      acctnum: '14000',
      drive_folder_id: '1q0e-rHE2xxeapcDt8yyHh2xwJt1mChJc',
      google_account_email: 'michel@orisha.io',
      slack_webhook_env: 'SLACK_WEBHOOK_GUILLAUME',
      recipient: 'Guillaume',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_work_suggestions',
    name: 'Travaux : suggestions de chantiers et d\'intégrations par l\'agent',
    description:
      "Chaque matin, l'agent propose jusqu'à 5 prochains chantiers dans l'onglet « Suggestions » de la page Travaux — liste distincte de la file de prompts de l'utilisateur : " +
      "rien ne s'exécute avant d'avoir été promu à la main. " +
      "Un second moteur propose jusqu'à 3 « intégrations » : des logiciels ou des API externes à brancher à l'ERP, avec ce que le branchement débloquerait. " +
      "Son contexte à lui est l'inventaire de ce qui est DÉJÀ branché (connexions OAuth actives et clés d'API présentes — jamais leur valeur), le périmètre fonctionnel de l'app et les travaux encore manuels, " +
      "pour qu'il ne repropose pas Stripe ou QuickBooks. Les deux natures se filtrent par le sélecteur « Chantiers / Intégrations » de l'onglet. " +
      "Le signal principal est la liste des travaux encore faits À LA MAIN (onglet « Travaux récurrents ») : chaque ligne cochée semaine après semaine est un candidat à l'automatisation. " +
      "S'y ajoutent les commits récents (chantiers ouverts à refermer), les prompts récents de l'utilisateur (sa direction actuelle) et les erreurs de synchronisation des 14 derniers jours. " +
      "Le modèle n'explore pas le code : tout son contexte est assemblé par le serveur, donc le passage tourne sans risque en parallèle d'une exécution en cours. " +
      "Les doublons sont écartés par empreinte de titre, y compris les suggestions déjà rejetées — une même idée n'est jamais reproposée. " +
      "Le bouton « Simuler » montre le volume de contexte qui serait soumis, sans appeler le modèle ; « Exécuter » lance un passage immédiat.",
    trigger_config: {
      kind: 'schedule',
      source: 'cron 0 11 * * * UTC (index.js) → services/workSuggestions.js',
      summary: 'Passage quotidien à 7 h (Montréal)',
    },
    action_config: {},
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_month_end_provisions',
    name: 'Écritures de fin de mois : préparation des provisions',
    description:
      "Le 1er de chaque mois, prépare la clôture du mois écoulé — les étapes mécaniques des procédures « Provision - Subv. salariales » et « Provision Crédits R&D ». " +
      "1) Va chercher dans le Drive la feuille de temps du mois (feuille_de_temps_{mois}_{année}.xlsx), lit l'onglet de chaque personne et totalise les heures RS&DE " +
      "(la somme des jours fait foi, pas la ligne « total » du fichier) ; les lignes corrigées à la main dans l'ERP sont conservées. " +
      "2) Recalcule la provision de crédit d'impôt R&D (heures × taux horaire × majoration, moins le PARI du mois, × le taux de réclamation) et la provision de subvention salariale " +
      "(salaire brut du mois × le taux de contribution, plafonnée à la contribution maximale et bornée à la fenêtre d'admissibilité). " +
      "3) Notifie les admins dans l'ERP que les écritures sont prêtes. " +
      "La comptabilisation dans QuickBooks n'est jamais automatique : elle se fait écriture par écriture depuis la page « Écritures de fin de mois », après approbation. " +
      "Les paramètres de calcul (taux horaire, majoration, taux de réclamation, arrondi, plafond, fenêtre d'admissibilité, comptes QB) s'éditent sur cette même page. " +
      "Le bouton « Simuler » recalcule et affiche les montants du mois écoulé sans rien importer ni notifier.",
    trigger_config: {
      kind: 'schedule',
      source: 'cron 0 13 1 * * UTC (index.js) → services/monthEndAutomation.js',
      summary: 'Le 1er de chaque mois à 9 h (Montréal), sur le mois qui vient de se terminer',
    },
    action_config: {
      google_account_email: 'michel@orisha.io',
      contractors: 'Antoine Ratheau',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_paie_repartition',
    name: 'Paie : écriture de répartition par département (QuickBooks)',
    description:
      "Génère l'écriture de journal qui répartit chaque paie entre les départements, selon le processus de l'onglet Salaires du fichier CTB - Suivi : " +
      "base = total de la paie (remises aux organismes incluses) − remboursements de dépenses − téléphone Martin (76000, 25 $ taxes incluses) − allocation repas (75930, 50 $/jour, saisie au besoin). " +
      "La base est répartie selon les pourcentages configurés (défaut : Marketing 62100 33,6 %, Opérations 62200 5,1 %, Administration 62201 11,8 %, R&D 62300 49,5 % — fichier Prorata_Paie_2026-2027) ; " +
      "le compte source (62200, où la paie est comptabilisée initialement) est crédité. " +
      "Rien n'est publié automatiquement : la page Paies affiche l'aperçu et un bouton « Publier sur QB » (idempotent — une écriture par paie). " +
      "Assurance collective AGA (carte du Dashboard comptabilité) : il n'y a pas de compte d'assurance — la prime est ventilée dans les mêmes comptes de salaires par département. " +
      "Publiée comme les 12 comptabilisations historiques (Purchases QB 14791 → 17667) : dépense Cash sur le compte de banque 10000, fournisseur Groupe Financier AGA, code Exonéré par ligne, " +
      "mémo « AGA ASS. COLL. (répartition au prorata entre les départements) » — pas une écriture de journal. Les poids par défaut sont les montants réels d'avril à juillet 2026 " +
      "(890,86 / 311,78 / 260,11 / 1 275,20 sur 2 737,95 $ = 32,5375 / 11,3874 / 9,5002 / 46,575 %) et non le nb d'employés assurés arrondi, qui déviait de 1 à 14 $ par compte. " +
      "Le Dashboard comptabilité offre aussi la comptabilisation de la paie : dépense QB (Cash, compte 10000, fournisseur « Salaires », taxes incluses) ventilée par département au même prorata, " +
      "avec téléphone Martin (TPS/TVQ) et lignes « (rembourser à) » par employé — au modèle des transactions Salaires historiques, période de paie en mémo. " +
      "Le bouton « Simuler » montre l'écriture de la dernière paie sans rien publier.",
    trigger_config: {
      kind: 'manual',
      source: 'routes/paies.js (repartition-preview / repartition-push / aga-repartition)',
      summary: 'Publication manuelle depuis la page Paies (aperçu puis clic) et le Dashboard comptabilité (AGA)',
    },
    action_config: {
      splits: '62100:33.6, 62200:5.1, 62201:11.8, 62300:49.5',
      source_acctnum: '62200',
      phone_acctnum: '76000',
      phone_amount: '25',
      meals_acctnum: '75930',
      reimb_acctnum: '',
      aga_splits: '62100:890.86, 62200:311.78, 62201:260.11, 62300:1275.20',
      aga_source_acctnum: '10000',
      aga_vendor_name: 'Groupe Financier AGA',
      aga_taxcode: 'Exonéré',
      aga_memo: 'AGA ASS. COLL. (répartition au prorata entre les départements)',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_marketing_expense_sync',
    name: 'Budget marketing : détection des dépenses (QuickBooks)',
    description:
      "Automatise la détection de la procédure « Suivi - Budget marketing (Émilie) » : plusieurs fois par jour (aux 3 heures, de 6h30 à 18h30 à Montréal), le rapport GeneralLedger de QuickBooks est interrogé sur les comptes de dépenses marketing " +
      "(75910 Consultants, 75915 Partenaires, 75920 Publicité et promotion, 75925 Événements/Conférences, 75930 Repas aux fins de promotion — liste configurable ci-dessous). " +
      "Toute nouvelle ligne devient une dépense « à valider » dans la page Budget marketing (Espace finance), où l'on tranche : pertinente pour le budget d'Émilie " +
      "(activités visant de nouveaux clients au Canada anglais / USA) ou non. Un fournisseur récurrent jamais pertinent peut devenir une règle d'exclusion : " +
      "ses dépenses futures sont écartées automatiquement à l'ingestion, sans re-validation. " +
      "Dédup par clé naturelle (compte + transaction QB + date + montant + mémo) : re-balayer la même période n'insère rien — c'est ce qui permet de multiplier les passages sans créer de doublon. " +
      "Le balayage repart lookback_days jours avant la dernière dépense connue pour attraper les saisies tardives dans QB. " +
      "Le bouton « Simuler » rapporte l'état de la file sans rien écrire ; « Exécuter » lance une sync immédiate.",
    trigger_config: {
      kind: 'schedule',
      source: 'cron 30 10,13,16,19,22 * * * UTC (index.js) → services/marketingBudget.js',
      cron: '30 10,13,16,19,22 * * * UTC (aux 3 h, 6h30 → 18h30 à Montréal, tous les jours)',
      summary: 'Scan du grand livre QuickBooks 5 fois par jour, aux 3 heures (6h30 → 18h30, Montréal)',
    },
    action_config: {
      accounts: '75910,75915,75920,75925,75930',
      start_date: '2026-06-01',
      lookback_days: '45',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_marketing_weekly_slack',
    name: 'Budget marketing : message Slack hebdomadaire à Émilie',
    description:
      "Chaque mardi (jour configurable), envoie à Émilie un message Slack court et clair listant les dépenses marketing validées « pertinentes » depuis le dernier envoi " +
      "(date, fournisseur, montant, catégorie, total) — ou « aucune nouvelle dépense pertinente » s'il n'y en a pas. " +
      "Seules les dépenses DÉJÀ validées dans la page Budget marketing partent : une ligne encore en attente n'est jamais annoncée (elle partira un mardi suivant, une fois tranchée). " +
      "Une sync QuickBooks est faite juste avant l'envoi pour que le message reflète le grand livre du jour. " +
      "L'envoi a lieu en FIN D'APRÈS-MIDI (16h, Montréal) : le tri des dépenses se fait le mardi dans la journée, un envoi le matin partirait vide et les dépenses validées attendraient le mardi suivant. " +
      "GARDE-FOU : si aucune dépense n'est validée mais que des lignes restent à valider, l'envoi est RETENU — annoncer « aucune dépense pertinente » alors que des dépenses attendent seulement un tri serait une fausse information. " +
      "Le journal dit alors pourquoi, et les dépenses partent dès qu'elles sont tranchées (au prochain envoi hebdomadaire). Une semaine réellement vide (rien en attente, rien de pertinent) envoie bien « aucune dépense ». " +
      "Un seul envoi planifié par semaine, même si le serveur redémarre. Le journal signale le nombre de dépenses encore en attente de validation. " +
      "Le webhook Slack est lu depuis la variable SLACK_WEBHOOK_MARKETING de server/.env (configurée) — si elle disparaissait, l'envoi échouerait avec une erreur visible dans le journal ci-dessous. " +
      "Le bouton « Simuler » montre le message qui partirait sans l'envoyer ; « Exécuter » envoie immédiatement (ignore le jour, l'idempotence et le garde-fou — c'est un choix explicite).",
    trigger_config: {
      kind: 'schedule',
      source: 'cron 0 20 * * * UTC (index.js) → services/marketingBudget.js',
      cron: '0 20 * * * UTC (16h à Montréal, tous les jours — envoi le mardi seulement)',
      summary: 'Scan quotidien à 16h (Montréal) ; envoi le mardi, une fois par semaine',
    },
    action_config: {
      send_weekday: '2',
      slack_webhook_env: 'SLACK_WEBHOOK_MARKETING',
      recipient: 'Émilie',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_instagram_prospect_intake',
    name: 'Prospects Instagram : réception des commentaires (ManyChat)',
    description:
      "Reçoit les appels de ManyChat sur POST /api/instagram/manychat (action « External Request », réservée au forfait Pro de ManyChat) et tient la liste des prospects Instagram. " +
      "Trois flux : « comment » (quelqu'un a commenté une de nos publications), « dm_sent » (ManyChat a envoyé le message privé) et « reply » (la personne a répondu). " +
      "L'ERP est la SOURCE DE VÉRITÉ de la dédup : ManyChat ne déclenche qu'une fois par personne ET PAR PUBLICATION, il ne peut donc pas savoir qu'on a déjà écrit à quelqu'un qui commente une deuxième publication. " +
      "La réponse HTTP porte « should_dm » — le flow ManyChat doit brancher dessus AVANT d'envoyer le DM. C'est ce qui garantit qu'une même personne n'est jamais recontactée. " +
      "Dédup par IGSID (identifiant Instagram stable, résiste au changement de nom d'usager) avec repli sur le nom d'usager ; une fiche créée sans IGSID est promue dès qu'un appel l'apporte, et un doublon éventuel est fusionné sans perdre la mémoire du DM déjà envoyé. " +
      "Chaque appel est journalisé (table instagram_prospect_events) et un rejeu de livraison ne regonfle pas les compteurs. Chaque fiche est poussée dans la table Airtable « Prospects Instagram ». " +
      "PRÉREQUIS : le secret partagé (connector_config manychat/webhook_secret) doit être configuré, sinon le webhook répond 503 ; et la table Airtable doit être créée à la main puis configurée (Connecteurs → Airtable), le jeton n'ayant pas le droit de créer des tables. " +
      "LIMITES DE PLATEFORME assumées : le DM n'est possible qu'en réponse privée à un commentaire (1 seul par commentaire, dans les 7 jours, aucun DM à froid) ; la liste des nouveaux abonnés est impossible à obtenir (Meta n'expose que le compteur) ; les commentaires d'une publication publiée par un partenaire ne sont pas accessibles. " +
      "Le bouton « Simuler » rapporte l'état de la file et de la configuration. Pas d'« Exécuter » : le déclencheur est un appel de ManyChat, on ne fabrique pas de faux prospect.",
    trigger_config: {
      kind: 'webhook',
      source: 'POST /api/instagram/manychat (routes/instagram.js) → services/instagramProspects.js',
      summary: 'Appelé par ManyChat à chaque commentaire, DM envoyé ou réponse',
    },
    action_config: {
      keywords: 'coach',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_instagram_comment_scrape',
    name: 'Prospects Instagram : lecture des commentaires',
    description:
      "Chaque nuit de dimanche à lundi à minuit (heure de Montréal), relit les commentaires des publications récentes des comptes configurés et enregistre TOUS les commentateurs comme prospects — « keywords » (« coach » par défaut) ne filtre plus rien, il sert seulement à étiqueter/prioriser les fiches qui le contiennent, avec tolérance aux fautes de frappe courantes (ex. « couch »). " +
      "Passe par la même porte d'ingestion que ManyChat : même dédup par IGSID, même fusion de fiches, même miroir Airtable, même liste hebdomadaire. Relire deux fois la même semaine ne crée aucun doublon (l'identifiant du commentaire porte l'idempotence) — la fenêtre est donc réglée sur 7 jours, exactement la semaine qui vient de se clore, ni plus ni moins. " +
      "POURQUOI EN PLUS DE MANYCHAT : ManyChat ne voit que ce que son flow a capté pendant qu'il tournait — un flow arrêté, une panne ou un mot-clé ajouté après coup laissent des commentateurs derrière. Ici on relit, à volonté et rétroactivement. " +
      "La tournée clôt la semaine ISO : à minuit dans la nuit de dimanche à lundi, tous les commentaires de la semaine écoulée sont déjà passés. " +
      "PRÉREQUIS : un cookie de session Instagram (« sessionid ») collé dans Connecteurs → Instagram — DevTools → Application → Cookies → instagram.com. Il expire environ une fois par an ; Instagram répond alors 401 et une ERREUR explicite est journalisée ci-dessous, jamais un silence. " +
      "PUBLICATIONS EN COLLAB : le champ « accounts » accepte plusieurs comptes séparés par des virgules (par défaut @orisha_auto et @growingformarketmagazine). Une publication en collaboration est un seul média avec un seul fil de commentaires, affiché sur les deux grilles — elle est donc dédoublonnée et lue une seule fois, peu importe lequel des deux comptes a publié. " +
      "« Simuler » montre l'état de la configuration sans appeler Instagram ; « Exécuter » lance une tournée immédiate.",
    trigger_config: {
      kind: 'schedule',
      source: "cron 0 4,5 * * 1 UTC (index.js) → services/instagramCommentScrape.js",
      cron: "0 4,5 * * 1 UTC (minuit dans la nuit de dimanche à lundi à Montréal, en heure d'été comme en heure d'hiver)",
      summary: 'Nuit de dimanche à lundi, minuit (Montréal)',
    },
    action_config: {
      accounts: 'orisha_auto, growingformarketmagazine',
      keywords: 'coach',
      lookback_days: '7',
      own_accounts: 'orisha_auto, growingformarketmagazine',
      run_weekday: '1',
      run_hour: '0',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_instagram_weekly_slack',
    name: 'Prospects Instagram : liste hebdomadaire à Philippe (Slack)',
    description:
      "Chaque lundi à 7 h 30 (heure de Montréal), envoie à Philippe la liste des prospects Instagram captés depuis le dernier envoi : nom d'usager cliquable, mot-clé, date, DM envoyé ou non, réponse reçue ou non, et le lien vers la table Airtable où il édite le suivi. " +
      "Le message est DÉLIBÉRÉMENT COURT : la semaine en clair (« du 17 au 23 août »), le nombre de prospects, combien avec le mot-clé, combien de DM envoyés, combien ont répondu — puis deux liens, vers la page ERP et vers Airtable. " +
      "Le détail n'est pas recopié dans Slack : il vit là où Philippe travaille et coche « contacté », et un pavé serait périmé dès la première case cochée. Un message part même s'il n'y a aucun prospect — un silence serait indistinguable d'une panne. " +
      "Le backlog part en entier : un prospect non annoncé (panne Slack, canal manquant) repart au passage suivant, jamais perdu. Un seul envoi planifié par semaine, même si le serveur redémarre. " +
      "DESTINATAIRE : coller l'URL du webhook Slack de Philippe dans « slack_webhook_url » ci-dessous (aucune modification de server/.env nécessaire). À défaut, la variable d'environnement nommée dans « slack_webhook_env » est utilisée ; " +
      "si aucun canal n'est joignable, le message part sur le canal de repli (trésorerie) avec un préfixe d'avertissement, et si même le repli manque, une ERREUR est journalisée ci-dessous — l'envoi n'échoue jamais en silence. " +
      "Le bouton « Simuler » montre le message qui partirait sans l'envoyer ni marquer les fiches ; « Exécuter » envoie immédiatement (ignore le jour, l'heure et l'idempotence hebdomadaire).",
    trigger_config: {
      kind: 'schedule',
      source: 'cron 30 11,12 * * 1 UTC (index.js) → services/instagramProspects.js',
      cron: '30 11,12 * * 1 UTC (lundi 7 h 30 à Montréal, en heure d\'été comme en heure d\'hiver)',
      summary: 'Lundi 7 h 30 (Montréal), une fois par semaine',
    },
    action_config: {
      send_weekday: '1',
      send_hour: '7',
      slack_webhook_url: '',
      slack_webhook_env: 'SLACK_WEBHOOK_PHILIPPE',
      recipient: 'Philippe',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_ticket_survey_slack',
    name: 'Sondage de satisfaction : alerte Slack à Philippe',
    description:
      "Quand un client répond au sondage de satisfaction envoyé par SMS depuis la fiche d'un billet, envoie une alerte Slack — mais SEULEMENT sur les cas actionnables. " +
      "TROIS DÉCLENCHEURS : (1) note inférieure ou égale à « low_rating_max » (client mécontent, quelqu'un doit rappeler) ; " +
      "(2) le client a répondu OUI à « accepteriez-vous d'être contacté par téléphone pour parler de votre expérience ? » (occasion de témoignage) ; " +
      "(3) le client MODIFIE une réponse déjà donnée — le lien reste ouvert jusqu'à l'expiration, un changement d'avis est toujours signalé, même si la nouvelle note est bonne. " +
      "Une note de 4 ou 5 sans demande de rappel ne produit AUCUN message : elle n'appelle aucune action et se consulte dans la fiche du billet et dans la colonne « Satisfaction » de la liste des billets. " +
      "L'ENVOI DU SONDAGE LUI-MÊME EST 100 % MANUEL et n'est pas géré par cette automation : il part du bouton « Sondage de satisfaction » dans la fiche du billet, jamais automatiquement à la fermeture. " +
      "DESTINATAIRE : le plus simple est d'écrire le canal dans « slack_channel » — « #support », « @philippe » ou son courriel — ce qui passe par le bot Slack de l'ERP (SLACK_BOT_TOKEN) et ne demande aucun webhook. " +
      "Sinon, coller l'URL d'un webhook entrant dans « slack_webhook_url », ou nommer une variable d'environnement dans « slack_webhook_env » ; " +
      "si aucun canal n'est joignable, le message part sur le canal de repli (trésorerie) avec un préfixe d'avertissement, et si même le repli manque, une ERREUR est journalisée ci-dessous — jamais un silence. " +
      "Désactiver cette automation coupe les alertes, pas la collecte : les réponses continuent d'être enregistrées et restent visibles dans l'ERP.",
    trigger_config: {
      kind: 'app_event',
      source: 'services/ticketSurveys.js:recordSurveyResponse → notifySurveyResponse',
      summary: "Réponse d'un client au sondage de satisfaction",
    },
    action_config: {
      slack_channel: '',
      slack_webhook_url: '',
      slack_webhook_env: 'SLACK_WEBHOOK_PHILIPPE',
      recipient: 'Philippe',
      low_rating_max: '2',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_address_check',
    name: 'Vérification des adresses postales + notification des adresses fautives',
    description:
      "Chaque adresse postale qui entre dans l'ERP est contrôlée à l'écriture, QUELLE QUE SOIT SON ORIGINE : saisie sur la fiche entreprise, appel de qualification, formulaire post-paiement du client, sync Airtable. La détection ne dépend pas de la route utilisée — un watcher lit le journal des mutations de la table Adresses, donc aucune origine ne peut passer à côté. " +
      "Sont détectés : champ obligatoire manquant (rue, ville, province, code postal, pays), valeur bouche-trou (« à venir », « n/a », « x »), code postal mal formé (A1A 1A1 au Canada, 12345 ou 12345-6789 aux États-Unis), province / État inexistant, et code postal qui ne correspond PAS à la province (ex. un code postal en G… déclaré en Ontario). " +
      "Une rue sans numéro civique est signalée en simple avertissement (un rang ou une route rurale reste plausible). " +
      "Quand une adresse est fautive, une notification in-app part vers l'auteur de la saisie ; les adresses arrivées sans auteur connu (sync Airtable, formulaire client) notifient les rôles listés dans fallback_roles. " +
      "Anti-spam : une adresse déjà signalée ne re-notifie pas tant que ses problèmes n'ont pas changé — corriger puis re-casser l'adresse renotifie. Et une PASSE COMPLÈTE (bouton « Vérifier toutes les adresses », ou « Exécuter » ici) ne notifie JAMAIS : elle rafraîchit l'affichage, sinon tout le passif hérité d'Airtable tomberait dans la cloche d'un coup. " +
      "L'état complet est visible dans Paramètres → Adresses (compteurs + liste des adresses à corriger avec le lien vers l'entreprise), et un pastille d'alerte apparaît sur la fiche entreprise. " +
      "AUCUN appel réseau : la vérification est locale et déterministe (la clé Google de l'ERP n'a accès ni à la Geocoding API ni au Places New). " +
      "require_postal_code à 0 rétrograde le code postal absent en avertissement ; notify à 0 vérifie et affiche sans jamais notifier. " +
      "Le bouton « Simuler » liste ce qui serait signalé sans rien écrire ni notifier ; « Exécuter » relance une passe complète sur toutes les adresses.",
    trigger_config: {
      kind: 'db_change',
      source: 'change_log(adresses) → services/addressCheck.js (watcher, poll 5 s) + appel direct dans routes/projets.js POST/PUT /adresses',
      summary: "Déclenché à chaque écriture DB d'une adresse (UI, appel de qualification, formulaire client, sync Airtable)",
    },
    action_config: {
      require_postal_code: '1',
      fallback_roles: 'admin',
      notify: '1',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_purchase_price_check',
    name: "Vérification des prix d'achats (inventaire) + alerte sur prix aberrant",
    description:
      "Chaque achat de pièce (table Achats, miroir de l'interface Inventaire → Achats d'Airtable) est contrôlé à l'écriture, quelle que soit l'origine (sync Airtable en tête) : un watcher lit le journal des mutations de la table. " +
      "Contexte : dans Airtable, le prix unitaire d'un achat est CALCULÉ — total facturé des « Dépense Line item » liés ÷ quantité. Quand le match automatique Airtable lie par erreur la ligne d'une autre pièce, le prix devient absurde (cas réel du 2026-09-01 : Raspberry Pi 4 à 1 $ au lieu de 81,85 $) et fausse la valeur d'inventaire. " +
      "Sont détectés : prix unitaire hors des bornes ratio_min/ratio_max par rapport à la référence de la pièce (médiane des autres achats, sinon coût de référence du produit) avec un écart d'au moins min_abs_diff $ ; et achat dont une dépense est liée mais dont le prix reste à 0 $. Un achat à 0 $ SANS dépense liée n'est PAS signalé : c'est l'état normal d'une commande pas encore facturée. " +
      "Quand un prix devient suspect, une notification in-app part vers les destinataires listés dans fallback_roles — des rôles (admin, sales…) et/ou des emails de comptes précis, séparés par des virgules — avec le lien vers l'achat et la marche à suivre (corriger le lien « Dépense Line item » dans Airtable — le prix lui-même est un champ calculé, non modifiable). " +
      "Anti-spam : un achat déjà signalé ne re-notifie pas tant que la nature du problème n'a pas changé, et une passe complète (« Exécuter » ici) ne notifie jamais — elle rafraîchit l'état. " +
      "notify à 0 vérifie et affiche sans jamais notifier. Le bouton « Simuler » liste ce qui serait signalé sans rien écrire.",
    trigger_config: {
      kind: 'db_change',
      source: 'change_log(purchases) → services/purchasePriceCheck.js (watcher, poll 5 s)',
      summary: "Déclenché à chaque écriture DB d'un achat (sync Airtable, édition ERP, import DigiKey)",
    },
    action_config: {
      ratio_min: '0.25',
      ratio_max: '4',
      min_abs_diff: '20',
      fallback_roles: 'antoine.lambert96@gmail.com',
      notify: '1',
    },
    configurable: true,
    default_active: 1,
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
  {
    id: 'sys_return_label',
    name: 'Étiquette de retour (RMA) — achat Novoxpress',
    description:
      "Depuis une fiche Retour, achète une étiquette de retour Novoxpress (le client expédie, Orisha reçoit — l'inverse d'un envoi sortant). " +
      "Le transporteur est proposé automatiquement : Purolator si le client est au Canada, UPS s'il est aux États-Unis, sauf si un autre " +
      "tarif de la liste est moins cher de plus que le seuil configuré ci-dessous — auquel cas le moins cher est proposé à la place, avec la raison affichée. " +
      "Le tarif proposé reste modifiable manuellement avant achat. Le PDF est enregistré sous uploads/labels/return-<id>.pdf et " +
      "les colonnes return_label_* de returns sont mises à jour.",
    trigger_config: {
      kind: 'manual',
      source: 'POST /api/retours/:id/return-label',
      summary: "Déclenché manuellement depuis la fiche retour (bouton « Générer l'étiquette de retour »)",
    },
    action_config: {
      prefer_ca: 'purolator',
      prefer_us: 'ups',
      savings_threshold: '0',
    },
    configurable: true,
  },
  {
    id: 'sys_ups_return_label',
    name: 'Étiquette de retour (RMA) — achat UPS',
    description:
      "Depuis une fiche Retour, achète une étiquette de retour directement chez UPS (Shipping API, ReturnService code 9 « Print Return Label ») : " +
      "l'adresse du client est l'expéditeur, l'atelier d'Orisha le destinataire, et le compte UPS d'Orisha paie. " +
      "Le PDF est enregistré sous uploads/labels/ups-return-<id>.pdf ; le suivi, le coût, la devise et le service sont écrits sur le retour. " +
      "Pour un client hors Canada, la facture commerciale (description, valeur, pays d'origine, code SH) est générée depuis les items du retour. " +
      "L'environnement UPS (CIE de test / production) vient du connecteur — en CIE aucune étiquette n'est facturée ni utilisable.",
    trigger_config: {
      kind: 'manual',
      source: 'POST /api/ups/returns/:id/return-label',
      summary: "Déclenché manuellement depuis la fiche retour (bouton « Créer l'étiquette de retour UPS »)",
    },
  },
  {
    id: 'sys_ups_return_label_email',
    name: 'Étiquette de retour UPS au client (Postmark)',
    description:
      "Envoie au client l'étiquette de retour UPS en pièce jointe PDF. L'envoi est planifié côté interface avec une fenêtre " +
      "d'annulation de 10 s (toast « Annuler ») : le serveur n'est appelé qu'une fois le délai écoulé. Une interaction 'email' " +
      "est créée comme pour les autres courriels sortants, et returns.return_label_sent_at est mis à jour.",
    trigger_config: {
      kind: 'manual',
      source: 'POST /api/ups/returns/:id/return-label/send',
      summary: "Déclenché depuis la fiche retour, après la fenêtre d'annulation de 10 s",
    },
  },
  {
    id: 'sys_return_instructions_email',
    name: 'Instructions de retour au client (Postmark)',
    description:
      "Envoie l'un des 6 templates HubSpot réels (US/CAN-FR/CAN-EN × immédiat/différé — sélection par pays, langue du contact " +
      "et raison du retour) avec l'étiquette de retour et l'aide-mémoire en pièces jointes. Même mécanique que " +
      "sys_shipment_tracking_email : interaction 'email' créée, et returns.instructions_sent_at mis à jour.",
    trigger_config: {
      kind: 'manual',
      source: 'POST /api/retours/:id/send-instructions',
      summary: "Déclenché manuellement depuis la fiche retour (bouton « Envoyer les instructions »)",
    },
  },
  {
    id: 'sys_return_bulk_by_company',
    name: 'Retourner tous les numéros de série (import Airtable #3)',
    description:
      "Depuis la fiche entreprise, sélectionne des numéros de série dans le tableau et choisit une raison de retour : " +
      "crée un dossier de retour (returns) + un item de retour par numéro de série sélectionné, et passe chaque numéro de " +
      "série au statut « En retour ».",
    trigger_config: {
      kind: 'manual',
      source: 'POST /api/retours/bulk-from-serials',
      summary: "Déclenché manuellement depuis la fiche entreprise (action groupée sur le tableau des numéros de série)",
    },
  },
  {
    id: 'sys_order_item_shipped_cost',
    name: "Gel du coût total au moment de l'envoi",
    description:
      "Dès qu'un envoi est associé à une ligne de commande (condition par défaut : shipment_id non vide), le coût de la ligne " +
      "est recalculé et gelé dans « Coût total au moment de l'envoi » : chaque numéro de série rattaché à la ligne compte " +
      "pour SA valeur de fabrication (table Numéros de série), et la quantité qui ne porte pas de numéro de série est " +
      "valorisée au coût de la pièce lu dans la table Pièces (« Cout unitaire », à défaut le coût unitaire FIFO) — jamais au " +
      "coût saisi sur la ligne de commande. Une série sans valeur de fabrication est valorisée au coût de la pièce (le détail " +
      "est dans chaque exécution ci-dessous). " +
      "Déclenché par modification DB via un watcher qui tail change_log sur order_items — donc quelle que soit l'origine de " +
      "l'envoi : fiche commande, mode expédition, étiquette Novoxpress, ou création de l'envoi dans Airtable (le sync des " +
      "envois rattache les « items expédiés » à la ligne). Aucune route front-end ne fait ce calcul. " +
      "N'écrit QUE si la colonne est vide : le gel est définitif, l'historique (y compris celui figé par Airtable avant la " +
      "reprise) n'est jamais réécrit automatiquement. Pour reprendre un coût faux (coût de pièce corrigé après coup, valeur " +
      "de fabrication saisie en retard), le bouton « Recalculer » de la carte Rentabilité de la commande recalcule et re-gèle " +
      "ses lignes déjà envoyées — chaque recalcul apparaît dans l'historique ci-dessous. Quand un commis ne peut " +
      "pas tout expédier, il duplique la ligne et corrige les quantités : chaque ligne est alors gelée pour sa propre " +
      "quantité. Le coût gelé est ce que lisent la rentabilité de la commande et les dashboards. " +
      "Désactiver l'automation suspend le gel (les envois survenus pendant la pause ne sont pas rattrapés à la réactivation).",
    trigger_config: {
      kind: 'db_change',
      source: 'change_log(order_items) → shippedCostWatcher (poll 5s)',
      summary: "Déclenché à l'écriture DB d'une ligne de commande : shipment_id not_null (toute origine : UI, Novoxpress, sync Airtable)",
      erp_table: 'order_items',
      column: 'shipment_id',
      op: 'not_null',
    },
    configurable: true,
  },
  {
    id: 'sys_return_item_created',
    name: 'Création d\'un item de retour (import Airtable #2)',
    description:
      "Dès qu'un item de retour est créé (quelle qu'en soit l'origine — bouton retour, retour en masse, sync Airtable), " +
      "passe le numéro de série lié au statut « En retour », et si la raison est « Retour de garantie avec échange immédiat », " +
      "crée automatiquement une vraie commande de remplacement (orders + order_items, item_type='Remplacement'). " +
      "Toute erreur part en alerte Slack. Idempotent via return_items.rma_processed_at — un item déjà traité n'est jamais rejoué.",
    trigger_config: {
      kind: 'db_change',
      source: 'change_log(return_items) → returnItemCreatedWatcher (poll 5s)',
      summary: "Déclenché à la création d'un item de retour",
    },
  },
  {
    id: 'sys_return_item_received',
    name: 'Réception d\'un retour (import Airtable #5 + #6)',
    description:
      "Quand un item de retour est marqué reçu (date + réceptionniste renseignés), écrit les instructions au réceptionniste " +
      "et met à jour le statut du numéro de série selon la raison du retour (À analyser / À reconditionner). Alerte Slack pour " +
      "un changement d'idée client / fin d'abonnement, et pour un retour sans raison reconnue. Idempotent via " +
      "return_items.reception_processed_at.",
    trigger_config: {
      kind: 'db_change',
      source: 'change_log(return_items) → returnItemReceivedWatcher (poll 5s)',
      summary: "Déclenché quand un item de retour passe reçu (received_at + received_by renseignés)",
    },
  },
  {
    id: 'sys_return_exchange_reminder',
    name: 'Rappel retours avec échange immédiat (import Airtable #4)',
    description:
      "Relance quotidiennement (tant que le retour n'est pas facturé) les clients ayant un échange de garantie immédiat en " +
      "cours dont au moins un item n'a pas encore été reçu — email bilingue avec le détail des items dus et un avertissement " +
      "rouge « facturation à venir » passé 21 jours depuis la demande. Fidèle à l'original Airtable : ce n'est PAS un envoi " +
      "one-shot, le rappel repart chaque jour tant que la condition tient. " +
      "⚠️ Désactivé par défaut au premier déploiement — activer manuellement depuis cette page après vérification (impact client direct).",
    trigger_config: {
      kind: 'schedule',
      source: 'index.js:scheduleReturnExchangeReminder',
      cron: 'every 24h at 09:00',
      summary: 'Scheduler interne — une fois par jour à 9h (local)',
    },
    default_active: 0,
  },
  {
    id: 'sys_trash_auto_cleanup',
    name: 'Corbeille : suppression définitive après 30 jours',
    description:
      "Chaque nuit à 3 h 30 (heure de Montréal), et une fois au démarrage du serveur, détruit définitivement les éléments " +
      "qui traînent dans la corbeille (page Admin → Corbeille) depuis plus de retention_days jours. " +
      "La date affichée sur chaque élément de la corbeille (« Suppression définitive dans X jours ») suit ce réglage : " +
      "changer retention_days change immédiatement le compte à rebours affiché. " +
      "PÉRIMÈTRE : entreprises, contacts, commandes, produits, envois, retours, projets, assemblages, tâches, interactions, " +
      "numéros de série — plus les automations supprimées, qui ne s'affichent pas dans la corbeille. " +
      "LES CHAMPS SUPPRIMÉS SONT ÉPARGNÉS : pour un champ, la ligne dans la corbeille est justement ce qui le garde hors " +
      "des fiches ; la détruire le ferait réapparaître partout un mois après sa suppression. Ils restent donc dans la " +
      "corbeille indéfiniment, et seul le bouton « Vider la corbeille » peut les enlever. " +
      "Suppression ligne par ligne : un enregistrement encore référencé ailleurs est laissé en place et signalé dans le " +
      "journal ci-dessous plutôt que de faire échouer tout le passage. " +
      "Le journal ne reçoit que les passages qui ont détruit ou bloqué quelque chose — une nuit sans rien à faire est silencieuse. " +
      "Le bouton « Simuler » compte ce qui partirait sans rien détruire ; « Exécuter » lance le nettoyage immédiatement.",
    trigger_config: {
      kind: 'schedule',
      source: "cron '30 7 * * *' UTC (index.js) → services/trash.js runTrashAutoCleanup()",
      cron: '30 7 * * * UTC (3h30 à Montréal, tous les jours)',
      summary: 'Scheduler interne — une fois par nuit, plus un passage au démarrage du serveur',
    },
    action_config: {
      retention_days: '30',
    },
    configurable: true,
    default_active: 1,
  },
]

// System automations dont trigger_config/action_config sont partiellement
// éditables par l'utilisateur (routes/automations.js PATCH + AutomationDetail.jsx).
// Le seed ne doit PAS écraser leur configuration au boot — seed-on-first-insert
// puis merge additif des clés par défaut manquantes (migration douce).
export const CONFIGURABLE_SYSTEM_AUTOMATIONS = new Set(
  SYSTEM_AUTOMATIONS.filter(sa => sa.configurable).map(sa => sa.id)
)

// Sous-ensemble des configurables dont la CONDITION de déclenchement (colonne/op/
// valeur) est elle-même éditable par l'utilisateur : leur trigger_config en DB ne
// doit jamais être écrasé au boot. Les autres configurables ont un déclencheur
// défini par le code (cron, app_event) — purement descriptif, resynchronisé à
// chaque boot pour que la fiche affiche toujours la réalité du code.
const USER_EDITABLE_TRIGGER_AUTOMATIONS = new Set(['sys_revenue_recognition'])

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

// Automations système abandonnées : leur row DB est soft-deletée au boot pour
// qu'elles disparaissent de la page Automations (le seed ne les recrée plus).
// - sys_ctb_abonnements : miroir de l'onglet Abonnements du sheet CTB - Suivi,
//   abandonné — la page Abonnements fournisseurs de l'ERP est la référence.
const RETIRED_SYSTEM_AUTOMATION_IDS = ['sys_ctb_abonnements', 'sys_req_import', 'sys_weekly_review_slack']

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
      // Trigger défini par le code (cron, app_event — descriptif, non éditable) :
      // resynchronisé intégralement. Trigger éditable par l'utilisateur : merge
      // additif seulement, ses column/op/value priment.
      const tc = USER_EDITABLE_TRIGGER_AUTOMATIONS.has(sa.id)
        ? mergeMissingKeys(row?.trigger_config, sa.trigger_config)
        : (row?.trigger_config !== JSON.stringify(sa.trigger_config) ? JSON.stringify(sa.trigger_config) : null)
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
  for (const id of RETIRED_SYSTEM_AUTOMATION_IDS) {
    db.prepare(`
      UPDATE automations SET active = 0, deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND deleted_at IS NULL
    `).run(id)
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

// Marque une exécution sans rien écrire dans l'historique : le « dernière
// exécution » de l'automation avance, mais aucune ligne de journal n'est créée.
// Pour les automations à battement rapide dont la plupart des passages n'ont
// rien à raconter (sync Gmail toutes les 3 min : 480 passages/jour, presque
// tous « 0 courriel »). Sans ça les 50 derniers journaux ne couvriraient que
// deux heures et noieraient les passages qui, eux, ont importé quelque chose.
export function touchSystemRun(key, status = 'success') {
  try {
    db.prepare(`
      UPDATE automations SET last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_run_status = ?
      WHERE id = ? AND system = 1
    `).run(status, key)
  } catch (e) {
    console.error(`⚠️  touchSystemRun(${key}) failed:`, e.message)
  }
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
