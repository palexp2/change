// ⚠️ FICHIER GÉNÉRÉ — ne pas éditer à la main.
// Source : client/scripts/gen-architecture.mjs (lancé en `prebuild`).
// Régénérer : cd client && node scripts/gen-architecture.mjs
export const architectureManifest = {
  "generatedAt": "2026-06-30T21:14:33.100Z",
  "stats": {
    "routes": 71,
    "pages": 67,
    "groups": 5,
    "api": 71,
    "tables": 100,
    "connectors": 5
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
          "label": "Formulaires de découverte",
          "component": "DiscoveryForms",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/discovery-forms"
        }
      ]
    },
    {
      "group": "Envois",
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
          "api": null
        }
      ]
    },
    {
      "group": "Comptabilité",
      "items": [
        {
          "to": "/factures",
          "label": "Factures clients",
          "component": "Factures",
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
          "to": "/achats-fournisseurs",
          "label": "Achats fournisseurs",
          "component": "AchatsFournisseurs",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/achats-fournisseurs"
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
          "to": "/stripe-payouts",
          "label": "Stripe Payouts",
          "component": "StripePayouts",
          "adminOnly": false,
          "hrOnly": false,
          "api": "/api/stripe-payouts"
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
    },
    {
      "to": "/priorite-assemblage",
      "label": "/priorite-assemblage",
      "component": "PrioriteAssemblage",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
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
      "to": "/activity",
      "label": "Feed des opérations",
      "component": "ActivityFeed",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/activity"
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
      "label": "CustomerPostPayment",
      "component": "CustomerPostPayment",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/d/:token",
      "label": "CustomerPostPayment",
      "component": "CustomerPostPayment",
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
      "label": "ProjectFields",
      "component": "ProjectFields",
      "adminOnly": true,
      "hrOnly": false,
      "api": "/api/projects"
    },
    {
      "to": "/airtable/fields/:module",
      "label": "ProjectFields",
      "component": "ProjectFields",
      "adminOnly": true,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/orders/:id",
      "label": "OrderDetail",
      "component": "OrderDetail",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/orders"
    },
    {
      "to": "/products/:id",
      "label": "ProductDetail",
      "component": "ProductDetail",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/products"
    },
    {
      "to": "/tickets/:id",
      "label": "TicketDetail",
      "component": "TicketDetail",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/tickets"
    },
    {
      "to": "/connectors",
      "label": "Connectors",
      "component": "Connectors",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/connectors"
    },
    {
      "to": "/purchases/:id",
      "label": "PurchaseDetail",
      "component": "PurchaseDetail",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/purchases"
    },
    {
      "to": "/serials/:id",
      "label": "SerialDetail",
      "component": "SerialDetail",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/serials"
    },
    {
      "to": "/projects/:id",
      "label": "ProjectDetail",
      "component": "ProjectDetail",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/projects"
    },
    {
      "to": "/retours/:id",
      "label": "RetourDetail",
      "component": "RetourDetail",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/factures/:id",
      "label": "FactureDetail",
      "component": "FactureDetail",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/soumissions/:id",
      "label": "SoumissionDetail",
      "component": "SoumissionDetail",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/envois/:id",
      "label": "EnvoisDetail",
      "component": "EnvoisDetail",
      "adminOnly": false,
      "hrOnly": false,
      "api": null
    },
    {
      "to": "/sale-receipts/:id",
      "label": "SaleReceiptDetail",
      "component": "SaleReceiptDetail",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/sale-receipts"
    },
    {
      "to": "/stripe-payouts/:stripeId",
      "label": "StripePayoutDetail",
      "component": "StripePayoutDetail",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/stripe-payouts"
    },
    {
      "to": "/employees/:id",
      "label": "EmployeeDetail",
      "component": "EmployeeDetail",
      "adminOnly": false,
      "hrOnly": true,
      "api": "/api/employees"
    },
    {
      "to": "/contacts/:id",
      "label": "ContactDetail",
      "component": "ContactDetail",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/contacts"
    },
    {
      "to": "/companies/:id",
      "label": "CompanyDetail",
      "component": "CompanyDetail",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/companies"
    },
    {
      "to": "/admin",
      "label": "Admin",
      "component": "Admin",
      "adminOnly": true,
      "hrOnly": false,
      "api": "/api/admin"
    },
    {
      "to": "/admin/:tab",
      "label": "Admin",
      "component": "Admin",
      "adminOnly": true,
      "hrOnly": false,
      "api": "/api/admin"
    },
    {
      "to": "/settings",
      "label": "Settings",
      "component": "Settings",
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
      "api": null
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
      "to": "/automations",
      "label": "Automations",
      "component": "Automations",
      "adminOnly": false,
      "hrOnly": false,
      "api": "/api/automations"
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
      "to": "/agent",
      "label": "Agent",
      "component": "Agent",
      "adminOnly": true,
      "hrOnly": false,
      "api": "/api/agent"
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
    "/api/airtable-fields",
    "/api/attachments",
    "/api/auth",
    "/api/automations",
    "/api/bons-livraison",
    "/api/bootstrap",
    "/api/calls",
    "/api/catalog",
    "/api/comments",
    "/api/companies",
    "/api/connectors",
    "/api/contacts",
    "/api/custom-fields",
    "/api/customer/post-payment",
    "/api/dashboard",
    "/api/discovery-forms",
    "/api/documents",
    "/api/email-relance",
    "/api/email-tracking",
    "/api/employees",
    "/api/field-visibility-rules",
    "/api/hooks",
    "/api/hour-bank",
    "/api/hubspot",
    "/api/interaction-files",
    "/api/interactions",
    "/api/journal-entries",
    "/api/notifications",
    "/api/novoxpress",
    "/api/novoxpress/labels",
    "/api/orders",
    "/api/paies",
    "/api/payments",
    "/api/places",
    "/api/product-docs",
    "/api/product-images",
    "/api/products",
    "/api/projects",
    "/api/projets",
    "/api/public-files",
    "/api/public/installation-feedback",
    "/api/purchases",
    "/api/qualification-calls",
    "/api/receipt-files",
    "/api/recordings",
    "/api/records",
    "/api/reports",
    "/api/sale-receipts",
    "/api/search",
    "/api/serials",
    "/api/shipments",
    "/api/side-effects",
    "/api/stock-movements",
    "/api/stripe-invoice-items",
    "/api/stripe-invoices",
    "/api/stripe-payouts",
    "/api/stripe-queue",
    "/api/stripe-webhooks",
    "/api/tasks",
    "/api/telemetry",
    "/api/tickets",
    "/api/timesheets",
    "/api/track",
    "/api/undo",
    "/api/vacations",
    "/api/views"
  ],
  "tables": [
    "achats_fournisseurs",
    "activity_code_users",
    "activity_codes",
    "activity_log",
    "adresses",
    "agent_tasks",
    "airtable_field_defs",
    "airtable_frozen_columns",
    "airtable_module_config",
    "airtable_orders_config",
    "airtable_projets_config",
    "airtable_sync_config",
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
    "base_connector_configs",
    "base_interaction_attachments",
    "base_interaction_links",
    "base_interactions",
    "bom_items",
    "calls",
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
    "document_items",
    "drive_sync_state",
    "email_relance_overrides",
    "emails",
    "employees",
    "factures",
    "field_visibility_rules",
    "fx_rates",
    "gmail_sync_state",
    "hour_bank_entries",
    "hubspot_push_failures",
    "interactions",
    "journal_entry_defaults",
    "meetings",
    "notifications",
    "order_items",
    "orders",
    "paie_items",
    "paies",
    "payments",
    "pending_invoices",
    "products",
    "projects",
    "public_files",
    "purchases",
    "qb_attachments",
    "qualification_calls",
    "rachat_detect_failures",
    "record_comments",
    "return_items",
    "returns",
    "revenue_recognition_queue",
    "sale_receipt_events",
    "sale_receipts",
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
    "table_view_configs",
    "table_view_pills",
    "task_keywords",
    "tasks",
    "tickets",
    "timesheet_days",
    "timesheet_entries",
    "transcription_jobs",
    "users",
    "vacations",
    "webhook_failure_throttle",
    "webhook_sync_retry"
  ],
  "connectors": [
    "airtable",
    "amazon",
    "google",
    "hubspot",
    "quickbooks"
  ]
}
