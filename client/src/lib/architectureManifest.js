// ⚠️ FICHIER GÉNÉRÉ — ne pas éditer à la main.
// Source : client/scripts/gen-architecture.mjs (lancé en `prebuild`).
// Régénérer : cd client && node scripts/gen-architecture.mjs
export const architectureManifest = {
  "generatedAt": "2026-09-06T18:12:25.026Z",
  "stats": {
    "routes": 78,
    "pages": 70,
    "groups": 6,
    "api": 101,
    "tables": 158,
    "connectors": 9
  },
  "groups": [
    {
      "group": "Clients",
      "items": [
        {
          "to": "/contacts",
          "label": "Contacts",
          "component": "Contacts",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/contacts"
        },
        {
          "to": "/companies",
          "label": "Entreprises",
          "component": "Companies",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/companies"
        },
        {
          "to": "/pipeline",
          "label": "Projets",
          "component": "Pipeline",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        },
        {
          "to": "/tasks",
          "label": "Tâches",
          "component": "Tasks",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/tasks"
        },
        {
          "to": "/tickets",
          "label": "Billets",
          "component": "Tickets",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/tickets"
        },
        {
          "to": "/interactions",
          "label": "Interactions",
          "component": "Interactions",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/interactions"
        },
        {
          "to": "/qualification-call",
          "label": "Appels de qualification",
          "component": "QualificationCall",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        },
        {
          "to": "/relance-qualification",
          "label": "Relances qualification",
          "component": "RelanceQualification",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        },
        {
          "to": "/discovery-forms",
          "label": "System builder",
          "component": "DiscoveryForms",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/discovery-forms"
        },
        {
          "to": "/prospects-instagram",
          "label": "Prospects Instagram",
          "component": "InstagramProspects",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        }
      ]
    },
    {
      "group": "Transport",
      "items": [
        {
          "to": "/orders",
          "label": "Commandes",
          "component": "Orders",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/orders"
        },
        {
          "to": "/envois",
          "label": "Envois",
          "component": "Envois",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        },
        {
          "to": "/retours",
          "label": "Retours",
          "component": "Retours",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/retours"
        }
      ]
    },
    {
      "group": "Comptabilité",
      "items": [
        {
          "to": "/finance",
          "label": "Espace finance",
          "component": null,
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        },
        {
          "to": "/factures",
          "label": "Factures clients",
          "component": "Factures",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        },
        {
          "to": "/paiements",
          "label": "Paiements",
          "component": "Paiements",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        },
        {
          "to": "/items-vendus",
          "label": "Items vendus",
          "component": "ItemsVendus",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        },
        {
          "to": "/abonnements",
          "label": "Abonnements",
          "component": "Abonnements",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        },
        {
          "to": "/abonnements/mouvements",
          "label": "/abonnements/mouvements",
          "component": "AbonnementMouvements",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        },
        {
          "to": "/sale-receipts",
          "label": "Extraction de données",
          "component": "SaleReceipts",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/sale-receipts"
        },
        {
          "to": "/journal-entries",
          "label": "Écritures de journal",
          "component": "JournalEntries",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/journal-entries"
        },
        {
          "to": "/comptabilite/regles-serials",
          "label": "Mouvements numéros de série",
          "component": "SerialAccountingRules",
          "adminOnly": true,
          "hrOnly": false,
          "api": null
        },
        {
          "to": "/stock-movement",
          "label": "/stock-movement",
          "component": "StockMovements",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        }
      ]
    },
    {
      "group": "Inventaire",
      "items": [
        {
          "to": "/purchases",
          "label": "Achats",
          "component": "Purchases",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/purchases"
        },
        {
          "to": "/assemblages",
          "label": "Assemblages",
          "component": "Assemblages",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        },
        {
          "to": "/products",
          "label": "Pièces/Produits",
          "component": "Products",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/products"
        },
        {
          "to": "/serials",
          "label": "Numéros de série",
          "component": "SerialNumbers",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/serials"
        }
      ]
    },
    {
      "group": "RH",
      "items": [
        {
          "to": "/employees",
          "label": "Employés",
          "component": "Employees",
          "adminOnly": false,
          "hrOnly": true,
          "api": "/api/employees"
        },
        {
          "to": "/feuille-de-temps",
          "label": "Feuille de temps",
          "component": "FeuilleDeTemps",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        },
        {
          "to": "/codes-activite",
          "label": "/codes-activite",
          "component": "CodesActivite",
          "adminOnly": false,
          "hrOnly": true,
          "api": null
        },
        {
          "to": "/paies",
          "label": "Paies",
          "component": "Paies",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/paies"
        },
        {
          "to": "/banque-heures",
          "label": "/banque-heures",
          "component": "BanqueHeures",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        }
      ]
    },
    {
      "group": "Autres outils",
      "items": [
        {
          "to": "/priorite-assemblage",
          "label": "/priorite-assemblage",
          "component": "PrioriteAssemblage",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        },
        {
          "to": "/automations",
          "label": "Automatisations",
          "component": "Automations",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/automations"
        },
        {
          "to": "/connectors",
          "label": "Connecteurs",
          "component": "Connectors",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/connectors"
        },
        {
          "to": "/public-files",
          "label": "Fichiers publics",
          "component": "PublicFiles",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/public-files"
        }
      ]
    }
  ],
  "flat": [
    {
      "to": "/dashboard",
      "label": "Dashboard",
      "component": "Dashboard",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/dashboard"
    }
  ],
  "externals": [
    {
      "href": "https://customer.orisha.io/chatbot/admin",
      "label": "Admin Chatbot"
    }
  ],
  "offMenu": [
    {
      "to": "/login",
      "label": "Login",
      "component": "Login",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/setup",
      "label": "Setup",
      "component": "Setup",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/customer/post-payment",
      "label": "DiscoveryFormPage",
      "component": "DiscoveryFormPage",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/d/:token",
      "label": "DiscoveryFormPage",
      "component": "DiscoveryFormPage",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/s/:token",
      "label": "TicketSurvey",
      "component": "TicketSurvey",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/dashboard/:section",
      "label": "Dashboard",
      "component": "Dashboard",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/dashboard"
    },
    {
      "to": "/projects/fields",
      "label": "AirtableFieldsRedirect",
      "component": "AirtableFieldsRedirect",
      "adminOnly": true,
      "hrOnly": false,
      "api": "/api/projects"
    },
    {
      "to": "/airtable/fields/:module",
      "label": "AirtableFieldsRedirect",
      "component": "AirtableFieldsRedirect",
      "adminOnly": true,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/champs/:table",
      "label": "FieldConfig",
      "component": "FieldConfig",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/paiements-emis",
      "label": "PaiementsEmis",
      "component": "PaiementsEmis",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/fournisseurs",
      "label": "VendorProfiles",
      "component": "VendorProfiles",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/fournisseurs/achats",
      "label": "AchatsFournisseurs",
      "component": "AchatsFournisseurs",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/fournisseurs/abonnements",
      "label": "VendorSubscriptions",
      "component": "VendorSubscriptions",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/comptes-prepayes",
      "label": "PrepaidAccounts",
      "component": "PrepaidAccounts",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/inventaire-drive",
      "label": "DriveInventory",
      "component": "DriveInventory",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/tests-antoine",
      "label": "TestsAntoine",
      "component": "TestsAntoine",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/fin-de-mois",
      "label": "FinDeMois",
      "component": "FinDeMois",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/travaux",
      "label": "Travaux",
      "component": "Travaux",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/travaux"
    },
    {
      "to": "/dettes-lt",
      "label": "DettesLT",
      "component": "DettesLT",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/budget-marketing",
      "label": "MarketingBudget",
      "component": "MarketingBudget",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/comptabilite",
      "label": "ComptaDashboard",
      "component": "ComptaDashboard",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/finance/*",
      "label": "LegacyFinanceRedirect",
      "component": "LegacyFinanceRedirect",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/stripe-payouts",
      "label": "StripePayouts",
      "component": "StripePayouts",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/stripe-payouts"
    },
    {
      "to": "/rapprochement",
      "label": "RapprochementBancaire",
      "component": "RapprochementBancaire",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/admin",
      "label": "AdminRedirect",
      "component": "AdminRedirect",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/admin"
    },
    {
      "to": "/admin/:tab",
      "label": "AdminRedirect",
      "component": "AdminRedirect",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/admin"
    },
    {
      "to": "/activity",
      "label": "ActivityFeed",
      "component": "ActivityFeed",
      "adminOnly": true,
      "hrOnly": false,
      "api": "/api/activity"
    },
    {
      "to": "/parametres",
      "label": "Parametres",
      "component": "Parametres",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/parametres/:section",
      "label": "Parametres",
      "component": "Parametres",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/changelog",
      "label": "Changelog",
      "component": "Changelog",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/changelog"
    },
    {
      "to": "/architecture",
      "label": "Architecture",
      "component": "Architecture",
      "adminOnly": true,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/automations/:id",
      "label": "AutomationDetail",
      "component": "AutomationDetail",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/automations"
    },
    {
      "to": "/__boom",
      "label": "CrashTest",
      "component": "CrashTest",
      "adminOnly": true,
      "hrOnly": false,
      "api": null
    }
  ],
  "api": [
    "/api/achats-fournisseurs",
    "/api/activity",
    "/api/activity-codes",
    "/api/admin",
    "/api/agent",
    "/api/anomalies",
    "/api/attachments",
    "/api/auth",
    "/api/automations",
    "/api/bank",
    "/api/bons-livraison",
    "/api/bootstrap",
    "/api/calls",
    "/api/carm",
    "/api/catalog",
    "/api/changelog",
    "/api/comments",
    "/api/companies",
    "/api/connectors",
    "/api/contacts",
    "/api/custom-field-files",
    "/api/custom-fields",
    "/api/customer/post-payment",
    "/api/dashboard",
    "/api/digikey",
    "/api/discovery-forms",
    "/api/documents",
    "/api/drive-inventory",
    "/api/email-relance",
    "/api/email-tracking",
    "/api/employees",
    "/api/field-visibility-rules",
    "/api/form-configs",
    "/api/fx",
    "/api/hooks",
    "/api/hooks/telnyx",
    "/api/hour-bank",
    "/api/hub",
    "/api/hubspot",
    "/api/instagram",
    "/api/interaction-files",
    "/api/interactions",
    "/api/journal-entries",
    "/api/labels",
    "/api/lt-debts",
    "/api/mapaq",
    "/api/marketing-budget",
    "/api/month-end",
    "/api/notifications",
    "/api/novoxpress",
    "/api/novoxpress/labels",
    "/api/orders",
    "/api/paies",
    "/api/payments",
    "/api/places",
    "/api/plaid",
    "/api/plaid/webhook",
    "/api/prepaid",
    "/api/product-docs",
    "/api/product-images",
    "/api/products",
    "/api/projects",
    "/api/projets",
    "/api/public-files",
    "/api/public/installation-feedback",
    "/api/public/ticket-survey",
    "/api/purchases",
    "/api/qualification-calls",
    "/api/receipt-files",
    "/api/record-links",
    "/api/recordings",
    "/api/records",
    "/api/reports",
    "/api/retours",
    "/api/sale-receipts",
    "/api/scrapers",
    "/api/search",
    "/api/serials",
    "/api/shipments",
    "/api/side-effects",
    "/api/stock-movements",
    "/api/stripe-invoice-items",
    "/api/stripe-invoices",
    "/api/stripe-payouts",
    "/api/stripe-queue",
    "/api/stripe-subscriptions",
    "/api/stripe-webhooks",
    "/api/tasks",
    "/api/telemetry",
    "/api/tickets",
    "/api/timesheets",
    "/api/track",
    "/api/travaux",
    "/api/treasury",
    "/api/undo",
    "/api/ups",
    "/api/vacations",
    "/api/vendor-profiles",
    "/api/vendor-subscriptions",
    "/api/views",
    "/api/weather"
  ],
  "tables": [
    "achats_fournisseurs",
    "activity_code_users",
    "activity_codes",
    "activity_log",
    "adresses",
    "agent_tasks",
    "airtable_field_defs",
    "airtable_field_directions",
    "airtable_field_mappings",
    "airtable_frozen_columns",
    "airtable_module_config",
    "airtable_orders_config",
    "airtable_projets_config",
    "airtable_sync_config",
    "airtable_vendor_links",
    "airtable_webhooks",
    "airtable_writeback_guard",
    "assemblages",
    "attachments",
    "automation_deferred_candidates",
    "automation_logs",
    "automation_rule_fires",
    "automation_send_log",
    "automation_versions",
    "automations",
    "bank_accounts",
    "bank_import_batches",
    "bank_transactions",
    "base_connector_configs",
    "base_interaction_attachments",
    "base_interaction_links",
    "base_interactions",
    "bom_items",
    "calls",
    "card_ceiling_alerts",
    "card_ceilings",
    "card_payment_dues",
    "carm_allocations",
    "carm_transactions",
    "companies",
    "connector_config",
    "connector_oauth",
    "contact_companies",
    "contacts",
    "custom_field_links",
    "custom_fields",
    "customer_onboarding_responses",
    "customer_tech_info_responses",
    "detail_field_configs",
    "digikey_orders",
    "document_items",
    "drive_inventory_items",
    "drive_inventory_state",
    "drive_inventory_tabs",
    "drive_sync_state",
    "email_relance_overrides",
    "emails",
    "employees",
    "factures",
    "field_overrides",
    "field_visibility_rules",
    "fiscal_anomalies",
    "fx_rates",
    "gmail_sync_state",
    "hour_bank_entries",
    "hubspot_push_failures",
    "instagram_dm_threads",
    "instagram_prospect_events",
    "instagram_prospects",
    "interactions",
    "invoice_needs",
    "journal_entry_defaults",
    "lt_debt_payments",
    "lt_debts",
    "marketing_budget_lines",
    "marketing_expense_rules",
    "marketing_expenses",
    "meetings",
    "month_end_provision_months",
    "month_end_provisions",
    "notifications",
    "order_items",
    "orders",
    "paie_items",
    "paies",
    "payment_schedule_deferrals",
    "payments",
    "pending_invoices",
    "pieces_disbursements",
    "prepaid_accounts",
    "prepaid_amortizations",
    "prepaid_expenses",
    "prepaid_ledger_entries",
    "products",
    "projects",
    "public_files",
    "purchases",
    "qb_attachments",
    "qualification_calls",
    "rachat_detect_failures",
    "rd_month_hours",
    "record_comments",
    "recurring_outflows",
    "recurring_task_completions",
    "recurring_tasks",
    "return_items",
    "returns",
    "revenue_recognition_queue",
    "sale_receipt_events",
    "sale_receipts",
    "scraper_accounts",
    "scraper_documents",
    "scraper_runs",
    "serial_accounting_rules",
    "serial_numbers",
    "serial_state_changes",
    "shipments",
    "slow_page_loads",
    "soumissions",
    "stock_movements",
    "stripe_balance_transactions",
    "stripe_invoice_items",
    "stripe_invoice_queue",
    "stripe_payouts",
    "stripe_qb_tax_mapping",
    "subscription_current_items",
    "subscription_events",
    "subscriptions",
    "sync_log",
    "table_form_configs",
    "table_view_configs",
    "table_view_pills",
    "task_keywords",
    "tasks",
    "ticket_surveys",
    "tickets",
    "timesheet_days",
    "timesheet_entries",
    "transaction_anomalies",
    "transcription_jobs",
    "treasury_balances",
    "treasury_cleared_events",
    "treasury_payments",
    "treasury_snapshots",
    "users",
    "vacations",
    "vendor_duplicate_dismissals",
    "vendor_profiles",
    "vendor_subscriptions",
    "wage_subsidy_adjustments",
    "wage_subsidy_receipts",
    "webhook_failure_throttle",
    "webhook_sync_retry",
    "work_ideas",
    "work_prompt_messages",
    "work_prompts",
    "work_suggestion_messages",
    "work_suggestions"
  ],
  "connectors": [
    "airtable",
    "amazon",
    "configStore",
    "digikey",
    "google",
    "hubspot",
    "plaid",
    "quickbooks",
    "ups"
  ]
}
