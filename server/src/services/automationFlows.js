// Schéma en blocs des automatisations système (page Automatisations).
//
// Pour chaque automatisation système (hors retirées et hors
// sys_partnership_hubspot, reconstruite à part) : un déclencheur et ses actions,
// dans l'ordre d'exécution. `config` liste les clés réglables (action_config,
// voir CONFIGURABLE_SYSTEM_SPECS dans routes/automations.js) que le bloc expose ;
// '__trigger' = condition de déclenchement éditable, 'from' = expéditeur du
// courriel (SYSTEM_EMAIL_AUTOMATIONS).
export const SYSTEM_FLOWS = {
  sys_treasury_sheet_mirror: {
    trigger: { type: 'schedule', title: 'Toutes les 20 minutes', sub: 'Et au démarrage du serveur', config: [] },
    actions: [
      { type: 'find', title: 'Projection de trésorerie', sub: 'Scénario certain, horizon de Boréal', config: [] },
      { type: 'sheet', title: 'Mise à jour du Sheet', sub: 'Maintien du solde disponible BNC · Compte chèque', config: [] },
    ],
  },
  sys_stripe_invoice_paid: {
    trigger: { type: 'webhook', title: 'Quand Stripe confirme un paiement', sub: 'Stripe · facture payée', config: [] },
    actions: [
      { type: 'update', title: 'Facture marquée payée', sub: 'Factures · statut = Payé, total', config: [] },
      { type: 'find', title: 'Lien entreprise et projet', sub: 'Si le lien est vide et le candidat unique', config: [] },
      { type: 'stripe', title: 'Téléchargement du PDF', sub: 'PDF de la facture Stripe', config: [] },
    ],
  },
  sys_soumission_system_builder: {
    trigger: { type: 'webhook', title: 'Quand une soumission est payée', sub: 'Stripe · paiement de la soumission', config: [] },
    actions: [
      { type: 'create', title: 'Création du System builder', sub: 'Serres et extras de la soumission', config: [] },
      { type: 'other', title: 'Redirection du client', sub: 'Vers le formulaire public', config: [] },
    ],
  },
  sys_shipment_tracking_email: {
    trigger: { type: 'manual', title: 'Clic « Envoyer le suivi »', sub: 'Fiche envoi', config: [] },
    actions: [
      { type: 'email', title: 'Courriel de suivi', sub: 'Lien du transporteur, en français ou anglais', config: ['from'] },
      { type: 'create', title: 'Interaction courriel', sub: "Fil d'activité du contact", config: [] },
      { type: 'update', title: 'Envoi mis à jour', sub: "Envois · date d'envoi du suivi", config: [] },
    ],
  },
  sys_revenue_recognition: {
    trigger: { type: 'record', title: 'Quand un envoi est expédié', sub: 'Envois · statut = Envoyé', config: ['__trigger'] },
    actions: [
      { type: 'find', title: 'Factures de la commande', sub: 'Factures de commande pas encore constatées', config: [] },
      { type: 'qb', title: 'Écriture de constat de vente', sub: 'Dr 23900 ou comptes clients / Cr 40000', config: ['deferred_acctnum', 'sale_acctnum', 'ar_cad_acctnum', 'ar_usd_acctnum'] },
      { type: 'other', title: 'Reprise en cas d’échec', sub: "Nouvel essai jusqu'au succès", config: [] },
    ],
  },
  sys_stripe_customer_link_by_email: {
    trigger: { type: 'webhook', title: 'Quand Stripe envoie un client inconnu', sub: 'Stripe · tout événement', config: [] },
    actions: [
      { type: 'find', title: 'Recherche par courriel', sub: 'Contacts, puis entreprises', config: [] },
      { type: 'create', title: 'Contact et entreprise', sub: "Créés si rien n'est trouvé", config: [] },
      { type: 'update', title: 'Client Stripe rattaché', sub: "Entreprises · client Stripe", config: [] },
    ],
  },
  sys_stripe_charge_refunded: {
    trigger: { type: 'webhook', title: 'Quand Stripe rembourse un paiement', sub: 'Stripe · paiement remboursé', config: [] },
    actions: [
      { type: 'find', title: 'Entreprise du client', sub: 'Client Stripe, sinon courriel ou nom', config: [] },
      { type: 'create', title: 'Facture de remboursement', sub: 'Factures · statut = Remboursement', config: [] },
    ],
  },
  sys_stripe_refunds_backfill: {
    trigger: { type: 'manual', title: 'Rattrapage lancé à la main', sub: 'Remboursements Stripe historiques', config: [] },
    actions: [
      { type: 'find', title: 'Remboursements synchronisés', sub: 'Transactions Stripe de remboursement', config: [] },
      { type: 'create', title: 'Factures de remboursement', sub: 'Une par remboursement, sans doublon', config: [] },
    ],
  },
  sys_stripe_bulk_bt_sync: {
    trigger: { type: 'manual', title: 'Synchro lancée à la main', sub: 'Tous les versements Stripe', config: [] },
    actions: [
      { type: 'stripe', title: 'Lecture des transactions', sub: 'Versements pas encore synchronisés', config: [] },
      { type: 'sync', title: 'Transactions enregistrées', sub: 'Frais, remboursements, litiges', config: [] },
    ],
  },
  sys_stripe_batch_factures_sync: {
    trigger: { type: 'manual', title: 'Synchro lancée à la main', sub: 'Page Stripe / QuickBooks', config: [] },
    actions: [
      { type: 'stripe', title: 'Lecture des factures Stripe', sub: 'Toutes les factures', config: [] },
      { type: 'sync', title: 'Mise à jour des factures', sub: 'Statut, total, devise, entreprise', config: [] },
    ],
  },
  sys_airtable_webhook_router: {
    trigger: { type: 'webhook', title: 'Quand Airtable signale un changement', sub: 'Airtable · avis de modification', config: [] },
    actions: [
      { type: 'airtable', title: 'Lecture des changements', sub: 'Créations, modifications, suppressions', config: [] },
      { type: 'sync', title: 'Synchro des modules touchés', sub: 'Projets, billets, commandes…', config: [] },
      { type: 'other', title: 'File de reprise', sub: 'Échecs retentés plus tard', config: [] },
    ],
  },
  sys_gmail_sync: {
    trigger: { type: 'schedule', title: 'Toutes les 3 minutes', sub: 'Boîtes Gmail connectées', config: [] },
    actions: [
      { type: 'find', title: 'Nouveaux courriels', sub: 'Toutes les boîtes connectées', config: [] },
      { type: 'create', title: 'Interactions et courriels', sub: 'Liés aux contacts et entreprises', config: [] },
      { type: 'create', title: 'Factures fournisseurs', sub: 'Libellé Factures ou factures@orisha.io', config: [] },
    ],
  },
  sys_airtable_fallback_sync: {
    trigger: { type: 'schedule', title: 'Une fois par jour', sub: 'Filet de sécurité des webhooks', config: [] },
    actions: [
      { type: 'sync', title: 'Synchro complète Airtable', sub: 'Tous les modules', config: [] },
      { type: 'other', title: 'Purge des journaux', sub: 'Journaux de synchro de plus de 7 jours', config: [] },
    ],
  },
  sys_airtable_token_refresh: {
    trigger: { type: 'schedule', title: 'Toutes les 10 minutes', sub: '', config: [] },
    actions: [
      { type: 'airtable', title: "Renouvellement de l'accès", sub: "Si l'accès expire dans moins de 15 min", config: [] },
    ],
  },
  sys_installation_followup: {
    trigger: { type: 'schedule', title: 'Tous les jours à 9 h', sub: 'Clients livrés il y a 21 jours', config: [] },
    actions: [
      { type: 'find', title: 'Nouveaux clients', sub: 'Une seule commande, jamais relancés', config: [] },
      { type: 'email', title: "Courriel de suivi d'installation", sub: "Contact de l'adresse de livraison", config: ['from'] },
      { type: 'task', title: 'Tâche si le client est bloqué', sub: 'Assignée à Marc-Antoine', config: [] },
    ],
  },
  sys_stripe_weekly_payout_push: {
    trigger: { type: 'schedule', title: 'Deux fois par jour', sub: '8 h et 18 h', config: [] },
    actions: [
      { type: 'stripe', title: 'Nouveaux versements Stripe', sub: 'Versements et transactions', config: [] },
      { type: 'qb', title: 'Dépôt QuickBooks', sub: 'CAD → BNC, USD → Venn USD', config: ['push_since', 'max_batch'] },
      { type: 'slack', title: 'Résumé Slack', sub: 'Seulement si un versement coince', config: ['stale_alert_days', 'slack_on_success', 'slack_webhook_env'] },
    ],
  },
  sys_ctb_programmation_paiement: {
    trigger: { type: 'event', title: 'Quand une facture à payer est ajoutée', sub: 'Achats · facture publiée, créée ou payée', config: [] },
    actions: [
      { type: 'sheet', title: 'Ligne dans CTB - Suivi', sub: 'Programmation des factures à payer', config: ['spreadsheet_id', 'sheet_name', 'section_header', 'paid_section_header', 'payment_weekday', 'google_account_email'] },
      { type: 'sheet', title: 'Facture payée cette semaine', sub: 'Ligne déplacée chez les payées', config: [] },
    ],
  },
  sys_treasury_alert: {
    trigger: { type: 'schedule', title: 'Tous les jours à 7 h 30', sub: 'Et à chaque saisie du solde', config: [] },
    actions: [
      { type: 'find', title: 'Projection du solde BNC', sub: 'Solde, versements, factures, sorties', config: ['threshold', 'horizon_days', 'alert_horizon_days', 'balance_stale_days'] },
      { type: 'slack', title: 'Alerte de découvert', sub: 'Seulement si découvert imminent', config: ['slack_negative_only', 'slack_negative_days', 'slack_urgent_days', 'stale_reminder_slack', 'variance_slack', 'slack_webhook_env'] },
    ],
  },
  sys_pmt_suivi_sheet: {
    trigger: { type: 'schedule', title: 'Toutes les 30 minutes', sub: 'Et bouton « Synchroniser la feuille »', config: [] },
    actions: [
      { type: 'sheet', title: "Lecture de l'onglet Pmt_Suivi", sub: 'CTB - Suivi', config: ['file_id', 'sheet_name', 'google_account_email', 'since_date'] },
      { type: 'update', title: 'Paiements émis', sub: 'Ajoutés ou cochés « passé à la banque »', config: [] },
    ],
  },
  sys_bill_payment_qb: {
    trigger: { type: 'event', title: 'Quand une facture est payée', sub: 'Paiements émis · facture publiée', config: [] },
    actions: [
      { type: 'qb', title: 'Paiement de facture QuickBooks', sub: 'Ferme la facture fournisseur', config: ['enabled_sources', 'allow_card_accounts', 'since_date'] },
      { type: 'update', title: 'Facture marquée payée', sub: 'Achats · statut = Payée', config: [] },
    ],
  },
  sys_treasury_qb_clear: {
    trigger: { type: 'schedule', title: 'Toutes les heures', sub: 'Et bouton « Synchroniser avec QuickBooks »', config: [] },
    actions: [
      { type: 'qb', title: 'Lecture du grand livre', sub: 'Écritures vues à la banque', config: [] },
      { type: 'update', title: 'Paiements cochés', sub: 'Paiements émis · passé à la banque', config: [] },
    ],
  },
  sys_treasury_solde_sheet: {
    trigger: { type: 'schedule', title: 'Toutes les heures', sub: 'Ancien import, remplacé par le miroir', config: [] },
    actions: [
      { type: 'sheet', title: 'Lecture du Sheet de solde', sub: 'Maintien du solde disponible BNC', config: [] },
      { type: 'create', title: 'Paiements importés', sub: 'Paiements émis', config: [] },
    ],
  },
  sys_carm_balance_alert: {
    trigger: { type: 'schedule', title: 'Tous les jours à 8 h', sub: 'Et à chaque import de relevé', config: [] },
    actions: [
      { type: 'find', title: 'Solde du compte CARM', sub: 'Ouverture + paiements − évaluations', config: ['opening_balance', 'opening_date', 'threshold'] },
      { type: 'slack', title: 'Alerte de solde bas', sub: 'Sous le seuil, au plus 1 fois par 20 h', config: ['slack_webhook_env'] },
      { type: 'qb', title: 'Écritures ASFC', sub: 'Au clic, depuis la page Douanes', config: ['ap_acctnum', 'duty_acctnum', 'interest_acctnum', 'penalty_acctnum', 'card_acctnum', 'bank_acctnum', 'clearing_acctnum', 'vendor_name', 'gst_tax_code_name', 'notax_tax_code_name', 'post_since', 'max_batch', 'delta_tolerance', 'broker_names'] },
    ],
  },
  sys_fiscal_anomalies_sheet: {
    trigger: { type: 'schedule', title: 'Deux fois par jour', sub: '', config: [] },
    actions: [
      { type: 'sheet', title: 'Lecture des anomalies fiscales', sub: 'Journal du mentor comptable', config: [] },
      { type: 'update', title: 'Profils fournisseurs', sub: 'Code de taxe et type de transaction', config: [] },
    ],
  },
  sys_digikey_orders: {
    trigger: { type: 'schedule', title: 'Tous les jours à 6 h', sub: 'Et bouton « Importer les commandes »', config: [] },
    actions: [
      { type: 'find', title: 'Commandes DigiKey', sub: 'Commandes facturées des derniers jours', config: ['lookback_days'] },
      { type: 'create', title: 'Facture fournisseur en brouillon', sub: 'Achats · lignes, taxes, PDF joint', config: ['vendor_name'] },
    ],
  },
  sys_invoice_collection: {
    trigger: { type: 'schedule', title: 'Tous les jours à 5 h', sub: 'Et bouton « Collecter »', config: [] },
    actions: [
      { type: 'find', title: 'Sorties sans facture', sub: 'Relevé · à traiter ou facture reçue', config: [] },
      { type: 'other', title: 'Téléchargement sur les portails', sub: 'Factures au montant exact', config: [] },
      { type: 'update', title: 'Transaction liée', sub: 'Relevé · facture reçue', config: [] },
    ],
  },
  sys_bank_reconcile_nightly: {
    trigger: { type: 'schedule', title: 'Chaque nuit à 3 h', sub: '', config: [] },
    actions: [
      { type: 'find', title: 'Rapprochement des mois terminés', sub: 'Tous les comptes', config: ['since'] },
      { type: 'qb', title: 'Correction de date', sub: 'Seulement les cas sûrs à 100 %', config: [] },
    ],
  },
  sys_bank_qb_verify: {
    trigger: { type: 'schedule', title: 'Toutes les heures', sub: 'Et passage profond chaque jour à 6 h', config: [] },
    actions: [
      { type: 'find', title: 'Recherche dans QuickBooks', sub: 'Grand livre, lignes non rapprochées', config: ['window_days', 'grace_days', 'deep_since'] },
      { type: 'update', title: 'Lignes appariées', sub: 'Sûres posées, autres proposées', config: ['auto_apply_methods'] },
      { type: 'update', title: 'Passage au vert', sub: 'Rapproché dans QuickBooks ou écart nul', config: ['auto_reconcile'] },
    ],
  },
  sys_bank_qb_reconcile_robot: {
    trigger: { type: 'manual', title: 'Clic « Préparer dans QuickBooks »', sub: 'Page Rapprochement bancaire', config: [] },
    actions: [
      { type: 'qb', title: 'Écran Rapprocher de QuickBooks', sub: 'Coche les lignes vertes', config: [] },
      { type: 'qb', title: 'Enregistrer pour plus tard', sub: 'Jamais « Terminer »', config: [] },
      { type: 'update', title: 'Résultat du rapprochement', sub: 'Différence, coches, capture', config: [] },
    ],
  },
  sys_bank_statement_drive_watch: {
    trigger: { type: 'schedule', title: 'Tous les matins à 6 h 40', sub: '', config: [] },
    actions: [
      { type: 'drive', title: 'Nouveau relevé dans le Drive', sub: 'Dossier Banque (relevés)', config: [] },
      { type: 'other', title: 'Lecture du relevé', sub: 'Date et solde de fin', config: [] },
      { type: 'qb', title: 'Rapprochement préparé', sub: 'Enregistré pour plus tard', config: [] },
    ],
  },
  sys_bank_statement_drive_filing: {
    trigger: { type: 'event', title: 'Quand un relevé est déposé', sub: 'Rapprochement · Déposer', config: [] },
    actions: [
      { type: 'drive', title: 'Relevé rangé au Drive', sub: "Dossier du compte, sous-dossier d'exercice", config: [] },
      { type: 'update', title: 'Travail récurrent coché', sub: 'Quand tous les relevés y sont', config: [] },
    ],
  },
  sys_qb_change_poll: {
    trigger: { type: 'schedule', title: 'Toutes les 30 secondes', sub: '', config: [] },
    actions: [
      { type: 'qb', title: 'Écritures modifiées', sub: 'Depuis le passage précédent', config: [] },
      { type: 'update', title: 'Lignes du relevé', sub: 'Passent à « comptabilisé »', config: [] },
    ],
  },
  sys_qb_webhook: {
    trigger: { type: 'webhook', title: 'Quand QuickBooks signale un changement', sub: "Avis instantané d'Intuit", config: [] },
    actions: [
      { type: 'qb', title: "Lecture de l'écriture", sub: 'Compte bancaire touché', config: [] },
      { type: 'update', title: 'Vérification du compte', sub: 'Lignes du relevé mises à jour', config: [] },
    ],
  },
  sys_trx_sheet_mirror: {
    trigger: { type: 'schedule', title: 'Toutes les 20 minutes', sub: 'Et bouton « Miroir »', config: [] },
    actions: [
      { type: 'sheet', title: 'Miroir du relevé', sub: 'Un onglet par compte, lignes colorées', config: [] },
    ],
  },
  sys_bank_debit_link: {
    trigger: { type: 'event', title: 'Quand des transactions arrivent', sub: 'Relevé bancaire, toute source', config: [] },
    actions: [
      { type: 'find', title: 'Sorties attendues', sub: 'Paie et versements de dettes', config: [] },
      { type: 'update', title: 'Proposition de rattachement', sub: "À confirmer d'un clic", config: [] },
    ],
  },
  sys_audit_controles: {
    trigger: { type: 'schedule', title: 'Tous les jours à 10 h', sub: '', config: [] },
    actions: [
      { type: 'find', title: 'Contrôles comptables', sub: 'Doublons, liens, écarts de solde', config: ['bank_lien_partage', 'bank_doublon_releve', 'bank_lien_introuvable', 'qb_type_inconnu', 'bank_ecart_solde', 'bank_rapprochement', 'bank_chaine_solde', 'ecart_solde_seuil'] },
      { type: 'update', title: 'Constatations enregistrées', sub: 'Tableau de bord comptabilité', config: [] },
    ],
  },
  sys_bank_engine: {
    trigger: { type: 'schedule', title: 'Chaque nuit', sub: '', config: [] },
    actions: [
      { type: 'find', title: 'Recherche de pièces et sorties', sub: 'Pièces, paie, dettes, assurance', config: ['kinds_enabled', 'min_confidence_doc', 'tie_margin', 'max_open'] },
      { type: 'create', title: 'Propositions sur le relevé', sub: "À accepter d'un clic", config: [] },
      { type: 'update', title: 'Application automatique', sub: 'Trouvailles très sûres, annulables', config: ['auto_accept_kinds', 'auto_accept_min_confidence'] },
    ],
  },
  sys_plaid_silence_alert: {
    trigger: { type: 'schedule', title: 'Trois fois par jour', sub: '', config: [] },
    actions: [
      { type: 'find', title: 'Âge du dernier solde lu', sub: 'Compte BNC CAD', config: ['stale_hours'] },
      { type: 'slack', title: 'Alerte solde figé', sub: 'Cloche Boréal et message privé', config: ['repeat_hours', 'notify_roles', 'slack_webhook_env'] },
    ],
  },
  sys_plaid_sync: {
    trigger: { type: 'schedule', title: 'Toutes les 10 minutes', sub: '', config: [] },
    actions: [
      { type: 'find', title: 'Lecture du solde BNC', sub: 'Solde disponible, banque connectée', config: [] },
      { type: 'sync', title: 'Lecture des transactions', sub: 'Coupée depuis le 12 septembre 2026', config: ['import_transactions'] },
    ],
  },
  sys_venn_sync: {
    trigger: { type: 'schedule', title: 'Une fois par jour, la nuit', sub: '', config: [] },
    actions: [
      { type: 'find', title: 'Lecture des comptes Venn', sub: 'Venn CAD et Venn USD', config: [] },
      { type: 'sync', title: 'Relevé bancaire', sub: 'Transactions et soldes', config: [] },
    ],
  },
  sys_receipt_bank_match: {
    trigger: { type: 'event', title: 'Quand une facture ou un débit arrive', sub: "Transactions bancaires ou fin d'extraction", config: [] },
    actions: [
      { type: 'find', title: 'Recherche du vis-à-vis', sub: "Facture ↔ sortie d'argent", config: [] },
      { type: 'update', title: 'Rattachement', sub: 'Transaction liée à la facture', config: [] },
    ],
  },
  sys_card_payment_reminder: {
    trigger: { type: 'schedule', title: 'Tous les jours à 8 h', sub: "Dernier jour travaillé avant l'échéance", config: [] },
    actions: [
      { type: 'find', title: 'Date du rappel', sub: 'Jour cible et jours travaillés', config: ['due_day', 'work_days'] },
      { type: 'slack', title: 'Rappel de paiement des cartes', sub: 'Message privé', config: ['cards', 'slack_webhook_env'] },
    ],
  },
  sys_card_ceiling_alert: {
    trigger: { type: 'schedule', title: 'Tous les jours à 8 h', sub: '', config: [] },
    actions: [
      { type: 'find', title: 'Solde des cartes', sub: 'QuickBooks + transactions en attente', config: ['acctnums', 'pending_lookback_days'] },
      { type: 'slack', title: 'Alerte plafond', sub: 'J-5 du prélèvement ou plafond franchi', config: ['lead_days', 'min_alert_amount', 'lead_always', 'slack_channel', 'slack_webhook_url', 'slack_webhook_env'] },
    ],
  },
  sys_pieces_disbursements: {
    trigger: { type: 'schedule', title: 'Le 7 de chaque mois à 9 h', sub: 'Mois qui vient de finir', config: [] },
    actions: [
      { type: 'qb', title: 'Calcul des déboursés', sub: 'Grand livre du stock de pièces', config: ['acctnum'] },
      { type: 'drive', title: 'Fichier Pièces_Déboursés', sub: 'Google Sheet dans le Drive', config: ['drive_folder_id', 'google_account_email'] },
      { type: 'slack', title: 'Message à Guillaume', sub: 'Envoyé au clic, après vérification', config: ['slack_webhook_env', 'recipient'] },
    ],
  },
  sys_work_suggestions: {
    trigger: { type: 'schedule', title: 'Tous les jours à 7 h', sub: '', config: [] },
    actions: [
      { type: 'create', title: 'Suggestions de chantiers', sub: "Jusqu'à 5, page Travaux", config: [] },
      { type: 'create', title: "Suggestions d'intégrations", sub: "Jusqu'à 3 logiciels à brancher", config: [] },
    ],
  },
  sys_autonomous_agents: {
    trigger: { type: 'schedule', title: 'Toutes les 10 minutes', sub: 'Selon les heures de chaque agent', config: [] },
    actions: [
      { type: 'create', title: 'Passage dans la file', sub: "Travaux · mission de l'agent", config: [] },
    ],
  },
  sys_month_end_provisions: {
    trigger: { type: 'schedule', title: 'Le 1er de chaque mois à 9 h', sub: 'Mois qui vient de finir', config: [] },
    actions: [
      { type: 'drive', title: 'Feuille de temps du mois', sub: 'Heures RS&DE par personne', config: [] },
      { type: 'other', title: 'Calcul des provisions', sub: 'Crédits R&D et subvention salariale', config: [] },
      { type: 'other', title: 'Avis aux admins', sub: 'Écritures prêtes à approuver', config: [] },
    ],
  },
  sys_timesheet_paie_sync: {
    trigger: { type: 'event', title: 'Après une saisie de temps', sub: 'Feuille de temps · 30 s après', config: [] },
    actions: [
      { type: 'update', title: 'Heures des paies ouvertes', sub: 'Employés sans horaire fixe', config: [] },
      { type: 'airtable', title: 'Copie dans Airtable', sub: 'Items paie · heures régulières', config: [] },
    ],
  },
  sys_paie_repartition: {
    trigger: { type: 'manual', title: 'Clic « Publier »', sub: 'Page Paies ou Dashboard comptabilité', config: [] },
    actions: [
      { type: 'find', title: 'Débit au relevé', sub: 'Paie et assurance collective', config: ['bank_account_name', 'bank_label_pattern', 'bank_window_before_days', 'bank_window_after_days', 'aga_bank_label_pattern', 'aga_bank_window_days'] },
      { type: 'qb', title: 'Dépense de paie', sub: 'Salaires payés depuis la BNC', config: ['bank_acctnum', 'salary_vendor_name', 'salary_taxcode', 'phone_taxcode'] },
      { type: 'qb', title: 'Répartition par département', sub: 'Écriture de journal, % réglables', config: ['splits', 'source_acctnum', 'phone_acctnum', 'phone_amount', 'meals_acctnum', 'reimb_acctnum'] },
      { type: 'qb', title: 'Dépense assurance collective', sub: 'AGA ventilée dans les salaires', config: ['aga_splits', 'aga_source_acctnum', 'aga_vendor_name', 'aga_taxcode', 'aga_memo'] },
    ],
  },
  sys_marketing_expense_sync: {
    trigger: { type: 'schedule', title: '5 fois par jour', sub: 'Aux 3 heures, de 6 h 30 à 18 h 30', config: [] },
    actions: [
      { type: 'qb', title: 'Lecture du grand livre', sub: 'Comptes de dépenses marketing', config: ['accounts', 'start_date', 'lookback_days'] },
      { type: 'create', title: 'Dépenses à valider', sub: 'Page Budget marketing', config: [] },
    ],
  },
  sys_marketing_weekly_slack: {
    trigger: { type: 'schedule', title: 'Chaque mardi à 16 h', sub: 'Jour réglable', config: [] },
    actions: [
      { type: 'find', title: 'Dépenses pertinentes validées', sub: 'Depuis le dernier envoi', config: [] },
      { type: 'slack', title: 'Message à Émilie', sub: 'Liste et total de la semaine', config: ['send_weekday', 'slack_webhook_env', 'recipient'] },
    ],
  },
  sys_instagram_prospect_intake: {
    trigger: { type: 'webhook', title: 'Quand ManyChat signale un échange', sub: 'Commentaire, message envoyé ou réponse', config: [] },
    actions: [
      { type: 'create', title: 'Prospect Instagram', sub: 'Ajouté ou mis à jour, sans doublon', config: ['keywords'] },
      { type: 'other', title: 'Réponse à ManyChat', sub: 'Envoyer le message privé ou non', config: [] },
    ],
  },
  sys_instagram_comment_scrape: {
    trigger: { type: 'schedule', title: 'Chaque lundi à minuit', sub: 'Jour et heure réglables', config: [] },
    actions: [
      { type: 'find', title: 'Commentaires des publications', sub: 'Comptes suivis, derniers jours', config: ['accounts', 'our_accounts', 'own_accounts', 'lookback_days', 'run_weekday', 'run_hour'] },
      { type: 'create', title: 'Prospects Instagram', sub: 'Tous les commentateurs, étiquetés', config: ['keywords'] },
    ],
  },
  sys_manychat_contacts: {
    trigger: { type: 'schedule', title: 'Tous les matins', sub: 'Avant la liste hebdomadaire', config: [] },
    actions: [
      { type: 'find', title: 'Contacts ManyChat', sub: 'Conversations Instagram récentes', config: ['max_threads'] },
      { type: 'sync', title: 'Prospects mis à jour', sub: "Seulement si le nom d'usager est connu", config: [] },
    ],
  },
  sys_instagram_segments: {
    trigger: { type: 'schedule', title: 'Tous les matins', sub: "Avant l'écriture des messages", config: [] },
    actions: [
      { type: 'find', title: 'Lecture des profils', sub: 'Profils Instagram des personnes', config: ['profiles_per_run', 'profile_refresh_days', 'profile_model'] },
      { type: 'update', title: 'Tri par type de demande', sub: 'Coaching, fleurs, abonné, autre', config: ['model', 'max_per_run', 'msg_coach', 'msg_fleurs', 'msg_question', 'msg_commentaire', 'msg_abonne'] },
      { type: 'other', title: 'Robots écartés', sub: 'Fiche supprimée au-delà du seuil', config: ['bot_threshold'] },
    ],
  },
  sys_instagram_draft_write: {
    trigger: { type: 'schedule', title: 'Tous les matins', sub: 'Après la lecture de ManyChat', config: [] },
    actions: [
      { type: 'create', title: 'Message rédigé', sub: 'Un par personne pas encore contactée', config: ['model', 'temperature', 'max_per_run', 'rules'] },
      { type: 'update', title: 'Tri des messages', sub: 'Cas délicats mis de côté pour Philippe', config: ['review_rules'] },
    ],
  },
  sys_instagram_draft_send: {
    trigger: { type: 'schedule', title: 'Chaque minute', sub: "Pendant les heures d'envoi", config: [] },
    actions: [
      { type: 'other', title: 'Envoi des messages Instagram', sub: 'Un à la fois, espacés, plafond du jour', config: ['spacing_seconds', 'start_hour', 'end_hour', 'weekdays', 'daily_cap'] },
    ],
  },
  sys_connector_session_health: {
    trigger: { type: 'schedule', title: 'Tous les matins', sub: '', config: [] },
    actions: [
      { type: 'find', title: 'Vérification des sessions', sub: 'Instagram, ManyChat…', config: ['connectors'] },
      { type: 'slack', title: 'Alerte session expirée', sub: 'Message privé, une fois par jour', config: ['slack_channel', 'recipient', 'slack_webhook_url', 'slack_webhook_env'] },
    ],
  },
  sys_instagram_weekly_slack: {
    trigger: { type: 'event', title: 'Après la reconnexion Instagram', sub: 'Une fois par semaine', config: [] },
    actions: [
      { type: 'find', title: 'Prospects de la semaine', sub: 'Depuis le dernier envoi', config: [] },
      { type: 'slack', title: 'Liste à Philippe', sub: 'Résumé court et deux liens', config: ['send_weekday', 'send_hour', 'slack_webhook_url', 'slack_webhook_env', 'recipient'] },
    ],
  },
  sys_missing_invoice_request: {
    trigger: { type: 'manual', title: 'Clic « Envoyer sur Slack »', sub: 'Panneau Factures manquantes', config: [] },
    actions: [
      { type: 'slack', title: 'Demande de factures', sub: '#questions-importantes', config: ['slack_channel', 'slack_webhook_url', 'slack_webhook_env', 'intro', 'outro'] },
    ],
  },
  sys_ticket_survey_slack: {
    trigger: { type: 'event', title: 'Quand un client répond au sondage', sub: 'Billets · sondage de satisfaction', config: [] },
    actions: [
      { type: 'slack', title: 'Alerte à Philippe', sub: 'Note basse, rappel demandé ou réponse modifiée', config: ['slack_channel', 'slack_webhook_url', 'slack_webhook_env', 'recipient', 'low_rating_max'] },
    ],
  },
  sys_address_confirm: {
    trigger: { type: 'record', title: 'Quand une adresse est modifiée', sub: 'Adresses · livraison ou ferme', config: [] },
    actions: [
      { type: 'other', title: 'Confirmation auprès de Google', sub: "L'adresse existe-t-elle ?", config: ['types'] },
      { type: 'other', title: 'Écriture officielle proposée', sub: 'Utiliser ou garder, jamais automatique', config: [] },
    ],
  },
  sys_address_check: {
    trigger: { type: 'record', title: 'Quand une adresse est enregistrée', sub: 'Adresses · toute origine', config: [] },
    actions: [
      { type: 'other', title: "Contrôle de l'adresse", sub: 'Champs, code postal, province', config: [] },
      { type: 'other', title: 'Avis d’adresse fautive', sub: 'Notification aux responsables', config: [] },
    ],
  },
  sys_airtable_webhooks_init: {
    trigger: { type: 'event', title: 'Au démarrage du serveur', sub: '5 secondes après', config: [] },
    actions: [
      { type: 'airtable', title: 'Inscription des webhooks', sub: "Réutilisés s'ils sont valides", config: [] },
    ],
  },
  sys_return_label: {
    trigger: { type: 'manual', title: "Clic « Générer l'étiquette »", sub: 'Fiche retour', config: [] },
    actions: [
      { type: 'find', title: 'Choix du transporteur', sub: 'Purolator au Canada, UPS aux États-Unis', config: [] },
      { type: 'other', title: "Achat de l'étiquette", sub: 'Novoxpress, PDF enregistré', config: [] },
      { type: 'update', title: 'Retour mis à jour', sub: 'Retours · étiquette de retour', config: [] },
    ],
  },
  sys_meeting_booking: {
    trigger: { type: 'event', title: 'Quand un visiteur réserve', sub: 'Réservation, déplacement ou annulation', config: [] },
    actions: [
      { type: 'email', title: 'Courriel de confirmation', sub: 'Depuis la boîte du propriétaire', config: [] },
      { type: 'other', title: 'Événement Google Agenda', sub: 'Créé, déplacé ou supprimé', config: [] },
    ],
  },
  sys_meeting_reminders: {
    trigger: { type: 'schedule', title: 'Toutes les minutes', sub: '', config: [] },
    actions: [
      { type: 'find', title: 'Rappels dus', sub: 'Délais réglés sur chaque page', config: [] },
      { type: 'email', title: 'Rappel au visiteur', sub: 'Depuis la boîte du propriétaire', config: [] },
    ],
  },
  sys_ups_return_label: {
    trigger: { type: 'manual', title: "Clic « Créer l'étiquette UPS »", sub: 'Fiche retour', config: [] },
    actions: [
      { type: 'other', title: "Achat de l'étiquette UPS", sub: "Payée par le compte UPS d'Orisha", config: [] },
      { type: 'update', title: 'Retour mis à jour', sub: 'Suivi, coût, service', config: [] },
    ],
  },
  sys_ups_return_label_email: {
    trigger: { type: 'manual', title: "Envoi de l'étiquette UPS", sub: 'Fiche retour, après 10 s', config: [] },
    actions: [
      { type: 'email', title: 'Courriel au client', sub: 'Étiquette UPS en pièce jointe', config: [] },
      { type: 'create', title: 'Interaction courriel', sub: "Fil d'activité du contact", config: [] },
      { type: 'update', title: 'Retour mis à jour', sub: "Date d'envoi de l'étiquette", config: [] },
    ],
  },
  sys_return_instructions_email: {
    trigger: { type: 'manual', title: 'Clic « Envoyer les instructions »', sub: 'Fiche retour', config: [] },
    actions: [
      { type: 'email', title: 'Instructions de retour', sub: 'Gabarit selon pays, langue et raison', config: [] },
      { type: 'create', title: 'Interaction courriel', sub: "Fil d'activité du contact", config: [] },
      { type: 'update', title: 'Retour mis à jour', sub: "Date d'envoi des instructions", config: [] },
    ],
  },
  sys_return_bulk_by_company: {
    trigger: { type: 'manual', title: 'Retour groupé de numéros', sub: 'Fiche entreprise · numéros de série', config: [] },
    actions: [
      { type: 'create', title: 'Dossier de retour', sub: 'Un article par numéro de série', config: [] },
      { type: 'update', title: 'Numéros de série', sub: 'Statut = En retour', config: [] },
    ],
  },
  sys_order_item_shipped_cost: {
    trigger: { type: 'record', title: 'Quand une ligne part dans un envoi', sub: 'Lignes de commande · envoi renseigné', config: ['__trigger'] },
    actions: [
      { type: 'update', title: 'Coût gelé à l’envoi', sub: 'Numéros de série + coût de la pièce', config: [] },
    ],
  },
  sys_fifo_cost: {
    trigger: { type: 'record', title: 'Quand un achat ou une pièce change', sub: 'Achats, Pièces · et toutes les heures', config: [] },
    actions: [
      { type: 'update', title: 'Coût unitaire FIFO', sub: 'Pièces · moyenne des lots restants', config: [] },
      { type: 'airtable', title: 'Coût poussé vers Airtable', sub: 'Pièces', config: [] },
    ],
  },
  sys_return_item_created: {
    trigger: { type: 'record', title: 'Quand un article de retour est créé', sub: 'Articles de retour', config: [] },
    actions: [
      { type: 'update', title: 'Numéro de série', sub: 'Statut = En retour', config: [] },
      { type: 'create', title: 'Commande de remplacement', sub: 'Si échange immédiat', config: [] },
      { type: 'slack', title: "Alerte d'erreur", sub: "Seulement en cas d'erreur", config: [] },
    ],
  },
  sys_return_item_received: {
    trigger: { type: 'record', title: 'Quand un article de retour est reçu', sub: 'Articles de retour · reçu le, reçu par', config: [] },
    actions: [
      { type: 'update', title: 'Instructions et numéro de série', sub: 'À analyser ou à reconditionner', config: [] },
      { type: 'slack', title: 'Alerte rembourser / désabonner', sub: 'Une par retour', config: ['slack_channel', 'slack_webhook_url', 'slack_webhook_env'] },
    ],
  },
  sys_facture_paid_slack: {
    trigger: { type: 'record', title: 'Quand une facture est payée', sub: 'Factures · statut = Payé', config: [] },
    actions: [
      { type: 'find', title: 'Filtre des factures', sub: 'Abonnement : 1er paiement ou ajout', config: ['paid_statuses', 'skip_zero_amount', 'excluded_products'] },
      { type: 'slack', title: 'Message #paiements', sub: 'Lier la facture au projet', config: ['slack_channel', 'message', 'upgrade_prefix', 'slack_webhook_url', 'slack_webhook_env'] },
    ],
  },
  sys_project_auto_close: {
    trigger: { type: 'schedule', title: 'Tous les matins à 6 h 15', sub: '', config: [] },
    actions: [
      { type: 'find', title: 'Projets ouverts trop anciens', sub: 'Vendu vide, créés il y a N jours', config: ['days'] },
      { type: 'update', title: 'Projet fermé', sub: 'Vendu = Non, raison inscrite', config: ['reason'] },
      { type: 'airtable', title: 'Copie dans Airtable', sub: 'Projets', config: [] },
    ],
  },
  sys_trash_auto_cleanup: {
    trigger: { type: 'schedule', title: 'Chaque nuit à 3 h 30', sub: 'Et au démarrage du serveur', config: [] },
    actions: [
      { type: 'other', title: 'Suppression définitive', sub: 'Corbeille, après N jours', config: ['retention_days'] },
    ],
  },
  sys_soumission_link_click: {
    trigger: { type: 'event', title: 'Quand un client ouvre un lien', sub: 'Soumission · S’abonner ou Acheter', config: [] },
    actions: [
      { type: 'create', title: "Note au fil d'activité", sub: 'Contact et entreprise', config: [] },
    ],
  },
  sys_soumission_late_click_task: {
    trigger: { type: 'event', title: 'Quand un client ouvre un lien', sub: "Soumission · longtemps après l'envoi", config: [] },
    actions: [
      { type: 'task', title: 'Tâche de relance', sub: "Priorité haute, échéance aujourd'hui", config: ['assignee_email', 'delay_hours'] },
    ],
  },
  sys_payment_failed_task: {
    trigger: { type: 'event', title: 'Quand Stripe refuse une carte', sub: 'Ajout à un abonnement', config: [] },
    actions: [
      { type: 'task', title: 'Tâche de suivi', sub: 'Priorité haute, avec le message Stripe', config: ['assignee_email'] },
    ],
  },
}
