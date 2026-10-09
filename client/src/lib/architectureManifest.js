// ⚠️ FICHIER GÉNÉRÉ — ne pas éditer à la main.
// Source : client/scripts/gen-architecture.mjs (lancé en `prebuild`).
// Régénérer : cd client && node scripts/gen-architecture.mjs
export const architectureManifest = {
  "generatedAt": "2026-10-09T23:38:05.257Z",
  "stats": {
    "routes": 105,
    "pages": 91,
    "groups": 7,
    "api": 121,
    "tables": 208,
    "connectors": 11
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
          "to": "/modeles-courriel",
          "label": "Modèles de courriel",
          "component": "EmailTemplates",
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
          "to": "/catalogue-vente",
          "label": "Catalogue de vente",
          "component": "StripeCatalog",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        },
        {
          "to": "/instagram",
          "label": "Instagram",
          "component": "Instagram",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/instagram"
        }
      ]
    },
    {
      "group": "Marketing",
      "items": [
        {
          "to": "/formulaires",
          "label": "Formulaires",
          "component": "MarketingForms",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        },
        {
          "to": "/rendez-vous",
          "label": "Rendez-vous",
          "component": "Meetings",
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
          "to": "/comptabilite",
          "label": "Espace finance",
          "component": "ComptaDashboard",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        }
      ]
    },
    {
      "group": "Atelier",
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
          "hrOnly": false,
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
          "to": "/heures-rsde",
          "label": "Heures RSDE",
          "component": "HeuresRsde",
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
          "adminOnly": true,
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
        },
        {
          "to": "/acceptations",
          "label": "Acceptations",
          "component": "Acceptations",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        },
        {
          "to": "/problemes-operations",
          "label": "/problemes-operations",
          "component": "OpsIssues",
          "adminOnly": false,
          "hrOnly": false,
          "api": null
        },
        {
          "to": "/fournitures",
          "label": "Fournitures",
          "component": "Fournitures",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/fournitures"
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
      "to": "/forgot-password",
      "label": "ForgotPassword",
      "component": "ForgotPassword",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/reset-password",
      "label": "ResetPassword",
      "component": "ResetPassword",
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
      "to": "/rdv/gestion/:token",
      "label": "MeetingBooking",
      "component": "MeetingBooking",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/rdv/:slug",
      "label": "MeetingBooking",
      "component": "MeetingBooking",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/contrat/:token",
      "label": "ContractSign",
      "component": "ContractSign",
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
      "to": "/orders/:id",
      "label": "OrderDetailPage",
      "component": "OrderDetailPage",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/orders"
    },
    {
      "to": "/soumissions/nouvelle",
      "label": "SoumissionCreate",
      "component": "SoumissionCreate",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/discovery-form-editor",
      "label": "DiscoveryFormEditor",
      "component": "DiscoveryFormEditor",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/comptabilite/regles-serials",
      "label": "SerialAccountingRules",
      "component": "SerialAccountingRules",
      "adminOnly": true,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/factures",
      "label": "Factures",
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
      "to": "/paiements-emis",
      "label": "PaiementsEmis",
      "component": "PaiementsEmis",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/items-vendus",
      "label": "ItemsVendus",
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
      "label": "AbonnementMouvements",
      "component": "AbonnementMouvements",
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
      "to": "/cartes-paiement",
      "label": "CartesPaiement",
      "component": "CartesPaiement",
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
      "to": "/tests-antoine/carte",
      "label": "ClientMap",
      "component": "ClientMap",
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
      "to": "/revenus-reportes",
      "label": "RevenusReportes",
      "component": "RevenusReportes",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/travaux",
      "label": "Travaux",
      "component": "Travaux",
      "adminOnly": true,
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
      "to": "/finance/*",
      "label": "LegacyFinanceRedirect",
      "component": "LegacyFinanceRedirect",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/sale-receipts",
      "label": "SaleReceipts",
      "component": "SaleReceipts",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/sale-receipts"
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
      "to": "/journal-entries",
      "label": "JournalEntries",
      "component": "JournalEntries",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/journal-entries"
    },
    {
      "to": "/stock-movement",
      "label": "StockMovements",
      "component": "StockMovements",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
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
      "to": "/regles-bancaires",
      "label": "ReglesBancaires",
      "component": "ReglesBancaires",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/rapprochement-qbo",
      "label": "QbReconcile",
      "component": "QbReconcile",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/codes-activite",
      "label": "CodesActivite",
      "component": "CodesActivite",
      "adminOnly": false,
      "hrOnly": true,
      "api": null
    },
    {
      "to": "/contacts/:id",
      "label": "ContactDetailPage",
      "component": "ContactDetailPage",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/contacts"
    },
    {
      "to": "/companies/:id",
      "label": "CompanyDetailPage",
      "component": "CompanyDetailPage",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/companies"
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
      "adminOnly": true,
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
    "/api/ai-usage",
    "/api/anomalies",
    "/api/attachments",
    "/api/attachments/airtable",
    "/api/audit",
    "/api/auth",
    "/api/automations",
    "/api/bank",
    "/api/bank/rules",
    "/api/bank/statements",
    "/api/bons-livraison",
    "/api/bootstrap",
    "/api/calls",
    "/api/carm",
    "/api/catalog",
    "/api/changelog",
    "/api/client-map",
    "/api/comments",
    "/api/companies",
    "/api/connectors",
    "/api/contacts",
    "/api/custom-field-files",
    "/api/custom-fields",
    "/api/customer/post-payment",
    "/api/dashboard",
    "/api/deferred-revenue",
    "/api/digikey",
    "/api/discovery-form-schema",
    "/api/discovery-forms",
    "/api/documents",
    "/api/drive-inventory",
    "/api/email-relance",
    "/api/email-templates",
    "/api/email-tracking",
    "/api/employees",
    "/api/field-visibility-rules",
    "/api/form-configs",
    "/api/fournitures",
    "/api/fx",
    "/api/hooks",
    "/api/hooks/telnyx",
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
    "/api/marketing-forms",
    "/api/meetings",
    "/api/month-end",
    "/api/notifications",
    "/api/novoxpress",
    "/api/novoxpress/labels",
    "/api/ops-issues",
    "/api/orders",
    "/api/paies",
    "/api/payment-cards",
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
    "/api/public/meetings",
    "/api/public/pages",
    "/api/public/ticket-survey",
    "/api/purchases",
    "/api/qualification-calls",
    "/api/quickbooks/webhook",
    "/api/receipt-files",
    "/api/record-links",
    "/api/recordings",
    "/api/records",
    "/api/reports",
    "/api/retours",
    "/api/sale-receipts",
    "/api/scrapers",
    "/api/scrapers/session-bridge/document",
    "/api/search",
    "/api/serials",
    "/api/shipments",
    "/api/side-effects",
    "/api/soumission-assets",
    "/api/stock-movements",
    "/api/stripe-catalog",
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
    "/api/venn",
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
    "ai_model_prices",
    "ai_usage_events",
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
    "audit_findings",
    "automation_deferred_candidates",
    "automation_logs",
    "automation_rule_fires",
    "automation_send_log",
    "automation_versions",
    "automations",
    "autonomous_agents",
    "bank_accounts",
    "bank_import_batches",
    "bank_proposals",
    "bank_rules",
    "bank_statement_uploads",
    "bank_transactions",
    "base_connector_configs",
    "base_interaction_attachments",
    "base_interaction_links",
    "base_interactions",
    "bom_items",
    "bridge_sessions",
    "calls",
    "card_ceiling_alerts",
    "card_ceilings",
    "card_payment_dues",
    "card_statements",
    "carm_allocations",
    "carm_transactions",
    "companies",
    "connector_config",
    "connector_oauth",
    "connector_sessions",
    "contact_companies",
    "contacts",
    "contract_acceptances",
    "contract_events",
    "contracts",
    "custom_field_links",
    "custom_fields",
    "customer_onboarding_responses",
    "customer_tech_info_responses",
    "deferred_deposit_corrections",
    "detail_field_configs",
    "digikey_orders",
    "discovery_form_schema",
    "document_items",
    "drive_inventory_items",
    "drive_inventory_state",
    "drive_inventory_tabs",
    "drive_sync_state",
    "email_attachments",
    "email_opens",
    "email_relance_overrides",
    "email_templates",
    "emails",
    "employees",
    "factures",
    "field_overrides",
    "field_visibility_rules",
    "fiscal_anomalies",
    "fx_rates",
    "gmail_sync_state",
    "greenhouse_leads",
    "hubspot_push_failures",
    "instagram_dm_threads",
    "instagram_prospect_events",
    "instagram_prospects",
    "interaction_files",
    "interactions",
    "invoice_needs",
    "journal_entry_defaults",
    "lt_debt_payments",
    "lt_debts",
    "marketing_budget_lines",
    "marketing_expense_rules",
    "marketing_expenses",
    "marketing_form_script_runs",
    "marketing_form_submissions",
    "marketing_forms",
    "meeting_bookings",
    "meeting_types",
    "meetings",
    "missing_invoice_requests",
    "month_end_provision_months",
    "month_end_provisions",
    "notifications",
    "order_items",
    "orders",
    "page_acceptances",
    "page_events",
    "paie_items",
    "paie_timesheet_sync_state",
    "paies",
    "password_resets",
    "payment_cards",
    "payment_schedule_deferrals",
    "payments",
    "pending_invoices",
    "pieces_disbursements",
    "portal_sightings",
    "prepaid_accounts",
    "prepaid_amortizations",
    "prepaid_expenses",
    "prepaid_ledger_entries",
    "product_fifo",
    "product_opening_costs",
    "product_stripe_aliases",
    "product_stripe_products",
    "products",
    "projects",
    "public_files",
    "purchase_order_numbers",
    "purchase_price_approvals",
    "purchase_prices",
    "purchases",
    "qb_attachments",
    "qb_journal_sequences",
    "qualification_calls",
    "rachat_detect_failures",
    "rd_month_hours",
    "rd_sheet_sync_state",
    "record_comments",
    "record_revision_state",
    "record_revisions",
    "record_snapshots",
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
    "sequences",
    "serial_accounting_rules",
    "serial_numbers",
    "serial_state_changes",
    "shipments",
    "slow_page_loads",
    "soumission_sends",
    "soumissions",
    "standing_doc_choices",
    "stock_movements",
    "stripe_balance_transactions",
    "stripe_invoice_items",
    "stripe_invoice_queue",
    "stripe_payouts",
    "stripe_prices",
    "stripe_products",
    "stripe_qb_tax_mapping",
    "subscription_current_items",
    "subscription_events",
    "subscription_upgrade_invoices",
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
    "timesheet_week_entries",
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
    "quickbooksJournalNumber.test",
    "ups",
    "venn"
  ]
}
