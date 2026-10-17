import {
  Megaphone, TrendingUp, Hammer, Truck, LifeBuoy, Landmark, Banknote, Users, Cpu,
} from 'lucide-react'

// Carte des processus d'Orisha (page /processus) : chaque branche est un
// processus, chaque étape une page de Boréal, dans l'ordre où le travail
// s'enchaîne. `auto` = ids des automatisations (table `automations`) qui
// agissent à cette étape ; un id absent ou supprimé est simplement ignoré.
// Une automatisation qu'aucune étape ne cite tombe sur l'étape `autoRest`
// (Système → Automatisations) : la carte reste complète quand on en crée.
// `forms` = formulaires remplis à cette étape (clients ou équipe) ; `live`
// ajoute ceux tenus dans Boréal (formulaires HubSpot, pages de rendez-vous).
// `adminOnly` = page réservée aux admins, masquée aux autres.
// `accent` reprend la teinte de section du menu (cf. index.css, `--acc-*`).
export const PROCESSES = [
  { key: 'attirer', label: 'Attirer', icon: Megaphone, accent: 'marketing', steps: [
    { to: '/instagram', label: 'Instagram', auto: [
      'sys_instagram_comment_scrape', 'sys_instagram_prospect_intake', 'sys_instagram_segments',
      'sys_manychat_contacts', 'sys_instagram_draft_write', 'sys_instagram_draft_send',
      'sys_instagram_weekly_slack',
    ] },
    { to: '/formulaires', label: 'Formulaires', live: 'marketingForms' },
    { to: '/rendez-vous', label: 'Rendez-vous', live: 'meetingTypes',
      auto: ['sys_meeting_booking', 'sys_meeting_reminders'] },
    { to: '/courriels-marketing', label: 'Courriels' },
    { to: '/budget-marketing', label: 'Budget', auto: [
      'sys_marketing_expense_sync', 'sys_marketing_weekly_slack', 'sys_marketing_budget_sheet',
    ] },
  ] },
  { key: 'vendre', label: 'Vendre', icon: TrendingUp, accent: 'clients', steps: [
    { to: '/contacts', label: 'Contacts' },
    { to: '/companies', label: 'Entreprises', auto: ['sys_stripe_customer_link_by_email'] },
    { to: '/interactions', label: 'Interactions', auto: ['sys_gmail_sync'] },
    { to: '/qualification-call', label: 'Qualification', forms: [{ label: "Guide d'appel" }] },
    { to: '/pipeline', label: 'Projets', auto: ['auto_project_company_quote_sent', 'sys_project_auto_close'] },
    { to: '/discovery-forms', label: 'System builder', auto: ['sys_soumission_system_builder'],
      forms: [{ label: 'Formulaire de découverte' }] },
    { to: '/catalogue-vente', label: 'Soumission', auto: ['sys_soumission_link_click', 'sys_soumission_late_click_task'],
      forms: [{ label: 'Page hébergée' }] },
    { to: '/acceptations', label: 'Acceptations' },
    { to: '/abonnements', label: 'Abonnements', auto: [
      'auto_partnership_hubspot', 'auto_partnership_hubspot_lost', 'sys_partnership_hubspot',
      'sys_subscription_rachat',
    ] },
  ] },
  { key: 'fabriquer', label: 'Fabriquer', icon: Hammer, accent: 'inventaire', steps: [
    { to: '/purchases', label: 'Achats', auto: ['sys_digikey_orders'] },
    { to: '/fournitures', label: 'Fournitures' },
    { to: '/products', label: 'Pièces', auto: ['sys_fifo_cost'] },
    { to: '/stock-movement', label: 'Stock' },
    { to: '/priorite-assemblage', label: 'Priorité' },
    { to: '/assemblages', label: 'Assemblages' },
    { to: '/serials', label: 'Numéros de série' },
  ] },
  { key: 'livrer', label: 'Livrer', icon: Truck, accent: 'envois', steps: [
    { to: '/orders', label: 'Commandes', auto: [
      'sys_order_status', 'sys_order_welcome_email', 'sys_address_check', 'sys_address_confirm',
    ], forms: [{ label: 'Nouvelle commande' }] },
    { to: '/envois', label: 'Envois', auto: [
      'sys_order_item_shipped_cost', 'sys_revenue_recognition', 'sys_shipment_tracking_email',
      'sys_purolator_tracking', 'sys_loomis_tracking', 'sys_installation_followup',
    ], forms: [{ label: "Suivi d'installation (J+21)" }] },
  ] },
  { key: 'soutenir', label: 'Soutenir', icon: LifeBuoy, accent: 'outils', steps: [
    { to: '/tickets', label: 'Billets', auto: ['sys_ticket_survey_slack', 'sys_slack_hardware_escalade'],
      forms: [{ label: 'Nouveau billet' }, { label: 'Sondage de satisfaction' }] },
    { to: '/retours', label: 'Retours', auto: [
      'sys_return_item_created', 'sys_return_label', 'sys_ups_return_label', 'sys_ups_return_label_email',
      'sys_return_instructions_email', 'sys_return_item_received', 'sys_return_bulk_by_company',
      'auto_return_serial_status',
    ], forms: [{ label: 'Nouveau retour' }] },
    { to: '/problemes-operations', label: 'Problèmes' },
  ] },
  { key: 'encaisser', label: 'Encaisser', icon: Landmark, accent: 'compta', steps: [
    { to: '/factures', label: 'Factures', auto: [
      'sys_stripe_invoice_paid', 'sys_stripe_batch_factures_sync', 'sys_facture_paid_slack',
      'sys_stripe_charge_refunded', 'sys_stripe_refunds_backfill', 'sys_payment_failed_task',
    ] },
    { to: '/paiements', label: 'Paiements', forms: [{ label: 'Page de paiement' }] },
    { to: '/sale-receipts', label: 'Reçus de vente' },
    { to: '/stripe-payouts', label: 'Versements Stripe', auto: [
      'sys_stripe_weekly_payout_push', 'sys_stripe_bulk_bt_sync',
    ] },
    { to: '/revenus-reportes', label: 'Revenus reportés' },
  ] },
  { key: 'payer', label: 'Payer & rapprocher', icon: Banknote, accent: 'compta', steps: [
    { to: '/fournisseurs', label: 'Fournisseurs', auto: ['sys_fiscal_anomalies_sheet'] },
    { to: '/fournisseurs/achats', label: 'Factures fournisseurs', auto: [
      'sys_invoice_collection', 'sys_missing_invoice_request', 'sys_pieces_disbursements',
    ] },
    { to: '/paiements-emis', label: 'Paiements émis', auto: [
      'sys_bill_payment_qb', 'sys_treasury_qb_clear', 'sys_pmt_suivi_sheet', 'sys_ctb_programmation_paiement',
      'sys_treasury_alert', 'sys_treasury_solde_sheet', 'sys_card_payment_reminder', 'sys_card_ceiling_alert',
      'sys_carm_balance_alert',
    ] },
    { to: '/rapprochement', label: 'Banque', auto: [
      'sys_plaid_sync', 'sys_venn_sync', 'sys_plaid_silence_alert', 'sys_bank_engine',
      'sys_receipt_bank_match', 'sys_bank_debit_link', 'sys_bank_qb_verify', 'sys_plaid_qb_audit',
      'sys_qb_webhook', 'sys_qb_change_poll', 'sys_bank_qb_feed_match', 'sys_bank_qb_reconcile_robot',
      'sys_bank_statement_drive_watch', 'sys_bank_statement_drive_filing', 'sys_bank_reconcile_nightly',
      'sys_bank_trx_sheet', 'sys_trx_sheet_mirror', 'sys_treasury_sheet_mirror',
    ] },
    { to: '/fin-de-mois', label: 'Fin de mois', auto: ['sys_month_end_provisions', 'sys_audit_controles'] },
    { to: '/plan-comptable', label: 'Plan comptable', auto: ['sys_gl_mirror_sync'] },
    { to: '/grand-livre', label: 'Grand livre ↔ QBO', auto: ['sys_gl_reconciliation'] },
  ] },
  { key: 'equipe', label: 'Équipe', icon: Users, accent: 'rh', steps: [
    { to: '/employees', label: 'Employés', auto: ['sys_conge_slack'] },
    { to: '/feuille-de-temps', label: 'Feuille de temps', auto: [
      'sys_timesheet_paie_sync', 'sys_rd_timesheet_sheet_sync',
    ] },
    { to: '/heures-rsde', label: 'Heures RSDE' },
    { to: '/paies', label: 'Paies', auto: ['sys_paie_repartition'] },
  ] },
  { key: 'systeme', label: 'Système', icon: Cpu, accent: 'brand', steps: [
    { to: '/connectors', label: 'Connecteurs', auto: [
      'sys_airtable_webhooks_init', 'sys_airtable_webhook_router', 'sys_airtable_token_refresh',
      'sys_airtable_fallback_sync', 'sys_connector_session_health',
    ] },
    { to: '/travaux', label: 'Travaux', adminOnly: true, auto: ['sys_autonomous_agents', 'sys_work_suggestions'] },
    { to: '/parametres/corbeille', label: 'Corbeille', adminOnly: true, auto: ['sys_trash_auto_cleanup'] },
    { to: '/automations', label: 'Automatisations', adminOnly: true, autoRest: true },
  ] },
]
