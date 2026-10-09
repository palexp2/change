// Rangement des automatisations système sur la page (colonne de gauche).
export const SYSTEM_GROUPS = {
  "Ventes": [
    'sys_stripe_invoice_paid', 'sys_stripe_charge_refunded', 'sys_stripe_refunds_backfill',
    'sys_soumission_system_builder', 'sys_facture_paid_slack', 'sys_soumission_link_click',
    'sys_soumission_late_click_task', 'sys_meeting_booking', 'sys_meeting_reminders',
    'sys_partnership_hubspot', 'sys_payment_failed_task',
  ],
  "Expédition & retours": [
    'sys_shipment_tracking_email', 'sys_address_check', 'sys_return_label',
    'sys_return_instructions_email', 'sys_return_bulk_by_company', 'sys_return_item_created',
    'sys_return_item_received', 'sys_ups_return_label', 'sys_ups_return_label_email',
    'sys_purolator_tracking', 'sys_loomis_tracking', 'sys_order_item_shipped_cost',
    'sys_address_confirm',
  ],
  "Comptabilité": [
    'sys_stripe_batch_factures_sync', 'sys_stripe_bulk_bt_sync', 'sys_stripe_weekly_payout_push',
    'sys_revenue_recognition', 'sys_ctb_programmation_paiement', 'sys_paie_repartition',
    'sys_month_end_provisions', 'sys_marketing_expense_sync', 'sys_marketing_weekly_slack',
    'sys_pieces_disbursements', 'sys_fiscal_anomalies_sheet', 'sys_invoice_collection',
    'sys_digikey_orders', 'sys_bill_payment_qb', 'sys_audit_controles',
    'sys_missing_invoice_request', 'sys_fifo_cost', 'sys_timesheet_paie_sync',
  ],
  "Système": [
    'sys_airtable_webhook_router', 'sys_gmail_sync', 'sys_airtable_fallback_sync',
    'sys_airtable_token_refresh', 'sys_airtable_webhooks_init', 'sys_installation_followup',
    'sys_work_suggestions', 'sys_ticket_survey_slack', 'sys_trash_auto_cleanup',
    'sys_autonomous_agents', 'sys_project_auto_close',
  ],
  "Banque": [
    'sys_treasury_alert', 'sys_card_payment_reminder', 'sys_treasury_solde_sheet',
    'sys_carm_balance_alert', 'sys_treasury_qb_clear', 'sys_pmt_suivi_sheet',
    'sys_card_ceiling_alert', 'sys_plaid_sync', 'sys_bank_debit_link',
    'sys_plaid_silence_alert', 'sys_receipt_bank_match', 'sys_bank_engine',
    'sys_trx_sheet_mirror', 'sys_treasury_sheet_mirror', 'sys_bank_qb_verify',
    'sys_qb_webhook', 'sys_qb_change_poll', 'sys_venn_sync',
    'sys_bank_qb_reconcile_robot', 'sys_bank_statement_drive_watch', 'sys_bank_statement_drive_filing',
    'sys_bank_reconcile_nightly',
  ],
  "Instagram": [
    'sys_instagram_prospect_intake', 'sys_instagram_weekly_slack', 'sys_instagram_comment_scrape',
    'sys_connector_session_health', 'sys_manychat_contacts', 'sys_instagram_draft_write',
    'sys_instagram_draft_send', 'sys_instagram_segments',
  ],
}
const BY_ID = Object.fromEntries(Object.entries(SYSTEM_GROUPS).flatMap(([g, ids]) => ids.map(id => [id, g])))
export const groupOf = a => a.group_name || BY_ID[a.id] || (a.system ? 'Système' : 'Mes automatisations')
