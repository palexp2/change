import db from '../db/database.js'
import { sendInstallationFollowups } from './installationFollowup.js'
import { getAutomationFrom } from './postmarkConfig.js'
import { syncAndPushStripePayouts } from './quickbooks.js'
import { migratePartnershipToBlocks, seedPartnershipLostFlow } from './subscriptionProductTrigger.js'

// Registry of system automations that can be invoked manually from the UI
// (dry-run to preview, or run-now to execute). Omit an id here to keep it
// un-runnable — pure passive system automations (webhooks, post_sync) don't
// belong here.
//
// Each handler receives { dryRun } and returns a plain object that will be
// serialized into the automation_logs `result` field verbatim.
export const MANUAL_RUNNERS = {
  // dry-run = contacts qui seraient mis à jour ; run-now = envoi, échecs compris.
  sys_partnership_hubspot: async ({ dryRun }) => {
    const { runPartnershipHubspot } = await import('./partnershipHubspot.js')
    return runPartnershipHubspot({ dryRun: !!dryRun, retryErrors: true })
  },
  sys_treasury_sheet_mirror: async ({ dryRun }) => {
    const { syncTreasuryMirror } = await import('./treasurySheetMirror.js')
    return syncTreasuryMirror({ dryRun: !!dryRun, trigger: 'manual' })
  },
  sys_installation_followup: async ({ dryRun }) => {
    const out = await sendInstallationFollowups(db, { dryRun, fromAddress: getAutomationFrom('sys_installation_followup') })
    return {
      summary: `${out.total} éligible(s) · ${out.sent} envoyé(s) · ${out.skipped} dry-run · ${out.errors} erreur(s)`,
      details: out.details,
    }
  },
  sys_meeting_reminders: async ({ dryRun }) => {
    const { runMeetingReminders } = await import('./meetings.js')
    return runMeetingReminders({ dryRun: !!dryRun })
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
  // Factures réglées dans l'ERP dont l'écriture de paiement manque encore dans
  // QuickBooks : dry-run = la liste, run-now = l'envoi (borné à 25).
  sys_bill_payment_qb: async ({ dryRun }) => {
    const { runPendingBillPayments } = await import('./billPaymentQb.js')
    return await runPendingBillPayments({ apply: !dryRun })
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

  // Confirmation des adresses de livraison / ferme auprès de Google.
  // dry-run = liste les adresses qui seraient interrogées ; run-now = confirme
  // celles dont le texte a changé depuis leur dernière confirmation.
  sys_address_confirm: async ({ dryRun }) => {
    const { runAddressConfirmSweep } = await import('./addressConfirm.js')
    return runAddressConfirmSweep({ dryRun: !!dryRun })
  },

  // Fermeture des projets ouverts depuis trop longtemps : dry-run = la liste,
  // run-now = la fermeture (même si l'automation est en pause).
  sys_project_auto_close: async ({ dryRun }) => {
    const { runProjectAutoClose } = await import('./projectAutoClose.js')
    return runProjectAutoClose({ dryRun: !!dryRun, trigger: 'manuel' })
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

  // Vérification QuickBooks du rapprochement — le moteur unique. Dry-run
  // n'existe pas vraiment ici : la recherche ne touche que le lien QuickBooks
  // et le statut, jamais un montant ni une écriture comptable. On lance donc le
  // passage dans les deux cas ; « Simuler » sert juste à le voir tourner.
  // Passe de nuit du rapprochement : « Simuler » liste sans rien corriger.
  sys_bank_reconcile_nightly: async ({ dryRun }) => {
    const { runNightlyReconcile } = await import('./bankReconcileNightly.js')
    return runNightlyReconcile({ dryRun: !!dryRun, trigger: 'manuel', force: true, log: false })
  },
  sys_bank_qb_verify: async () => {
    const { scheduledQbVerify } = await import('./bankQbVerify.js')
    const out = await scheduledQbVerify({ trigger: 'manuel', force: true })
    return out || { summary: 'un passage est déjà en cours' }
  },
  // Avis QuickBooks : rien à exécuter (c'est Intuit qui appelle). « Simuler »
  // rend l'état du jeton et les derniers avis reçus — c'est exactement ce qu'il
  // faut voir quand la détection instantanée s'arrête sans rien dire.
  sys_qb_change_poll: async () => {
    const { pollQbChanges, changePollStatus } = await import('./qbChangePoll.js')
    const res = await pollQbChanges({ trigger: 'manuel' })
    return { ...res, ...changePollStatus() }
  },

  sys_qb_webhook: async () => {
    const { qbWebhookStatus } = await import('../routes/quickbooks-webhook.js')
    const st = qbWebhookStatus()
    return {
      ...st,
      summary: st.token_set
        ? `Jeton posé · dernier avis ${st.last_event ? `${st.last_event.entity} ${st.last_event.operation} le ${String(st.last_event.received_at).slice(0, 16).replace('T', ' ')}` : 'jamais reçu'}`
        : 'Jeton des avis absent — coller le « Verifier token » d\'Intuit dans Connecteurs → QuickBooks',
    }
  },
  // Miroir sortant : Boreal écrit le classeur, personne d'autre. Rien à
  // simuler — le passage ne touche que le classeur, jamais la base.
  sys_trx_sheet_mirror: async () => {
    const { syncMirror } = await import('./trxSheetMirror.js')
    return await syncMirror({ trigger: 'manuel', force: true })
  },
  // Rattachement des sorties connues au relevé : dry-run et run-now font la
  // même chose (le rattachement n'écrit qu'un lien, jamais une écriture
  // comptable) — on lance le passage et on rend ce qui a été rattaché.
  // Le moteur du rapprochement : un passage de tous les producteurs. Simuler =
  // produire sans rien enregistrer ; exécuter = enregistrer les propositions.
  // Dans les deux cas, AUCUNE écriture comptable ne part d'ici : ce sont des
  // propositions, et c'est un clic humain qui les applique.
  sys_bank_engine: async ({ dryRun }) => {
    const { runBankEngine } = await import('./bankProposals/engine.js')
    return await runBankEngine({ dryRun })
  },
  // Contrôles comptables : le passage de vérification. Simuler = calculer sans
  // rien enregistrer. Un contrôle ne corrige jamais rien — il constate.
  sys_audit_controles: async ({ dryRun }) => {
    const { runAudit } = await import('./audit/index.js')
    return await runAudit({ dryRun: !!dryRun, trigger: 'manuel' })
  },
  sys_bank_debit_link: async () => {
    const { linkKnownDebits, summarizeLinks } = await import('./bankDebitLink.js')
    const out = await linkKnownDebits()
    return { ...out, summary: summarizeLinks(out) }
  },
  // Fraîcheur du solde : dry-run = âge du dernier solde lu + état des
  // autorisations, sans notifier ; run-now = vérifie et notifie tout de suite,
  // sans attendre l'anti-spam.
  sys_plaid_silence_alert: async ({ dryRun }) => {
    const { checkBalanceFreshness, getBalanceAlertConfig, balanceVerdict, lastBankBalance, reauthVerdict, humanDuration } =
      await import('./plaidBalanceAlert.js')
    if (!dryRun) return await checkBalanceFreshness({ force: true, trigger: 'manuel' })
    const { listItems, itemHealth } = await import('../connectors/plaid.js')
    const cfg = getBalanceAlertConfig()
    const staleHours = Number(cfg.stale_hours) || 8
    const rows = []
    for (const item of listItems()) {
      let health
      try { health = await itemHealth(item.itemId) } catch (e) { health = { institution_name: item.institution_name, health_error: e.message } }
      const v = reauthVerdict(health)
      rows.push({ institution: health.institution_name, needs_reauth: !!health.needs_reauth, would_alert: !!v.alert, reason: v.reason || null })
    }
    const b = balanceVerdict(lastBankBalance(), { staleHours })
    return {
      config: cfg, connections: rows,
      balance: { read_at: b.read_at || null, amount: b.balance ?? null, age: b.hours != null ? humanDuration(b.hours) : null, would_alert: !!b.alert },
      summary: `Solde lu il y a ${b.hours != null ? humanDuration(b.hours) : 'jamais'}${b.alert ? ' — ALERTE' : ''}`
        + (rows.some((r) => r.would_alert) ? ` · à réautoriser : ${rows.filter((r) => r.would_alert).map((r) => r.institution).join(', ')}` : ''),
    }
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
  // Lecture bancaire Venn : dry-run = état par compte relié, sans appeler Venn ;
  // run-now = lecture immédiate de la fenêtre par défaut sur tous les comptes.
  sys_venn_sync: async ({ dryRun }) => {
    const { scheduledVennSync, vennSyncStatus, defaultWindow } = await import('./vennSync.js')
    if (dryRun) {
      const accounts = vennSyncStatus()
      const win = defaultWindow()
      return {
        accounts, window: win,
        summary: accounts.length
          ? accounts.map((a) => `${a.account_name}: ${a.venn_count} trx${a.last_txn_date ? `, dernière ${a.last_txn_date}` : ''}`).join(' · ')
            + ` — prochaine lecture du ${win.from} au ${win.to}`
          : 'aucun compte relié à Venn (à faire dans Connecteurs → Venn)',
      }
    }
    const results = await scheduledVennSync({ trigger: 'manuel' })
    return { results, summary: results.map((r) => r.error ? `${r.account || 'Venn'}: échec (${r.error})` : `${r.account}: ${r.inserted} nouvelle(s)`).join(' · ') || 'aucun compte relié' }
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
  // Agents autonomes : dry-run = agents qui se réveilleraient maintenant.
  sys_autonomous_agents: async ({ dryRun }) => {
    const { tickAutonomousAgents } = await import('./autonomousAgents.js')
    return tickAutonomousAgents({ dryRun })
  },
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
  // Feuille de temps → lignes des paies ouvertes (Airtable) : dry-run = ce qui
  // serait recopié, sans rien écrire.
  sys_timesheet_paie_sync: async ({ dryRun }) => {
    const { syncTimesheetsToPaies } = await import('./timesheetPaieSync.js')
    return await syncTimesheetsToPaies({ dryRun: !!dryRun, trigger: 'manuel' })
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
  sys_manychat_contacts: async ({ dryRun }) => {
    const { previewManychatSync, runManychatSync } = await import('./manychatSync.js')
    if (dryRun) return previewManychatSync()
    return await runManychatSync({ force: true, trigger: 'manuel' })
  },
  sys_instagram_segments: async ({ dryRun }) => {
    const { previewSegmentation, runSegmentation } = await import('./instagramSegments.js')
    if (dryRun) return previewSegmentation()
    return await runSegmentation({ force: true, trigger: 'manuel' })
  },
  sys_instagram_draft_write: async ({ dryRun }) => {
    const { previewDraftWriting, runDraftWriting } = await import('./instagramDrafts.js')
    if (dryRun) return previewDraftWriting()
    return await runDraftWriting({ force: true, trigger: 'manuel' })
  },
  sys_instagram_draft_send: async ({ dryRun }) => {
    const { previewDraftQueue, sendAllNow } = await import('./instagramDrafts.js')
    if (dryRun) return previewDraftQueue()
    return await sendAllNow()
  },
  sys_connector_session_health: async ({ dryRun }) => {
    const { previewSessionHealth, runSessionHealthCheck } = await import('./sessionHealth.js')
    if (dryRun) return previewSessionHealth()
    return await runSessionHealthCheck({ force: true, trigger: 'manuel' })
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
  {
    id: 'sys_treasury_sheet_mirror',
    name: 'Trésorerie BNC : Boréal met à jour le Sheet du solde disponible',
    description: 'Toutes les 20 minutes, reporte la projection de Boréal dans le fichier « Maintien du solde disponible BNC », onglet « Compte chèque ». Conserve le modèle : mouvements et formules de solde, solde de départ avec sa date réelle, sorties récurrentes et paie. Les sorties sont positives, les entrées négatives. La projection utilise le scénario certain et le même horizon que Boréal. Les anciennes lignes projetées sont remplacées, sans créer de paiement dans Boréal. Une sauvegarde initiale et la version précédente sont conservées sur le serveur. Simuler présente les changements sans écrire dans le fichier.',
    trigger_config: { kind: 'schedule', source: "cron '*/20 * * * *' (index.js) → treasurySheetMirror.js", summary: 'Boréal → Google Sheet, toutes les 20 minutes et au démarrage' },
    action_config: {},
    configurable: true,
    default_active: 1,
  },
  // `sys_slack_hardware_escalade` is now seeded as a field_rule (see
  // SYSTEM_FIELD_RULES below), not a hardcoded system automation. Its logs
  // remain linked through the same id for continuity.
  {
    id: 'sys_stripe_invoice_paid',
    name: 'Stripe invoice.paid → Facture',
    description:
      "À la réception d'un webhook Stripe invoice.paid, la table factures est mise à jour (status='Payé', total), rattachée à son entreprise (client Stripe, abonnement, courriel du contact, nom) et à son projet (soumission payée, autres factures de l'abonnement, seul projet de l'entreprise) quand le lien est vide et le candidat unique, et le PDF Stripe est téléchargé. " +
      "Idempotent : un second événement pour la même invoice met à jour la ligne existante (matching par invoice_id).",
    trigger_config: {
      kind: 'webhook',
      source: 'POST /api/stripe-webhooks',
      event: 'invoice.paid',
      summary: 'Webhook entrant Stripe sur événement invoice.paid',
    },
  },
  {
    id: 'sys_soumission_system_builder',
    name: 'Soumission payée → System builder',
    description:
      "Quand un client paie une soumission sur Stripe (bouton « S'abonner » ou « Acheter » du PDF), un System builder est créé avec les serres de la soumission (Chef de culture / Assistant), les extras de chaque serre et ceux du site. " +
      "Le client est ensuite redirigé vers le lien public du formulaire. Un seul formulaire par paiement. Désactivée : le client retombe sur l'ancien parcours post-paiement.",
    trigger_config: {
      kind: 'webhook',
      source: 'POST /api/stripe-webhooks + retour de Stripe (/erp/pay/soumission/:id/paye)',
      event: 'checkout.session.completed',
      summary: 'Paiement Stripe d’une soumission',
    },
    default_active: 1,
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
    id: 'sys_stripe_customer_link_by_email',
    name: 'Stripe client inconnu → entreprise par courriel',
    description:
      "Quand un webhook Stripe porte un client que Boréal ne connaît pas (paiement fait sur le site web), " +
      "son courriel est cherché dans les contacts : le client est rattaché à l'entreprise principale du contact (créée s'il n'en a pas). " +
      "Sinon le courriel des entreprises. Sinon un contact et une entreprise sont créés.",
    trigger_config: {
      kind: 'webhook',
      source: 'POST /api/stripe-webhooks',
      event: '*',
      summary: 'Tout webhook Stripe dont le client est inconnu',
    },
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
      source: 'setInterval 10 min (index.js) → services/pmtSuiviImport.js + POST /api/treasury/payments/import-sheet',
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
    id: 'sys_bill_payment_qb',
    name: 'Payer une facture dans Boréal la marque payée dans QuickBooks',
    description:
      "Quand une facture fournisseur est réglée depuis la page Paiements émis (bouton « J'ai payé » de la cédule, formulaire de paiement lié à une facture, ou facture passée à « Payée » dans Achats), l'écriture de paiement correspondante est créée dans QuickBooks : même fournisseur, même facture, la date d'émission du paiement, le compte bancaire réellement débité et le montant réellement sorti. La facture se ferme dans QuickBooks et redevient « Payée » dans l'ERP sans double saisie. " +
      "Un paiement PARTIEL est envoyé tel quel : QuickBooks laisse la facture ouverte pour le reste. " +
      "RIEN n'est envoyé si quoi que ce soit n'est pas certain — pas de facture liée, facture pas encore publiée dans QuickBooks, dépense déjà payée par construction, montant supérieur au solde dû, devise du paiement différente de celle de la facture (aucune conversion automatique), ou compte bancaire sans correspondance QuickBooks. Le paiement est alors créé quand même dans l'ERP, avec la raison écrite sur sa ligne et un bouton pour réessayer. " +
      "Les paiements qui VIENNENT de QuickBooks (détection du passage à la banque) ou de la feuille Pmt_Suivi ne sont jamais renvoyés : ils existent déjà dans les livres. " +
      "Supprimer le paiement dans l'ERP retire l'écriture de QuickBooks et rouvre la facture. QuickBooks refuse ce retrait quand l'écriture est déjà appariée à une opération bancaire téléchargée : l'ERP le dit, l'appariement se défait dans QuickBooks. " +
      "QuickBooks n'a que deux types de paiement de facture : c'est le genre du compte débité qui tranche (carte de crédit ou compte bancaire) ; « Interac », « virement » ou « code de paiement » restent lisibles dans le mémo de l'écriture. " +
      "since_date est la mise en service : AUCUN paiement émis avant cette date n'est envoyé, même à la main — les factures d'avant ont déjà été réglées directement dans QuickBooks et les repousser créerait un second paiement sur la même facture. " +
      "enabled_sources limite les origines de paiement qui déclenchent l'envoi ; allow_card_accounts=0 coupe l'envoi pour les règlements par carte de crédit.",
    trigger_config: {
      kind: 'event',
      source: 'services/treasuryPayments.js:createPayment → services/billPaymentQb.js:pushBillPayment',
      summary: "À chaque paiement émis lié à une facture fournisseur publiée dans QuickBooks",
    },
    action_config: {
      enabled_sources: 'manual,schedule,achat,card',
      allow_card_accounts: '1',
      since_date: '2026-09-16',
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
    name: 'Trésorerie BNC : ancien import du Sheet (remplacé par le miroir Boréal)',
    description: 'Ancien import du Google Sheet vers Boréal. Remplacé par « Boréal met à jour le Sheet du solde disponible ». Cet import ne peut plus être exécuté dès que le miroir sortant est installé, même si le miroir est mis en pause, pour éviter de réimporter la projection comme de nouveaux paiements.',
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
    default_active: 0,
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
    id: 'sys_bank_reconcile_nightly',
    name: 'Rapprochement bancaire : passe de nuit',
    description:
      "Chaque nuit, refait le rapprochement de tous les comptes, pour chaque mois terminé depuis « since » (AAAA-MM). " +
      "Ne corrige SEUL qu'un cas sûr à 100 % : la date QuickBooks d'un paiement ou d'un virement entre deux de nos comptes, quand les deux relevés s'accordent sur une autre date (1 à 5 jours d'écart), écriture pas encore rapprochée dans QuickBooks. Montants, comptes et taxes ne changent jamais. " +
      "Tout le reste (écart du mois, lignes sans vis-à-vis) est listé dans le journal, sans rien toucher. « Simuler » liste sans corriger.",
    trigger_config: {
      kind: 'schedule',
      source: "cron 0 7 * * * (index.js) → services/bankReconcileNightly.js",
      summary: 'Chaque nuit à 7 h UTC (3 h à Montréal), après le passage profond',
    },
    action_config: { since: '2026-06' },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_bank_qb_verify',
    name: 'Rapprochement bancaire : vérification QuickBooks',
    description:
      "LE moteur de vérification « est-ce comptabilisé ? » du rapprochement bancaire, pour TOUS les comptes mappés à QuickBooks (pas seulement ceux branchés à la banque). " +
      "Pour chaque transaction pas encore rapprochée, il cherche l'écriture correspondante dans le grand livre QuickBooks avec la recherche approfondie : tolérance de montant (frais, conversion), fenêtre de ±30 jours, virements comptabilisés du côté de l'autre compte, dépôts groupés. " +
      "Ce qui est certain se pose tout seul (auto_apply_methods) ; le reste devient une proposition à confirmer sur la page. AUCUNE écriture n'est publiée dans QuickBooks — la vérification lit, elle n'écrit jamais chez Intuit. " +
      "PASSAGE AU VERT (auto_reconcile) : une ligne jaune devient « rapprochée » dans Boréal quand son écriture est déjà rapprochée dans QuickBooks (qb_rapproche), ou quand l'écart relevé ↔ QuickBooks du compte est nul — toutes les jaunes jusqu'à la date du relevé (ecart_zero). Vider pour couper. Un rapprochement annulé à la main n'est jamais refait. " +
      "Il remplace à lui seul deux passages qui reconstruisaient le MÊME rapport de grand livre à trente secondes d'intervalle (la sync du fichier TRX_Orisha, coupée, et l'audit des comptes Plaid) : de ~72 rapports par heure à 12. " +
      "PASSAGE HORAIRE sur une fenêtre glissante de window_days (plancher de 30 jours : en deçà, l'orientation des signes ne peut plus être votée et les appariements s'inversent). " +
      "PASSAGE PROFOND chaque jour à 6 h UTC depuis deep_since : c'est le seul qui efface les liens devenus introuvables — sur une fenêtre courte, une écriture simplement hors fenêtre ferait effacer un lien valide. " +
      "La détection INSTANTANÉE, elle, ne vient pas d'ici mais des avis de QuickBooks (automation « avis QuickBooks » ci-dessous) : ce passage-ci est le filet.",
    trigger_config: {
      kind: 'schedule',
      source: "setInterval 60 min + cron 0 6 * * * (index.js) → services/bankQbVerify.js + bouton « Mettre à jour » de la page Rapprochement bancaire",
      summary: 'Passage horaire (fenêtre glissante) + passage profond quotidien à 6 h UTC',
    },
    action_config: {
      window_days: '90',
      grace_days: '4',
      auto_apply_methods: 'exact,conversion',
      deep_since: '2024-01-01',
      auto_reconcile: 'qb_rapproche,ecart_zero',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_bank_qb_reconcile_robot',
    name: 'Rapprochement bancaire : préparer le rapprochement dans QuickBooks (robot)',
    description:
      "Au clic « Préparer dans QuickBooks » (menu « ⋯ » de la page Rapprochement bancaire), un navigateur ouvre l'écran « Rapprocher » de QuickBooks avec la session envoyée par le module Chrome. " +
      "Il commence le rapprochement à la date du dernier solde imprimé du relevé (ou reprend celui déjà en cours), coche chaque écriture dont la ligne Boréal est verte — par l'id QuickBooks, sinon montant exact et date ±4 jours — puis lit la « Différence ». " +
      "Il ENREGISTRE POUR PLUS TARD et ne clique JAMAIS « Terminer » : c'est Charles qui ferme le mois (décision du 2026-09-26). Il ne décoche jamais rien et ne crée ni ne modifie aucune écriture. " +
      "Le résultat (différence, coches, lignes sans correspondance, capture) s'affiche à côté de l'écart. Session absente ou expirée : rien n'est tenté, la page le dit. Désactiver = le bouton répond « désactivé ».",
    trigger_config: {
      kind: 'manual',
      source: 'POST /api/bank/accounts/:id/qb-reconcile (routes/bank.js) → services/qbReconcileRobot.js reconcileAccount()',
      summary: 'Au clic « Préparer dans QuickBooks » sur /rapprochement',
    },
    action_config: {},
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_bank_statement_drive_watch',
    name: 'Rapprochement : relevés du Drive → QuickBooks',
    description:
      "Chaque matin, regarde le relevé PDF le plus récent de chaque compte dans le Drive partagé « Banque (relevés) ». " +
      "S'il est nouveau, Boréal le lit (sans importer ses lignes, déjà au compte), puis le robot prépare le rapprochement de ce compte dans QuickBooks : " +
      "date et solde de fin du relevé, coche ce qui y figure, décoche le reste (annulé si la différence s'éloigne de 0), puis « Enregistrer pour plus tard ». " +
      "Il ne clique JAMAIS « Terminer » — c'est Charles qui ferme le mois. Chaque compte part le jour où SON relevé arrive (MasterCard vers le 15-17). " +
      "Le résultat se voit dans l'onglet « Rapprocher (QBO) ».",
    trigger_config: {
      kind: 'schedule',
      source: 'cron 40 6 * * * (index.js) → services/bankStatementDriveWatch.js',
      summary: 'Tous les matins à 6 h 40 UTC',
    },
    action_config: {},
    default_active: 1,
  },
  {
    id: 'sys_bank_statement_drive_filing',
    name: 'Relevés déposés → rangés au Drive',
    description:
      "Quand un fichier déposé dans « Déposer » (rapprochement) est un relevé mensuel complet d'un compte — PDF, soldes vérifiés, " +
      "fin de période au jour de clôture du compte — Boréal le range dans le dossier Drive du compte, sous-dossier d'exercice (avril → mars), " +
      "au nom habituel du dossier (BNC_CAD_2026-09-30.pdf, CARTCRED_CREDCARD_4807_20261015.pdf, Venn Main CAD Statement - 2026-09.pdf…). " +
      "Jamais deux fois : un fichier identique ou un relevé de même date déjà dans le dossier suffit, le dépôt y est relié. " +
      "Le travail récurrent d'Antoine « Télécharger les relevés bancaires sur le Drive » montre les comptes qui manquent et se coche seul quand tout y est.",
    trigger_config: {
      kind: 'event',
      source: 'routes/bankStatements.js (fin de lecture d\'un dépôt) → services/bankStatementDriveFiling.js',
      summary: 'À chaque relevé déposé',
    },
    action_config: {},
    default_active: 1,
  },
  {
    id: 'sys_qb_change_poll',
    name: 'Rapprochement bancaire : interroger QuickBooks toutes les 30 secondes',
    description:
      "Toutes les 30 secondes, demande à QuickBooks la liste des écritures créées, modifiées ou " +
      "supprimées depuis le passage précédent, et traite chacune comme un avis reçu : la ligne du " +
      "relevé qui correspond passe à « comptabilisé » et l'écran bouge tout seul, en moins d'une minute. " +
      "C'est UN seul appel par passage, quel que soit le nombre de comptes — pas un rapport de grand livre. " +
      "Existe parce que les avis instantanés d'Intuit (sys_qb_webhook) n'arrivent pas : leur réglage vit " +
      "dans le portail développeur, sur une application qui n'a pas de clés de production, et seule leur " +
      "notification de test a jamais atteint l'ERP. Les deux voies peuvent tourner ensemble sans risque : " +
      "un même changement vu deux fois ne déclenche qu'une seule vérification. " +
      "La vérification complète du rapprochement (sys_bank_qb_verify) reste le filet horaire.",
    trigger_config: {
      kind: 'schedule',
      source: "setInterval 30 s (index.js) → services/qbChangePoll.js",
      summary: 'Interrogation toutes les 30 secondes',
    },
    action_config: {},
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_qb_webhook',
    name: 'Rapprochement bancaire : avis instantanés de QuickBooks',
    description:
      "QuickBooks nous prévient dès qu'une écriture bouge, au lieu qu'on aille le demander. Une dépense saisie dans QuickBooks fait passer la ligne du relevé au jaune en quelques secondes sur la page Rapprochement bancaire, sans aucun clic ; une écriture supprimée dans QuickBooks fait redevenir la ligne « à traiter ». " +
      "Entités suivies : dépense, dépôt, virement, écriture de journal, paiement de facture, paiement reçu, reçu de vente, remboursement, facture fournisseur. " +
      "À la réception, l'ERP lit UNE écriture (un appel léger, pas un rapport), en déduit le compte bancaire touché et relance la vérification sur ce compte-là seulement. Les avis sont regroupés : une saisie en lot dans QuickBooks ne déclenche qu'un passage par compte, au plus une fois par minute. " +
      "CE QU'IL FAUT POUR QUE ÇA MARCHE : chez Intuit (developer.intuit.com → l'app ERP → Settings → Webhooks, environnement Production), l'endpoint https://customer.orisha.io/erp/api/quickbooks/webhook, les entités ci-dessus cochées en Create / Update / Delete / Void / Merge, puis « Show token » et le Verifier token collé dans Connecteurs → QuickBooks → Jeton des avis. " +
      "Sans jeton, l'endpoint refuse tout (503) et la détection retombe sur le passage horaire. UN JETON RÉGÉNÉRÉ CHEZ INTUIT FERAIT TOMBER LES AVIS EN SILENCE : le bouton « Simuler » ci-dessous montre l'état du jeton et le dernier avis reçu — c'est là qu'on le voit.",
    trigger_config: {
      kind: 'event',
      source: 'POST /api/quickbooks/webhook (routes/quickbooks-webhook.js)',
      summary: "À chaque avis envoyé par QuickBooks (aucune cédule : c'est Intuit qui appelle)",
    },
    action_config: {},
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_trx_sheet_mirror',
    name: 'Rapprochement bancaire : miroir du relevé dans un Google Sheet',
    description:
      "Recopie le rapprochement bancaire de l'ERP dans un classeur Google — un onglet par compte, les lignes récentes en haut, et chaque ligne PEINTE selon son statut : vert rapprochée, jaune comptabilisée, bleu facture retracée, rouge à traiter, gris ignorée. Le code couleur est celui de l'ancien fichier TRX_Orisha, pour qu'il n'y ait rien à réapprendre. " +
      "LE SENS A ÉTÉ INVERSÉ LE 15 SEPTEMBRE 2026. Avant, les relevés étaient collés à la main dans TRX_Orisha.xlsx et coloriés à la main, et l'ERP lisait ce fichier. Maintenant les relevés entrent directement dans l'ERP (bouton « Déposer » de la page Rapprochement bancaire) et c'est BOREAL QUI A LE DERNIER MOT : il écrit les lignes et repeint les couleurs. " +
      "PERSONNE D'AUTRE NE DOIT ÉCRIRE DANS CE CLASSEUR : une ligne ajoutée ou une couleur posée à la main y sera effacée au passage suivant. " +
      "Le classeur est créé automatiquement au premier passage (son identifiant s'inscrit dans spreadsheet_id ci-dessous) et partagé au domaine orisha.io. C'est un classeur NEUF : l'ancien TRX_Orisha.xlsx du Drive n'est pas touché. " +
      "since_date borne ce qui est recopié — le classeur sert au suivi courant, l'historique complet reste dans l'ERP. Un onglet dont rien n'a changé depuis le dernier passage n'est pas réécrit.",
    trigger_config: {
      kind: 'schedule',
      source: 'setInterval 20 min (index.js) → services/trxSheetMirror.js + POST /api/bank/trx-sheet/mirror',
      summary: 'Miroir aux 20 minutes + bouton « Miroir » de la page Rapprochement bancaire',
    },
    action_config: {
      spreadsheet_id: '',
      google_account_email: 'michel@orisha.io',
      title: 'TRX Orisha — miroir Boreal',
      since_date: '2026-01-01',
    },
    configurable: true,
    // Allumée le 2026-09-15 : le classeur existe, quelqu'un le consulte encore,
    // et c'est maintenant le SEUL sens qui reste (la lecture du fichier est
    // coupée). Il se réécrit seul aux 20 minutes.
    default_active: 1,
  },
  {
    id: 'sys_bank_debit_link',
    name: 'Comptabilité : reconnaître au relevé les sorties déjà connues',
    description:
      "À chaque arrivée de transactions bancaires, reconnaît au relevé les sorties d'argent que l'ERP attendait déjà : le débit de la paie (libellé Nethris, 2 à 4 jours après la fin de période) et les versements des dettes à long terme (BDC, Ville de Québec, DEC). " +
      "DEPUIS LE 12 SEPTEMBRE 2026, ce passage ne rattache plus rien tout seul : il PROPOSE, et le rattachement se fait d'un clic sur la page Rapprochement bancaire (« C'est bien ça »). Le bouton « Lancer maintenant » ci-dessous, lui, reste un geste explicite et rattache directement. " +
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
    id: 'sys_audit_controles',
    name: 'Contrôles comptables : vérification quotidienne',
    description:
      "Passe en revue ce qui peut clocher dans la comptabilité et le garde en mémoire, sans rien corriger. "
      + "Aujourd'hui : deux lignes de relevé rattachées à la même écriture QuickBooks (le mouvement serait comptabilisé deux fois), une ligne du relevé importée en double, un lien vers une écriture qui n'existe plus, un type d'écriture que nous ne savons pas lire (ces écritures-là passaient pour manquantes), et un solde de compte qui ne tombe pas sur celui de QuickBooks. "
      + "Chaque constatation se voit sur le tableau de bord comptabilité ; « Ce n'en est pas un » l'écarte définitivement, et une constatation qui disparaît se règle toute seule. "
      + "Silencieux : aucun message, aucun courriel — la liste s'attend.",
    trigger_config: {
      kind: 'schedule',
      cron: '0 14 * * *',
      timezone: 'UTC',
      summary: 'Une fois par jour, à 10 h (Montréal)',
    },
    action_config: {
      // Mettre « off » sur un identifiant de contrôle pour l'éteindre.
      bank_lien_partage: 'on',
      bank_doublon_releve: 'on',
      bank_lien_introuvable: 'on',
      qb_type_inconnu: 'on',
      bank_ecart_solde: 'on',
      bank_rapprochement: 'on',
      bank_chaine_solde: 'on',
      // Écart de solde toléré avant de constater, en dollars.
      ecart_solde_seuil: '1',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_bank_engine',
    name: 'Rapprochement bancaire : le moteur des propositions',
    description:
      "Repasse sur les comptes bancaires et prépare tout ce qui peut l'être, sans jamais rien comptabiliser tout seul : la pièce que l'ERP possède déjà et qui va avec une ligne du relevé, le débit de la paie, un versement de dette, le prélèvement d'assurance collective à ventiler dans les comptes de salaires, un paiement émis qui vient de passer au compte, et — en dernier recours — la dépense sans facture dont le dossier est complet (fournisseur reconnu et compte de dépense connu, par une règle, un profil ou l'habitude). " +
      "Les trouvailles très sûres qui n'écrivent rien dans QuickBooks (paiement émis passé, débit de la paie, versement de dette) s'appliquent seules, marquées « auto » et annulables d'un clic (auto_accept_kinds, auto_accept_min_confidence ; vider = tout redemander). " +
      "Le reste est une proposition : chaque trouvaille s'affiche sur la ligne du relevé avec sa preuve, et c'est un clic qui l'applique. Deux d'entre elles publient dans QuickBooks quand on les accepte (l'assurance collective et la dépense sans facture) — jamais sans ce clic. " +
      "L'ordre des étapes compte : la pièce d'abord, les sorties connues d'avance ensuite, la dépense devinée en tout dernier ; chaque étape écarte les lignes qu'une précédente a déjà réclamées, pour qu'une même ligne ne reçoive jamais deux propositions contradictoires. " +
      "Le prélèvement d'assurance collective d'un mois ne peut plus partir deux fois : sa période sert de clé. " +
      "Un plafond de propositions ouvertes évite l'ensevelissement — au-delà, le moteur cesse de produire du dernier recours plutôt que d'empiler. " +
      "Ce passage ne relit jamais le grand livre QuickBooks : c'est la sync du fichier TRX_Orisha qui en dispose, toutes les 20 minutes, et qui pose les liens aux écritures. " +
      "« Simuler » montre ce qui serait proposé sans rien enregistrer.",
    trigger_config: {
      kind: 'schedule',
      cron: '0 9 * * *',
      timezone: 'UTC',
      summary: 'Chaque nuit — rattrapage pour ce qui change sans nouvelle transaction',
    },
    action_config: {
      kinds_enabled: 'doc_match,paie_debit,debt_payment,aga_repartition,payment_clear,vendor_expense',
      min_confidence_doc: '0.8',
      tie_margin: '0.05',
      max_open: '200',
      // Natures appliquées sans clic (jamais celles qui publient dans
      // QuickBooks) et leur seuil. Vider = tout redemander.
      auto_accept_kinds: 'payment_clear,paie_debit,debt_payment',
      auto_accept_min_confidence: '0.9',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_plaid_silence_alert',
    name: 'Alerte : le solde bancaire ne se relit plus',
    description:
      "Vérifie trois fois par jour que le solde bancaire lu au compte — celui dont vit la projection de trésorerie — a bien été rafraîchi récemment, et prévient dans Boréal (cloche de notification, plus Slack en message privé à Antoine Lambert — plus dans le canal comptabilité depuis le 2026-10-06) quand il est figé depuis plus longtemps que le seuil. " +
      "POURQUOI : un solde qui ne se relit plus ne fait aucun bruit — le dernier montant connu reste affiché comme s'il était d'aujourd'hui, et la projection comme l'écart de solde s'appuient dessus. " +
      "CE QUI N'EST PLUS SURVEILLÉ : la livraison des TRANSACTIONS par la banque connectée. Elle est coupée volontairement depuis le 12 septembre 2026 (le rapprochement est alimenté par le fichier TRX_Orisha) ; l'alerte criait pour un silence voulu. Décision de Charles le 2026-09-29. " +
      "Une autorisation expirée (la banque redemande de se connecter) est signalée à part et en priorité : elle ne se répare jamais toute seule, et plus rien n'est lu tant qu'elle dure. " +
      "Le seuil par défaut est de 8 heures — le solde est relu toutes les 10 minutes et ré-inscrit au moins toutes les 6 heures. La même alerte n'est pas répétée avant 24 heures. " +
      "Le journal reste silencieux quand tout va bien. « Simuler » montre l'âge du dernier solde lu sans notifier ; « Exécuter » vérifie et notifie immédiatement.",
    trigger_config: {
      kind: 'schedule',
      source: "cron '0 11,17,23 * * *' UTC (index.js) → services/plaidBalanceAlert.js",
      cron: '0 11,17,23 * * * UTC (7 h, 13 h et 19 h à Montréal)',
      summary: 'Trois vérifications par jour ; alerte si le solde n\'a pas été relu',
    },
    action_config: {
      stale_hours: '8',
      repeat_hours: '24',
      notify_roles: 'admin',
      slack_webhook_env: 'SLACK_WEBHOOK_PERSO',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_plaid_sync',
    name: 'Connexion bancaire : lecture du solde (Plaid)',
    description:
      "Toutes les 10 minutes, relit auprès de Plaid le solde disponible du compte BNC CAD utilisé par la projection de trésorerie. " +
      "LA LECTURE DES TRANSACTIONS EST COUPÉE depuis le 12 septembre 2026 : sur les dix comptes mappés, un seul recevait vraiment ses mouvements de la banque, et plus rien depuis le 31 août — c'est le fichier TRX_Orisha qui alimente le rapprochement bancaire, pour tous les comptes. Remettre « import_transactions » à 1 rallume la lecture des transactions (rien n'est perdu entre-temps : le curseur de la banque ne bouge pas). " +
      "Quand elle est rallumée : relit les nouvelles transactions de chaque institution connectée (BNC, Desjardins) et les verse dans le rapprochement bancaire. " +
      "Plaid prévient normalement l'ERP tout de suite (webhook) — ce passage est le FILET : un webhook perdu, une signature refusée ou une coupure réseau et les transactions cessaient d'arriver sans que rien ne le signale (c'est ce qui s'est produit début septembre 2026). " +
      "Lecture seule : aucune capacité de virement ou de paiement n'est demandée à la banque. " +
      "« Simuler » n'appelle pas la banque, il affiche l'état de la connexion compte par compte — dont les comptes mappés qui n'ont AUCUNE transaction, signe que la lecture a commencé avant que le compte soit associé : il faut alors relire tout l'historique depuis la page Connecteurs.",
    trigger_config: {
      kind: 'schedule',
      source: 'setInterval 30 min (index.js) → services/plaidSync.js + POST /api/plaid/sync/:itemId',
      summary: 'Lecture aux 10 minutes, en plus des avis instantanés de la banque (webhook)',
    },
    action_config: {
      // '0' = Plaid ne touche plus à bank_transactions (décision du
      // 2026-09-12 : la banque ne livrait pas). Seul le solde est lu.
      import_transactions: '0',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_venn_sync',
    name: 'Connexion bancaire : lecture des comptes Venn',
    description:
      "Une fois par jour, relit auprès de Venn les transactions des comptes Venn CAD et Venn USD et les verse dans le rapprochement bancaire, avec les soldes disponible et courant de chaque compte. " +
      "POURQUOI : Venn n'existait nulle part dans l'ERP. Les soldes se tenaient à la main dans le fichier « Maintien du solde disponible » et les deux comptes se rapprochaient à l'œil deux fois par semaine — pendant que la BNC, elle, arrivait toute seule. " +
      "LECTURE SEULE, sans exception : aucun paiement ni virement n'est jamais émis vers Venn, et aucune écriture QuickBooks n'est publiée automatiquement — publier reste un geste humain. " +
      "Aucune conversion de devise : les montants du compte USD restent en USD, la conversion trimestrielle ne bouge pas. " +
      "Relancer la lecture ne crée jamais de doublon : chaque transaction est reconnue par son identifiant chez Venn. C'est pour ça que la fenêtre relue est large (30 jours par défaut) — une transaction qui se pose en retard est rattrapée. " +
      "« Simuler » n'appelle pas Venn, il montre l'état de chaque compte relié ; « Exécuter » lit immédiatement.",
    trigger_config: {
      kind: 'schedule',
      source: "cron '0 5 * * *' UTC (index.js) → services/vennSync.js",
      cron: '0 5 * * * UTC (1 h à Montréal)',
      summary: 'Une lecture par jour, la nuit',
    },
    action_config: {
      // Rien à régler ici : la fenêtre relue et les adresses d'API vivent sur
      // le connecteur (Connecteurs → Venn), avec la clé.
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_receipt_bank_match',
    name: 'Rapprochement bancaire : apparier factures et sorties d’argent',
    description:
      "Rattache une facture de l'extracteur à la transaction bancaire qui porte son débit, DANS LES DEUX SENS. " +
      "À l'arrivée de transactions par la connexion bancaire Plaid : chaque nouvelle sortie d'argent cherche le document déjà dans l'ERP (achat, reçu, payout Stripe). Ce passage manquait — le collage manuel et la sync TRX_Orisha appariaient depuis toujours, Plaid non : sur les comptes BNC, une facture déjà extraite restait « à traiter » jusqu'à un clic sur « Rapprocher ». " +
      "À la fin d'une extraction : la facture qui vient d'être lue cherche à son tour le débit qui l'attendait au relevé — une facture arrivée par courriel ou déposée à la main APRÈS la sortie d'argent n'était jamais rattachée toute seule, l'import bancaire ne repassant pas sur une transaction déjà connue. " +
      "AUCUNE écriture QuickBooks n'est publiée : la ligne passe de « à traiter » à « facture reçue », publier reste un geste humain. " +
      "Rien n'est deviné : le libellé du relevé doit reconnaître le fournisseur (montant identique seul = refusé), la devise du compte doit être celle de la facture, deux candidats à égalité ⇒ rien n'est lié, et une transaction encore en attente à la banque est ignorée tant qu'elle n'est pas posée. " +
      "Un lien posé à la main n'est jamais défait.",
    trigger_config: {
      kind: 'event',
      source: 'services/plaidSync.js:importPlaidTransactions + services/saleReceiptExtraction.js:runExtractionAndUpdate',
      summary: "À chaque lot de transactions Plaid posées, et à la fin de chaque extraction de facture",
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
      "Une revue statique quotidienne analyse jusqu’à sept extraits tournants du code et propose au maximum trois correctifs avec une preuve, une solution et un test à effectuer. Le modèle reçoit les extraits sans exécuter de scripts ; aucun correctif ne démarre avant validation. " +
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
    id: 'sys_autonomous_agents',
    name: 'Travaux : réveil des agents autonomes',
    description:
      "Toutes les 10 minutes, chaque agent de l'onglet « Agents » de la page Travaux dont une heure de réveil vient de passer dépose un passage dans la file de travaux, avec sa mission en clair. " +
      "La file l'exécute comme n'importe quel item (pause, quota et postes respectés) ; l'historique des passages se lit dans la file. " +
      "Seul le dernier créneau échu compte, et seulement dans les 3 heures : un serveur arrêté ne relance pas de passages en rafale. " +
      "Un passage encore en file ou en attente de réponse bloque le suivant du même agent. " +
      "Désactiver cette automation endort tous les agents ; chaque agent a aussi son propre interrupteur.",
    trigger_config: {
      kind: 'schedule',
      source: 'cron */10 * * * * (index.js) → services/autonomousAgents.js',
      summary: 'Toutes les 10 minutes, selon les heures de chaque agent (Montréal)',
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
    id: 'sys_timesheet_paie_sync',
    name: 'Feuille de temps → heures des paies ouvertes (Airtable)',
    description:
      "Recopie les heures payables saisies dans la feuille de temps de Boréal (journées et semaines) dans la ligne de chaque employé des paies pas encore « Envoyés », puis dans Airtable (Items paie, Heures régulières). " +
      "Seuls les employés sans horaire fixe et qui ont saisi quelque chose dans Boréal sur la période sont touchés : les autres gardent les heures entrées dans Airtable. " +
      "Une ligne corrigée à la main dans Airtable depuis la dernière recopie est laissée telle quelle (signalée dans l'historique).",
    trigger_config: {
      kind: 'event',
      source: '30 s après une saisie dans la feuille de temps → services/timesheetPaieSync.js',
      summary: '30 secondes après une saisie dans la feuille de temps',
    },
    action_config: {},
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
      "PUBLICATIONS DES PARTENAIRES : « our_accounts » (par défaut @orisha_auto) dit quelles publications nous concernent. Une publication n'est lue que si un de ces comptes en est l'auteur OU le co-auteur — donc nos publications seules et nos collaborations, jamais une publication que le partenaire a faite de son côté. C'est ce qui évite de ramasser les commentateurs de leurs concours (« Subscribe ») ou de leurs appels à leur infolettre, qui ne sont pas nos prospects. Vider ce champ désactive le filtre et lit tout. " +
      "« Simuler » montre l'état de la configuration sans appeler Instagram ; « Exécuter » lance une tournée immédiate.",
    trigger_config: {
      kind: 'schedule',
      source: "cron 0 4,5 * * 1 UTC (index.js) → services/instagramCommentScrape.js",
      cron: "0 4,5 * * 1 UTC (minuit dans la nuit de dimanche à lundi à Montréal, en heure d'été comme en heure d'hiver)",
      summary: 'Nuit de dimanche à lundi, minuit (Montréal)',
    },
    action_config: {
      accounts: 'orisha_auto, growingformarketmagazine',
      our_accounts: 'orisha_auto',
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
    id: 'sys_manychat_contacts',
    name: 'ManyChat : contacts et conversations',
    description:
      "Chaque matin, relit les contacts de ManyChat et rapatrie les conversations Instagram récentes dans Boréal. " +
      "RÈGLE DE TRI : un contact n'entre dans la liste de Philippe que si son nom d'usager Instagram est connu. ManyChat ne le révèle qu'au moment où la personne RÉPOND à notre message ; avant ça, la fiche serait un fantôme que personne ne peut ouvrir ni contacter. Les autres restent suivis en coulisse et basculent d'eux-mêmes dans la liste dès leur première réponse. " +
      "Les contacts déjà connus par la lecture des commentaires sont rapprochés par leur nom d'usager, jamais dédoublés — ManyChat et Instagram numérotent les mêmes personnes différemment, le nom d'usager est le seul lien fiable. " +
      "Une tournée qui ne ramène aucun contact est signalée comme une panne, jamais comme un compte vide. " +
      "PRÉREQUIS : une session ManyChat ouverte dans Connecteurs → ManyChat (sa page de connexion est protégée, on colle les témoins du navigateur). " +
      "« Simuler » montre l'état connu sans appeler ManyChat ; « Exécuter » lance une tournée immédiate.",
    trigger_config: {
      kind: 'schedule',
      source: 'cron 0 9,10 * * * UTC (index.js) → services/manychatSync.js',
      cron: '0 9,10 * * * UTC (5 h à Montréal)',
      summary: 'Tous les matins, avant la liste hebdomadaire',
    },
    action_config: { max_threads: '60' },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_instagram_segments',
    name: 'Instagram : trier par type de demande et \u00e9carter les robots',
    description:
      "Range chaque personne dans la pile qui lui correspond \u2014 elle a demand\u00e9 le coaching, elle fait pousser des fleurs, elle nous suit sans rien demander, ou autre chose \u2014 parce que ces trois-l\u00e0 n'appellent pas le m\u00eame message. " +
      "Les messages \u00e9crits d'avance partent de ces consignes : \u00ab msg_coach \u00bb, \u00ab msg_fleurs \u00bb, \u00ab msg_question \u00bb, \u00ab msg_commentaire \u00bb, \u00ab msg_abonne \u00bb, \u00e9ditables ici. " +
      "ROBOTS : chaque indice (vendeur d'abonn\u00e9s, arnaque de r\u00e9cup\u00e9ration de compte, lien de redirection, nom fabriqu\u00e9\u2026) vaut un poids ; au-del\u00e0 de \u00ab bot_threshold \u00bb la fiche est supprim\u00e9e et le nom d'usager ne peut plus revenir. Le mod\u00e8le tranche les cas moins nets. " +
      "SORTENT AUSSI DE LA LISTE : celles qui n'ont fait que r\u00e9pondre \u00e0 une story, et celles \u00e0 qui quelqu'un a d\u00e9j\u00e0 \u00e9crit de sa main depuis Instagram \u2014 elles reviennent d'elles-m\u00eames si elles r\u00e9\u00e9crivent. " +
      "PROFILS : avant le tri, lit le profil public de \u00ab profiles_per_run \u00bb personnes (bio, 12 derni\u00e8res publications et leurs images), relu au plus tous les \u00ab profile_refresh_days \u00bb jours ; \u00ab profile_model \u00bb en tire la phrase \u00ab Qui c'est \u00bb et l'activit\u00e9 principale. La pile \u00ab fleurs \u00bb exige que le profil le prouve. " +
      "Un type choisi \u00e0 la main dans la page Instagram n'est jamais r\u00e9\u00e9crit par ce passage.",
    trigger_config: {
      kind: 'schedule',
      source: 'cron 30 9,10 * * * UTC (index.js) \u2192 services/instagramSegments.js',
      cron: '30 9,10 * * * UTC (5 h 30 \u00e0 Montr\u00e9al)',
      summary: 'Tous les matins, avant l\u2019\u00e9criture des messages',
    },
    action_config: {
      model: 'gpt-4o-mini',
      max_per_run: '120',
      bot_threshold: '4',
      profiles_per_run: '25',
      profile_refresh_days: '30',
      profile_model: 'gpt-4o-mini',
      msg_coach:
        "Elle a demand\u00e9 le coaching. Confirme-lui qu'elle est au bon endroit, dis en une phrase ce qu'elle y trouve, et demande-lui o\u00f9 elle en est dans sa saison.",
      msg_fleurs:
        "Elle fait pousser des fleurs. Parle fleurs, pas l\u00e9gumes : parle-lui de ce que le contr\u00f4le du climat change pour une culture de fleurs, et demande-lui ce qu'elle cultive.",
      msg_abonne:
        "Elle nous suit sans rien avoir demand\u00e9. Aborde-la simplement, sans rien vendre, et demande-lui ce qu'elle cultive.",
      msg_question:
        "Elle pose une vraie question technique. Ne l'invente pas : propose une r\u00e9ponse prudente en une phrase, dis qu'un de nos gens va lui confirmer, et laisse la porte ouverte. Philippe relira.",
      msg_commentaire:
        "Elle a simplement r\u00e9agi \u00e0 une publication. Une phrase chaleureuse qui reprend ce qu'elle a dit, puis UNE question ouverte sur ce qu'elle cultive. Pas de lien, pas d'offre.",
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_instagram_draft_write',
    name: 'Instagram : écrire les messages d\u2019avance',
    description:
      "Chaque matin, écrit le message priv\u00e9 qui sera envoy\u00e9 \u00e0 chaque personne capt\u00e9e et qui n\u2019a pas encore \u00e9t\u00e9 contact\u00e9e. " +
      "Le mod\u00e8le re\u00e7oit ce que la personne a fait (son commentaire, sa r\u00e9ponse \u00e0 une story, son message), la conversation d\u00e9j\u00e0 tenue, et les r\u00e8gles d\u2019\u00e9criture ci-dessous \u2014 \u00e9ditables. " +
      "TRI AUTOMATIQUE : un message ordinaire part tout seul plus tard ; celui qui demande un jugement humain est mis de c\u00f4t\u00e9 et attend Philippe. Les cas mis de c\u00f4t\u00e9 se r\u00e8glent dans \u00ab review_rules \u00bb (retirer un mot = ce cas part tout seul). " +
      "Un seul message vivant par personne : relancer la r\u00e9daction ne fabrique jamais deux messages qui partiraient tous les deux. " +
      "\u00ab Simuler \u00bb dit combien de personnes attendent un message ; \u00ab Ex\u00e9cuter \u00bb lance une tourn\u00e9e d\u2019\u00e9criture imm\u00e9diate.",
    trigger_config: {
      kind: 'schedule',
      source: 'cron 0 10,11 * * * UTC (index.js) → services/instagramDrafts.js',
      cron: '0 10,11 * * * UTC (6 h à Montréal)',
      summary: 'Tous les matins, après la lecture de ManyChat',
    },
    action_config: {
      model: 'gpt-4o',
      temperature: '0.6',
      max_per_run: '40',
      rules:
        "Tu écris à la place de Philippe, cofondateur d'Orisha (contrôle du climat en serre). " +
        "Message privé Instagram : une ou deux phrases courtes, ton direct et chaleureux, tutoiement. " +
        "Pars de ce que la personne vient de faire, pose UNE question ouverte, ne vends rien. " +
        "Pas d'emoji en rafale, pas de lien sauf si on te le donne, pas de signature.",
      review_rules: 'question,prix,probleme_precis,deja_client,autre_langue,relance_sans_reponse',
    },
    configurable: true,
    default_active: 0,
  },
  {
    id: 'sys_instagram_draft_send',
    name: 'Instagram : faire partir les messages \u00e9crits',
    description:
      "RIEN ne part tout seul : c\u2019est le bouton \u00ab Envoyer maintenant \u00bb de la page Instagram qui lance la pile. Ce passage ne fait que la vider, un message \u00e0 la fois, espac\u00e9 de \u00ab spacing_seconds \u00bb secondes, pendant les heures et les jours indiqu\u00e9s. " +
      "POURQUOI L\u2019ESPACEMENT : vingt messages identiques en quelques secondes, c\u2019est le profil d\u2019un compte qu\u2019Instagram bloque. Le d\u00e9lai laisse aussi le temps de retenir un message avant qu\u2019il parte. " +
      "NE PARTENT JAMAIS SEULS : ceux mis de c\u00f4t\u00e9 \u00e0 l\u2019\u00e9criture, et ceux dont la fen\u00eatre de 24 h d\u2019Instagram est ferm\u00e9e \u2014 ils sont retenus avec la raison affich\u00e9e, jamais perdus. " +
      "\u00ab plafond du jour \u00bb limite le nombre total de messages envoy\u00e9s dans une journ\u00e9e. " +
      "\u00ab Simuler \u00bb montre la file sans rien envoyer ; \u00ab Ex\u00e9cuter \u00bb fait la m\u00eame chose que le bouton \u00ab Envoyer maintenant \u00bb.",
    trigger_config: {
      kind: 'schedule',
      source: 'cron * * * * * (index.js) → services/instagramDrafts.js',
      cron: 'chaque minute',
      summary: 'En continu pendant les heures d’envoi',
    },
    action_config: {
      spacing_seconds: '90',
      start_hour: '8',
      end_hour: '18',
      weekdays: '1,2,3,4,5',
      daily_cap: '40',
    },
    configurable: true,
    default_active: 0,
  },
  {
    id: 'sys_connector_session_health',
    name: 'Connecteurs : santé des sessions (Instagram, ManyChat…)',
    description:
      "Chaque matin, vérifie que les connexions empruntées à un navigateur (aujourd'hui Instagram) répondent encore, en appelant une adresse qui EXIGE d'être connecté. " +
      "POURQUOI : le fil public d'Instagram répond même avec un cookie mort — seule la lecture des commentaires est refusée. La tournée hebdomadaire se terminait donc en annonçant « 0 commentaire », statut succès, et trois semaines de prospects ont été perdues en silence (découvert le 12 septembre 2026). " +
      "Désormais : toute redirection vers une page de connexion est traitée comme une panne de session, jamais comme un résultat vide ; l'état de chaque session est conservé et affiché dans Connecteurs ; et cette vérification tourne même les jours sans tournée. " +
      "ALERTE : message privé Slack à Antoine Lambert (« slack_channel », résolu par courriel via le bot), le premier jour de panne puis une fois par jour tant que ce n'est pas réparé. RIEN n'est envoyé quand tout va bien — le silence veut dire que les connexions répondent. Un webhook reste possible en repli (« slack_webhook_url » / « slack_webhook_env »). " +
      "Une panne réseau ponctuelle est enregistrée comme « erreur » et non comme « session expirée » : inutile de recoller un cookie pour une coupure passagère. " +
      "« Simuler » montre le dernier état connu sans rien appeler ; « Exécuter » vérifie tout de suite.",
    trigger_config: {
      kind: 'schedule',
      source: 'cron 0 11 * * * UTC (index.js) → services/sessionHealth.js',
      cron: '0 11 * * * UTC (7 h à Montréal en été, 6 h en hiver)',
      summary: 'Tous les matins',
    },
    action_config: {
      connectors: 'instagram,manychat',
      slack_channel: 'antoine.lambert96@gmail.com',
      recipient: 'Antoine Lambert',
      slack_webhook_url: '',
      slack_webhook_env: 'SLACK_WEBHOOK_PHILIPPE',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_instagram_weekly_slack',
    name: 'Prospects Instagram : liste hebdomadaire à Philippe (Slack)',
    description:
      "Juste après la reconnexion d'Instagram (le samedi), et seulement si la lecture des commentaires a réussi, envoie à Philippe la liste des prospects Instagram captés depuis le dernier envoi : nom d'usager cliquable, mot-clé, date, DM envoyé ou non, réponse reçue ou non, et le lien vers la table Airtable où il édite le suivi. " +
      "Le message est DÉLIBÉRÉMENT COURT : la semaine en clair (« du 17 au 23 août »), le nombre de prospects, combien avec le mot-clé, combien de DM envoyés, combien ont répondu — puis deux liens, vers la page ERP et vers Airtable. " +
      "Le détail n'est pas recopié dans Slack : il vit là où Philippe travaille et coche « contacté », et un pavé serait périmé dès la première case cochée. Un message part même s'il n'y a aucun prospect — un silence serait indistinguable d'une panne. " +
      "Le backlog part en entier : un prospect non annoncé (panne Slack, canal manquant) repart au passage suivant, jamais perdu. Un seul envoi planifié par semaine, même si le serveur redémarre. " +
      "DESTINATAIRE : coller l'URL du webhook Slack de Philippe dans « slack_webhook_url » ci-dessous (aucune modification de server/.env nécessaire). À défaut, la variable d'environnement nommée dans « slack_webhook_env » est utilisée ; " +
      "si aucun canal n'est joignable, le message part sur le canal de repli (trésorerie) avec un préfixe d'avertissement, et si même le repli manque, une ERREUR est journalisée ci-dessous — l'envoi n'échoue jamais en silence. " +
      "Le bouton « Simuler » montre le message qui partirait sans l'envoyer ni marquer les fiches ; « Exécuter » envoie immédiatement (ignore le jour, l'heure et l'idempotence hebdomadaire).",
    trigger_config: {
      kind: 'schedule',
      source: 'reconnexion Instagram (services/instagramRefresh.js) → services/instagramProspects.js',
      cron: 'aucun — déclenché par la reconnexion Instagram',
      summary: 'Après la reconnexion Instagram, une fois par semaine',
    },
    action_config: {
      send_weekday: '6',
      send_hour: '20',
      slack_webhook_url: '',
      slack_webhook_env: 'SLACK_WEBHOOK_PHILIPPE',
      recipient: 'Philippe',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_missing_invoice_request',
    name: 'Factures manquantes : demande envoyée sur Slack',
    description:
      "Dans Transactions (/rapprochement), cocher des lignes du relevé et cliquer « Facture manquante » les inscrit dans la liste des factures manquantes. Une ligne en sort toute seule dès qu'une pièce lue par l'extracteur s'y rattache. " +
      "Le panneau « Factures manquantes » montre cette liste ; le bouton « Envoyer sur Slack » publie un message qui dit aux collègues quelles factures Charles cherche (date, fournisseur, montant, compte). " +
      "ENVOI 100 % MANUEL : rien ne part tout seul, aucun planificateur n'est branché dessus. " +
      "Décocher une facture dans le panneau la sort du message SANS la sortir de la liste. " +
      "DESTINATAIRE : « slack_channel » (« #questions-importantes ») passe par le bot Slack de l'ERP ; sinon l'URL de webhook entrant de « slack_webhook_url », ou le nom d'une variable d'environnement dans « slack_webhook_env ». " +
      "« intro » accepte {n} (nombre de factures), {s} (pluriel) et {total} ; « outro » est la dernière ligne du message. " +
      "Désactiver cette automation coupe l'envoi, pas la liste : les factures manquantes restent visibles dans le relevé.",
    trigger_config: {
      kind: 'app_event',
      source: 'pages/RapprochementBancaire.jsx → POST /bank/invoice-requests/send',
      summary: 'Clic sur « Envoyer sur Slack » dans le panneau des factures manquantes',
    },
    action_config: {
      slack_channel: '#questions-importantes',
      slack_webhook_url: '',
      slack_webhook_env: '',
      intro: 'Je cherche {n} facture{s} pour fermer les livres.',
      outro: '',
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
    id: 'sys_address_confirm',
    name: "Confirmation des adresses de livraison et de ferme auprès de l'API d'adresses",
    description:
      "Toute adresse de LIVRAISON ou de FERME créée ou modifiée est confirmée auprès de Google (Places) : l'adresse existe-t-elle, et sous quelle écriture officielle ? C'est le complément du vérificateur de forme (sys_address_check), qui lui ne fait aucun appel réseau. Les adresses de facturation ne sont pas confirmées. " +
      "À la création, le formulaire interroge l'API AVANT d'enregistrer : si Google propose une écriture différente, l'utilisateur choisit entre « Utiliser » (l'adresse normalisée remplace la saisie) et « Garder » (sa saisie est conservée telle quelle). Rien n'est jamais réécrit automatiquement. " +
      "À la modification (autosave de la fiche ou de la modale, sync Airtable, formulaire client), la confirmation part en tâche de fond et le verdict s'affiche sur la fiche adresse, avec la proposition de Google et le bouton pour l'appliquer. " +
      "Anti-rappel : une empreinte du texte confirmé est mémorisée, donc une adresse dont la rue, la ville, la province, le code postal, le pays et le type n'ont pas bougé ne repart pas chez Google — un sync complet ne déclenche aucun appel. Les appels sont sérialisés et espacés (le serveur est mono-thread). " +
      "Verdicts : confirmée / à corriger (Google propose autre chose) / introuvable / incomplète (rue et ville requises) / vérification indisponible (clé ou API en erreur — jamais bloquant, l'enregistrement passe quand même). " +
      "types règle les types d'adresse concernés (par défaut « Livraison,Ferme »). " +
      "« Simuler » liste les adresses qui seraient interrogées ; « Exécuter » confirme celles dont le texte a changé depuis la dernière confirmation.",
    trigger_config: {
      kind: 'db_change',
      source: 'routes/projets.js POST/PUT /adresses + change_log(adresses) → services/addressCheck.js (watcher) → scheduleAddressConfirm()',
      summary: "Déclenché à chaque création / modification d'une adresse de livraison ou de ferme",
    },
    action_config: {
      types: 'Livraison,Ferme',
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
    id: 'sys_meeting_booking',
    name: 'Rendez-vous — confirmation au visiteur',
    description:
      "Quand un visiteur réserve, déplace ou annule un rendez-vous depuis une page publique (Marketing → Rendez-vous, lien /erp/rdv/<page>), " +
      "un courriel part de la boîte Gmail du propriétaire de la page : confirmation avec date, durée, lieu (lien Google Meet le cas échéant) et lien « Déplacer ou annuler ». " +
      "L'événement Google Agenda (avec invitation Google au visiteur) est créé, déplacé ou supprimé dans tous les cas quand le propriétaire a branché son agenda (Paramètres → Gmail) ; " +
      "sans agenda branché, le propriétaire reçoit le courriel en copie cachée. Désactivée : plus aucun courriel de confirmation, la réservation et l'agenda continuent.",
    trigger_config: {
      kind: 'manual',
      source: 'POST /api/public/meetings/:slug/book · /booking/:token/reschedule · /booking/:token/cancel → services/meetings.js',
      summary: 'Réservation, déplacement ou annulation par le visiteur (ou annulation depuis l’ERP)',
    },
    action_config: {},
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_meeting_reminders',
    name: 'Rendez-vous — rappels automatiques',
    description:
      "Chaque minute, envoie au visiteur le rappel des rendez-vous à venir selon les délais réglés sur chaque page (ex. 24 h et 1 h avant). " +
      "Un seul courriel par passage et par rendez-vous ; un rappel dont l'heure était déjà passée au moment de réserver n'est jamais envoyé. " +
      "Envoi depuis la boîte Gmail du propriétaire de la page. « Simuler » liste les rappels dus sans rien envoyer.",
    trigger_config: {
      kind: 'schedule',
      source: 'setInterval 60 s (index.js) → services/meetings.js runMeetingReminders',
      summary: 'Toutes les minutes',
    },
    action_config: {},
    configurable: true,
    default_active: 1,
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
    name: 'Instructions de retour au client (Gmail)',
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
    id: 'sys_fifo_cost',
    name: 'Coût unitaire FIFO des pièces',
    description:
      "Tient le « Coût unitaire (FIFO) » des pièces achetées (remplace l'automatisation Airtable). Chaque achat reçu est un lot " +
      "(quantité × prix unitaire : override payé, sinon facturé) ; le stock restant est fait des lots les plus récents, jusqu'à " +
      "couvrir la quantité en inventaire ; le coût est la moyenne pondérée de ces lots. Stock nul : prix du dernier lot. " +
      "Les pièces fabriquées (coût du BOM) et les logiciels sont exclus. " +
      "Recalcul à chaque écriture d'un achat ou d'une pièce (change_log), et passe complète toutes les heures qui relit d'abord " +
      "le prix de tous les achats dans Airtable. Un coût changé est écrit dans la pièce puis poussé vers Airtable. " +
      "Alertes par pièce : lot reçu sans prix (exclu de la moyenne), prix d'un lot très éloigné des autres achats (> 2,5× ou " +
      "< 0,4× la médiane — levée quand le prix est marqué vérifié sur la fiche pièce, tant qu'il ne change pas), stock sans aucun achat avec prix. Un stock supérieur aux achats reçus vient de l'inventaire de " +
      "départ : le surplus est valorisé au coût de départ saisi sur la fiche pièce, sinon au prix du plus ancien achat.",
    trigger_config: {
      kind: 'db_change',
      source: 'change_log(purchases, products) → fifoCostWatcher (poll 10s) + passe complète horaire',
      summary: "Réception ou modification d'un achat, changement de stock d'une pièce, et toutes les heures",
    },
    default_active: 1,
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
      "un changement d'idée client / fin d'abonnement, et pour un retour sans raison reconnue — UNE alerte par retour, même s'il " +
      "compte plusieurs articles reçus ensemble. Destinataire : « slack_channel » (message privé à Pierre-Alexandre par défaut). " +
      "Idempotent via return_items.reception_processed_at.",
    trigger_config: {
      kind: 'db_change',
      source: 'change_log(return_items) → returnItemReceivedWatcher (poll 5s)',
      summary: "Déclenché quand un item de retour passe reçu (received_at + received_by renseignés)",
    },
    action_config: {
      slack_channel: 'pap@orisha.io',
      slack_webhook_url: '',
      slack_webhook_env: '',
    },
    configurable: true,
  },
  {
    id: 'sys_partnership_hubspot',
    name: 'Programme partenaire : date dans HubSpot',
    description:
      "Quand un contact est associé à un abonnement qui contient le produit « Orisha partnership program », la fiche HubSpot du contact reçoit la date et l'heure du moment dans « subscribed_to_partnership_at ». " +
      "Peu importe comment le lien naît : synchro Stripe, contact choisi à la main, ou produit ajouté plus tard à l'abonnement. " +
      "Un seul envoi par couple abonnement/contact ; un échec reste dans l'historique et « Exécuter maintenant » le retente. " +
      "Le contact HubSpot est trouvé par son id HubSpot, sinon par son courriel. " +
      "Le signataire d'une page avec acceptation (noté sur la ligne du produit) est inscrit aussi, s'il diffère du contact de l'abonnement. " +
      "Plusieurs produits déclencheurs : ids Stripe (product_stripe_id) et noms (product_name) séparés par des virgules ; chaque id couvre aussi les versions du même produit dans les autres langues du Catalogue de vente. " +
      "Désactivée : rien n'est envoyé ; les liens faits pendant la pause partent à la réactivation.",
    trigger_config: {
      kind: 'db_change',
      source: 'partnershipHubspot (passe toutes les 30 s)',
      summary: 'Abonnement avec « Orisha partnership program » + contact associé',
    },
    action_config: {
      product_name: 'Orisha partnership program',
      product_stripe_id: 'prod_VJBPMtzzB2oUxF',
      hubspot_property: 'subscribed_to_partnership_at',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_facture_paid_slack',
    name: 'Facture payée : demande de lien au projet sur Slack',
    description:
      "Quand une facture passe à « Payé » — quelle qu'en soit l'origine : Stripe, paiement saisi dans l'ERP, sync QuickBooks ou Airtable — envoie un message Slack (canal #paiements par défaut) qui demande de lier la facture au projet, avec le lien vers la fiche de la facture. " +
      "Les factures d'ABONNEMENT sont ignorées, SAUF le premier paiement de l'abonnement (aucune autre facture payée, de montant non nul, plus ancienne sur le même abonnement). " +
      "Elles sont aussi annoncées quand un client approuve un ajout à son abonnement (contrat signé ou soumission) : le message commence alors par « upgrade_prefix ». " +
      "Une facture d'abonnement dont l'abonnement n'est pas encore synchronisé attend : elle sera tranchée à sa prochaine mise à jour. " +
      "Une facture à 0 $ n'envoie rien (skip_zero_amount=0 pour l'inclure). " +
      "Une facture dont TOUTES les lignes sont des produits exclus (excluded_products) n'envoie rien. " +
      "Chaque facture n'est tranchée qu'une fois (envoyée, ignorée ou en erreur) ; les factures déjà payées à la mise en service n'envoient jamais rien. " +
      "Le texte est modifiable dans « message » : {lien} = lien vers la facture, {numero} = numéro de la facture. " +
      "Désactivée : aucune alerte, et les factures payées pendant la pause ne sont pas rattrapées.",
    trigger_config: {
      kind: 'db_change',
      source: 'change_log(factures) → facturePaidSlackWatcher (poll 5s)',
      summary: 'Facture passée à « Payé », hors abonnement (sauf 1er paiement ou ajout)',
    },
    action_config: {
      slack_channel: '#paiements',
      slack_webhook_url: '',
      slack_webhook_env: '',
      paid_statuses: 'Payé, Payée',
      skip_zero_amount: '1',
      upgrade_prefix: "Ajout à l'abonnement.",
      excluded_products: '[]',
      message:
        'Une facture a été payée.\n' +
        'SVP liez la facture au projet : {lien}\n' +
        'Et suivez la procédure inscrite sur la fiche de la facture.\n' +
        "S'il s'agit d'un rachat d'équipement en abonnement, n'oubliez pas d'annuler / modifier l'abonnement et de changer l'état des numéros de série concernés.",
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_project_auto_close',
    name: 'Projets : fermeture automatique après 30 jours',
    description:
      "Chaque matin (6 h 15 à Montréal), ferme les projets encore ouverts (champ « Vendu » vide) dont la date de création remonte à « days » jours ou plus. " +
      "Fermer = Vendu « Non », Raison du refus « reason » (« Fermeture automatique » par défaut), Fermeture = la date du jour si elle était vide. Le changement est aussi poussé dans Airtable. " +
      "Un projet déjà marqué Vendu (Oui ou Non) n'est jamais touché. Un jour manqué est rattrapé au passage suivant. " +
      "Le journal ne reçoit que les passages qui ont fermé quelque chose. « Simuler » liste les projets qui seraient fermés ; « Exécuter » les ferme tout de suite.",
    trigger_config: {
      kind: 'schedule',
      source: "cron '15 10 * * *' UTC (index.js) → services/projectAutoClose.js",
      cron: '15 10 * * * UTC (6 h 15 à Montréal en été)',
      summary: 'Tous les matins',
    },
    action_config: {
      days: '30',
      reason: 'Fermeture automatique',
    },
    configurable: true,
    default_active: 1,
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
  {
    id: 'sys_soumission_link_click',
    name: 'Clic sur « S’abonner » / « Acheter » d’une soumission → fil d’activité',
    description:
      "Chaque ouverture d'un bouton « S'abonner » ou « Acheter » du PDF d'une soumission ajoute une note entrante " +
      "« Lien … ouvert » au fil d'activité du contact et de l'entreprise de la soumission. " +
      "Les clics faits depuis l'ERP lui-même (aperçu) et les robots de messagerie ne sont pas comptés.",
    trigger_config: {
      kind: 'app_event',
      source: 'GET /erp/pay/soumission/:id/:kind → services/soumissionLinkClick.js',
      summary: "Déclenché quand le client ouvre un bouton de paiement d'une soumission",
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_soumission_late_click_task',
    name: 'Clic tardif sur une soumission → tâche de relance',
    description:
      "Si le client ouvre « S'abonner » ou « Acheter » plus de delay_hours heures après le dernier envoi de la soumission, " +
      "une tâche « Relancer … » (priorité haute, échéance le jour même) est créée pour l'utilisateur assignee_email, " +
      "liée à l'entreprise et au contact. Une seule tâche ouverte à la fois par soumission.",
    trigger_config: {
      kind: 'app_event',
      source: 'GET /erp/pay/soumission/:id/:kind → services/soumissionLinkClick.js',
      summary: "Déclenché au clic sur un bouton de paiement, si l'envoi date de plus de delay_hours heures",
    },
    action_config: {
      assignee_email: 'philippe@orisha.io',
      delay_hours: '24',
    },
    configurable: true,
    default_active: 1,
  },
  {
    id: 'sys_payment_failed_task',
    name: 'Paiement refusé → tâche de suivi',
    description:
      "Quand la carte d'un client est refusée à l'ajout d'un produit à son abonnement existant (soumission « S'abonner » ou page avec acceptation), " +
      "rien n'est débité ni modifié et le client voit « Paiement refusé ». Une tâche « Paiement refusé — … » (priorité haute, échéance le jour même) " +
      "est créée pour l'utilisateur assignee_email, liée à l'entreprise et au contact, avec le message de Stripe. Une seule tâche ouverte à la fois par soumission ou acceptation.",
    trigger_config: {
      kind: 'app_event',
      source: 'POST /erp/pay/…/approuver → services/paymentFailedTask.js',
      summary: "Déclenché quand Stripe refuse la carte à l'approbation d'un ajout à l'abonnement",
    },
    action_config: {
      assignee_email: 'philippe@orisha.io',
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
// `sys_purchase_price_check` retirée le 2026-09-06 : elle comparait
// `purchases.unit_cost` aux autres achats du même `product_id`, deux colonnes
// droppées sur demande (migration 035). Sans prix ni pièce, il n'y a plus rien
// à vérifier.
// `sys_bank_trx_sheet` et `sys_plaid_qb_audit` retirées le 2026-09-15 : la
// lecture du fichier TRX_Orisha est coupée (les relevés entrent par le dépôt de
// fichiers, et c'est Boréal qui écrit le classeur — voir sys_trx_sheet_mirror),
// et les deux audits QuickBooks n'en font plus qu'un, `sys_bank_qb_verify`.
const RETIRED_SYSTEM_AUTOMATION_IDS = [
  'sys_ctb_abonnements', 'sys_req_import', 'sys_weekly_review_slack', 'sys_purchase_price_check',
  'sys_bank_trx_sheet', 'sys_plaid_qb_audit',
  // Rappel « échange immédiat » : son éligibilité reposait entièrement sur
  // `returns.billed_at` et sur le contact du retour, deux colonnes détruites
  // par la migration 037. L'automatisation n'a jamais été activée.
  'sys_return_exchange_reminder',
  // Règle « Escalade Hardware → Slack » : le champ Escalade des billets a été
  // détruit définitivement (purge du 2026-09-24). Elle était déjà désactivée.
  'sys_slack_hardware_escalade',
  // Synchro feuille de temps ↔ feuille mensuelle du Drive : retirée à la
  // demande de Pierre-Alexandre Papillon (2026-10-07).
  'sys_rd_timesheet_sheet_sync',
  // Programme partenaire → HubSpot : reconstruite en automatisation en blocs
  // modifiable (Charles, 2026-10-09) — services/subscriptionProductTrigger.js.
  'sys_partnership_hubspot',
]

// Clés de réglage retirées d'une automatisation encore vivante (le passage a
// changé de surveillance). Nettoyées au démarrage, une seule fois.
const OBSOLETE_ACTION_KEYS = {
  // Surveillait le silence des transactions ; surveille maintenant la
  // fraîcheur du solde (2026-09-29).
  sys_plaid_silence_alert: ['silence_hours'],
}

// Anciennes valeurs par défaut retirées : vidées au démarrage seulement si
// l'utilisateur ne les a pas modifiées.
const RETIRED_ACTION_DEFAULTS = {
  // Antoine Lambert, 2026-10-07 : plus de dernière ligne au message.
  sys_missing_invoice_request: { outro: 'Si vous en avez une, répondez ici ou envoyez-la à factures@orisha.io — merci !' },
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
      name = CASE WHEN automations.name_custom = 1 THEN automations.name ELSE excluded.name END,
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
      name = CASE WHEN automations.name_custom = 1 THEN automations.name ELSE excluded.name END,
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
  // Réglages devenus sans objet : laissés dans le row, ils réapparaîtraient
  // comme champs éditables que le serveur refuserait ensuite de recevoir.
  for (const [id, keys] of Object.entries(OBSOLETE_ACTION_KEYS)) {
    const row = db.prepare('SELECT action_config FROM automations WHERE id = ?').get(id)
    if (!row) continue
    let cfg
    try { cfg = JSON.parse(row.action_config || '{}') } catch { continue }
    const dropped = keys.filter(k => k in cfg)
    if (!dropped.length) continue
    for (const k of dropped) delete cfg[k]
    db.prepare('UPDATE automations SET action_config = ? WHERE id = ?').run(JSON.stringify(cfg), id)
  }

  for (const [id, olds] of Object.entries(RETIRED_ACTION_DEFAULTS)) {
    const row = db.prepare('SELECT action_config FROM automations WHERE id = ?').get(id)
    if (!row) continue
    let cfg
    try { cfg = JSON.parse(row.action_config || '{}') } catch { continue }
    const hit = Object.keys(olds).filter(k => cfg[k] === olds[k])
    if (!hit.length) continue
    for (const k of hit) cfg[k] = ''
    db.prepare('UPDATE automations SET action_config = ? WHERE id = ?').run(JSON.stringify(cfg), id)
  }

  // Avant le retrait : l'équivalent en blocs reprend son état actif.
  migratePartnershipToBlocks()
  seedPartnershipLostFlow()
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
// `sys_slack_hardware_escalade` (Escalade Hardware → Slack) retirée le
// 2026-10-02 : le champ Escalade des billets a été détruit définitivement.
export const SYSTEM_FIELD_RULES = [
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
      name = CASE WHEN automations.name_custom = 1 THEN automations.name ELSE excluded.name END,
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
      "SELECT 1 FROM automations WHERE id = ? AND kind IN ('field_rule', 'flow')"
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
