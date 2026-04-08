import db from './database.js';

export function initSchema() {
  db.exec(`
    -- Users
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','sales','support','ops')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(email)
    );

    -- Companies
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT,
      lifecycle_phase TEXT,
      phone TEXT,
      email TEXT,
      website TEXT,
      address TEXT,
      city TEXT,
      province TEXT,
      country TEXT DEFAULT 'Canada',
      notes TEXT,
      airtable_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Contacts
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      mobile TEXT,
      company_id TEXT REFERENCES companies(id),
      language TEXT CHECK(language IN ('French','English')),
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Projects
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      company_id TEXT REFERENCES companies(id),
      contact_id TEXT REFERENCES contacts(id),
      assigned_to TEXT REFERENCES users(id),
      type TEXT CHECK(type IN ('Nouveau client','Expansion','Ajouts mineurs','Pièces de rechange')),
      status TEXT NOT NULL DEFAULT 'Ouvert' CHECK(status IN ('Ouvert','Gagné','Perdu')),
      probability INTEGER DEFAULT 0,
      value_cad REAL DEFAULT 0,
      monthly_cad REAL DEFAULT 0,
      nb_greenhouses INTEGER DEFAULT 0,
      close_date TEXT,
      refusal_reason TEXT,
      notes TEXT,
      airtable_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Products
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      sku TEXT,
      name_fr TEXT NOT NULL,
      name_en TEXT,
      type TEXT,
      unit_cost REAL DEFAULT 0,
      price_cad REAL DEFAULT 0,
      stock_qty INTEGER DEFAULT 0,
      min_stock INTEGER DEFAULT 0,
      order_qty INTEGER DEFAULT 0,
      supplier TEXT,
      procurement_type TEXT CHECK(procurement_type IN ('Acheté','Fabriqué','Drop ship')),
      weight_lbs REAL DEFAULT 0,
      notes TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Stock Movements
    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id),
      type TEXT NOT NULL CHECK(type IN ('in','out','adjustment')),
      qty INTEGER NOT NULL,
      reason TEXT,
      reference_id TEXT,
      user_id TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Orders
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      order_number INTEGER NOT NULL,
      company_id TEXT REFERENCES companies(id),
      project_id TEXT REFERENCES projects(id),
      assigned_to TEXT REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'Commande vide' CHECK(status IN ('Commande vide','Gel d''envois','En attente','Items à fabriquer ou à acheter','Tous les items sont disponibles','Tout est dans la boite','Partiellement envoyé','Drop ship seulement','JWT-config','Envoyé aujourd''hui','Envoyé','ERREUR SYSTÈME')),
      priority TEXT,
      notes TEXT,
      date_commande TEXT,
      airtable_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Order Items
    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id TEXT REFERENCES products(id),
      qty INTEGER NOT NULL DEFAULT 1,
      unit_cost REAL DEFAULT 0,
      item_type TEXT CHECK(item_type IN ('Facturable','Remplacement','Non facturable')),
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Shipments
    CREATE TABLE IF NOT EXISTS shipments (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id),
      tracking_number TEXT,
      carrier TEXT,
      status TEXT DEFAULT 'À envoyer' CHECK(status IN ('À envoyer','Envoyé')),
      shipped_at TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Returns
    CREATE TABLE IF NOT EXISTS returns (
      id TEXT PRIMARY KEY,
      company_id TEXT REFERENCES companies(id),
      order_id TEXT REFERENCES orders(id),
      status TEXT DEFAULT 'Ouvert' CHECK(status IN ('Ouvert','Reçu','Analysé','Fermé')),
      problem_status TEXT CHECK(problem_status IN ('À régler','Règlé')),
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Return Items
    CREATE TABLE IF NOT EXISTS return_items (
      id TEXT PRIMARY KEY,
      return_id TEXT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
      product_id TEXT REFERENCES products(id),
      qty INTEGER DEFAULT 1,
      reason TEXT,
      problem_category TEXT,
      analysis_notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Support Tickets
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      company_id TEXT REFERENCES companies(id),
      contact_id TEXT REFERENCES contacts(id),
      assigned_to TEXT REFERENCES users(id),
      title TEXT NOT NULL,
      description TEXT,
      type TEXT CHECK(type IN ('Aide software','Defect software','Aide hardware','Defect hardware','Erreur de commande','Formation','Installation')),
      status TEXT NOT NULL DEFAULT 'Waiting on us' CHECK(status IN ('Waiting on us','Waiting on them','Closed')),
      duration_minutes INTEGER DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Subscriptions
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      company_id TEXT REFERENCES companies(id),
      stripe_id TEXT,
      status TEXT CHECK(status IN ('active','past_due','canceled','trialing')),
      amount_monthly REAL DEFAULT 0,
      currency TEXT DEFAULT 'CAD',
      start_date TEXT,
      cancel_date TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Connector OAuth tokens (per-connector, per-account)
    CREATE TABLE IF NOT EXISTS connector_oauth (
      id TEXT PRIMARY KEY,
      connector TEXT NOT NULL,
      account_key TEXT NOT NULL,
      account_email TEXT,
      access_token TEXT,
      refresh_token TEXT,
      expiry_date INTEGER,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(connector, account_key)
    );

    -- Connector config (per-connector key-value)
    CREATE TABLE IF NOT EXISTS connector_config (
      connector TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY(connector, key)
    );

    -- Interactions (unified feed)
    CREATE TABLE IF NOT EXISTS interactions (
      id TEXT PRIMARY KEY,
      contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
      company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      type TEXT NOT NULL CHECK(type IN ('call','sms','email','meeting','note')),
      direction TEXT CHECK(direction IN ('in','out')),
      timestamp TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Calls
    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      interaction_id TEXT UNIQUE REFERENCES interactions(id) ON DELETE CASCADE,
      recording_path TEXT,
      transcript TEXT,
      transcript_formatted TEXT,
      language TEXT,
      duration_seconds INTEGER,
      caller_number TEXT,
      callee_number TEXT,
      transcription_status TEXT DEFAULT 'pending'
        CHECK(transcription_status IN ('pending','processing','done','error')),
      drive_file_id TEXT UNIQUE,
      drive_filename TEXT,
      original_filename TEXT UNIQUE
    );

    -- Emails
    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY,
      interaction_id TEXT UNIQUE REFERENCES interactions(id) ON DELETE CASCADE,
      subject TEXT,
      body_html TEXT,
      body_text TEXT,
      from_address TEXT,
      to_address TEXT,
      cc TEXT,
      gmail_message_id TEXT UNIQUE,
      gmail_thread_id TEXT
    );

    -- Meetings
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      interaction_id TEXT UNIQUE REFERENCES interactions(id) ON DELETE CASCADE,
      title TEXT,
      url TEXT,
      duration_minutes INTEGER,
      notes TEXT,
      attendees TEXT
    );

    -- Transcription jobs
    CREATE TABLE IF NOT EXISTS transcription_jobs (
      id TEXT PRIMARY KEY,
      call_id TEXT REFERENCES calls(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','done','error')),
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    -- Gmail sync state (per oauth account)
    CREATE TABLE IF NOT EXISTS gmail_sync_state (
      connector_oauth_id TEXT PRIMARY KEY REFERENCES connector_oauth(id) ON DELETE CASCADE,
      last_history_id TEXT,
      last_synced_at TEXT
    );

    -- Drive sync state
    CREATE TABLE IF NOT EXISTS drive_sync_state (
      id TEXT PRIMARY KEY DEFAULT 'default',
      last_page_token TEXT,
      last_synced_at TEXT
    );

    -- Airtable CRM sync config
    CREATE TABLE IF NOT EXISTS airtable_sync_config (
      id TEXT PRIMARY KEY DEFAULT 'default',
      base_id TEXT,
      contacts_table_id TEXT,
      companies_table_id TEXT,
      field_map_contacts TEXT,
      field_map_companies TEXT,
      last_synced_at TEXT
    );

    -- Airtable Projets config
    CREATE TABLE IF NOT EXISTS airtable_projets_config (
      id TEXT PRIMARY KEY DEFAULT 'default',
      base_id TEXT,
      projects_table_id TEXT,
      field_map_projects TEXT,
      last_synced_at TEXT
    );

    -- Airtable Orders config
    CREATE TABLE IF NOT EXISTS airtable_orders_config (
      id TEXT PRIMARY KEY DEFAULT 'default',
      base_id TEXT,
      orders_table_id TEXT,
      items_table_id TEXT,
      field_map_orders TEXT,
      field_map_items TEXT,
      last_synced_at TEXT
    );

    -- Serial Numbers
    CREATE TABLE IF NOT EXISTS serial_numbers (
      id TEXT PRIMARY KEY,
      airtable_id TEXT UNIQUE,
      serial TEXT NOT NULL,
      product_id TEXT REFERENCES products(id),
      company_id TEXT REFERENCES companies(id),
      order_item_id TEXT REFERENCES order_items(id),
      address TEXT,
      manufacture_date TEXT,
      last_programmed_date TEXT,
      manufacture_value REAL DEFAULT 0,
      status TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Unified Airtable module config (pieces, achats, billets, serials, envois)
    CREATE TABLE IF NOT EXISTS airtable_module_config (
      module TEXT NOT NULL PRIMARY KEY,
      base_id TEXT,
      table_id TEXT,
      field_map TEXT,
      last_synced_at TEXT
    );

    -- Table view configs (admin-defined per table)
    CREATE TABLE IF NOT EXISTS table_view_configs (
      id TEXT PRIMARY KEY,
      table_name TEXT NOT NULL,
      visible_columns TEXT NOT NULL DEFAULT '[]',
      default_sort TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(table_name)
    );

    -- Table view pills (admin-defined quick filters per table)
    CREATE TABLE IF NOT EXISTS table_view_pills (
      id TEXT PRIMARY KEY,
      table_name TEXT NOT NULL,
      label TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'gray',
      filters TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Purchases
    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      airtable_id TEXT UNIQUE,
      product_id TEXT REFERENCES products(id),
      supplier TEXT,
      reference TEXT,
      order_date TEXT,
      expected_date TEXT,
      received_date TEXT,
      qty_ordered INTEGER DEFAULT 0,
      qty_received INTEGER DEFAULT 0,
      unit_cost REAL DEFAULT 0,
      status TEXT DEFAULT 'Commandé' CHECK(status IN ('Commandé','Reçu partiellement','Reçu','Annulé')),
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Soumissions (quotes linked to projects)
    CREATE TABLE IF NOT EXISTS soumissions (
      id TEXT PRIMARY KEY,
      airtable_id TEXT UNIQUE,
      project_id TEXT REFERENCES projects(id),
      quote_url TEXT,
      pdf_url TEXT,
      purchase_price_cad REAL DEFAULT 0,
      subscription_price_cad REAL DEFAULT 0,
      expiration_date TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Adresses
    CREATE TABLE IF NOT EXISTS adresses (
      id TEXT PRIMARY KEY,
      airtable_id TEXT UNIQUE,
      line1 TEXT,
      city TEXT,
      province TEXT,
      postal_code TEXT,
      country TEXT,
      language TEXT,
      address_type TEXT,
      company_id TEXT REFERENCES companies(id),
      contact_id TEXT REFERENCES contacts(id),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- BOM Items (bill of materials)
    CREATE TABLE IF NOT EXISTS bom_items (
      id TEXT PRIMARY KEY,
      airtable_id TEXT UNIQUE,
      product_id TEXT REFERENCES products(id),
      component_id TEXT REFERENCES products(id),
      qty_required REAL DEFAULT 1,
      ref_des TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Serial state changes (history)
    CREATE TABLE IF NOT EXISTS serial_state_changes (
      id TEXT PRIMARY KEY,
      airtable_id TEXT UNIQUE,
      serial_id TEXT REFERENCES serial_numbers(id),
      previous_status TEXT,
      new_status TEXT,
      changed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Assemblages (production runs)
    CREATE TABLE IF NOT EXISTS assemblages (
      id TEXT PRIMARY KEY,
      airtable_id TEXT UNIQUE,
      product_id TEXT REFERENCES products(id),
      qty_produced INTEGER DEFAULT 0,
      assembled_at TEXT,
      assembly_points INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Factures (invoices, read-only from Airtable)
    CREATE TABLE IF NOT EXISTS factures (
      id TEXT PRIMARY KEY,
      airtable_id TEXT UNIQUE,
      invoice_id TEXT,
      company_id TEXT REFERENCES companies(id),
      project_id TEXT REFERENCES projects(id),
      order_id TEXT REFERENCES orders(id),
      document_number TEXT,
      document_date TEXT,
      due_date TEXT,
      status TEXT,
      currency TEXT DEFAULT 'CAD',
      amount_before_tax_cad REAL DEFAULT 0,
      total_amount REAL DEFAULT 0,
      balance_due REAL DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Dépenses (Expenses)
    CREATE TABLE IF NOT EXISTS depenses (
      id TEXT PRIMARY KEY,
      date_depense TEXT NOT NULL,
      category TEXT CHECK(category IN ('Fournitures','Voyage','Repas','Loyer','Assurance','Services','Équipement','Marketing','Logiciels','Autre')),
      description TEXT NOT NULL,
      vendor TEXT,
      reference TEXT,
      amount_cad REAL DEFAULT 0,
      tax_cad REAL DEFAULT 0,
      total_cad REAL GENERATED ALWAYS AS (amount_cad + tax_cad) STORED,
      payment_method TEXT CHECK(payment_method IN ('Carte de crédit','Chèque','Virement','Comptant','Autre')),
      status TEXT NOT NULL DEFAULT 'Brouillon' CHECK(status IN ('Brouillon','Soumis','Approuvé','Refusé','Remboursé')),
      created_by TEXT REFERENCES users(id),
      notes TEXT,
      quickbooks_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Factures fournisseurs (Bills / Accounts Payable)
    CREATE TABLE IF NOT EXISTS factures_fournisseurs (
      id TEXT PRIMARY KEY,
      bill_number TEXT,
      vendor TEXT NOT NULL,
      vendor_invoice_number TEXT,
      date_facture TEXT NOT NULL,
      due_date TEXT,
      category TEXT CHECK(category IN ('Fournitures','Voyage','Loyer','Assurance','Services','Équipement','Marketing','Logiciels','Autre')),
      amount_cad REAL DEFAULT 0,
      tax_cad REAL DEFAULT 0,
      total_cad REAL DEFAULT 0,
      amount_paid_cad REAL DEFAULT 0,
      balance_due_cad REAL GENERATED ALWAYS AS (total_cad - amount_paid_cad) STORED,
      status TEXT NOT NULL DEFAULT 'Reçue' CHECK(status IN ('Brouillon','Reçue','Approuvée','Payée partiellement','Payée','En retard','Annulée')),
      notes TEXT,
      quickbooks_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Tasks
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'À faire' CHECK(status IN ('À faire','En cours','Terminé','Annulé')),
      priority TEXT NOT NULL DEFAULT 'Normal' CHECK(priority IN ('Basse','Normal','Haute','Urgente')),
      due_date TEXT,
      company_id TEXT REFERENCES companies(id),
      contact_id TEXT REFERENCES contacts(id),
      assigned_to TEXT REFERENCES users(id),
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Sale receipts (OCR/AI extraction)
    CREATE TABLE IF NOT EXISTS sale_receipts (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      original_name TEXT,
      file_type TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','error')),
      error_message TEXT,
      receipt_date TEXT,
      company TEXT,
      address TEXT,
      receipt_number TEXT,
      subtotal REAL,
      tps REAL,
      tvq REAL,
      other_taxes REAL,
      total REAL,
      payment_method TEXT,
      currency TEXT DEFAULT 'CAD',
      items TEXT DEFAULT '[]',
      raw_data TEXT,
      quickbooks_id TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Create indexes for performance
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)',
    'CREATE INDEX IF NOT EXISTS idx_companies_phase ON companies(lifecycle_phase)',
    'CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_contacts_sort ON contacts(first_name, last_name)',
    'CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email)',
    'CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status)',
    'CREATE INDEX IF NOT EXISTS idx_projects_company ON projects(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku)',
    'CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id)',
    'CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)',
    'CREATE INDEX IF NOT EXISTS idx_orders_company ON orders(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)',
    'CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments(order_id)',
    'CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)',
    'CREATE INDEX IF NOT EXISTS idx_tickets_company ON tickets(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_connector_oauth_connector ON connector_oauth(connector)',
    'CREATE INDEX IF NOT EXISTS idx_interactions_contact ON interactions(contact_id)',
    'CREATE INDEX IF NOT EXISTS idx_interactions_company ON interactions(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_interactions_timestamp ON interactions(timestamp DESC)',
    'CREATE INDEX IF NOT EXISTS idx_calls_interaction ON calls(interaction_id)',
    'CREATE INDEX IF NOT EXISTS idx_emails_gmail ON emails(gmail_message_id)',
    'CREATE INDEX IF NOT EXISTS idx_emails_interaction ON emails(interaction_id)',
    'CREATE INDEX IF NOT EXISTS idx_purchases_product ON purchases(product_id)',
    'CREATE INDEX IF NOT EXISTS idx_serials_product ON serial_numbers(product_id)',
    'CREATE INDEX IF NOT EXISTS idx_serials_company ON serial_numbers(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_view_configs_table ON table_view_configs(table_name)',
    'CREATE INDEX IF NOT EXISTS idx_view_pills_table ON table_view_pills(table_name)',
    'CREATE INDEX IF NOT EXISTS idx_soumissions_project ON soumissions(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_adresses_company ON adresses(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_bom_items_product ON bom_items(product_id)',
    'CREATE INDEX IF NOT EXISTS idx_serial_state_changes_serial ON serial_state_changes(serial_id)',
    'CREATE INDEX IF NOT EXISTS idx_assemblages_product ON assemblages(product_id)',
    'CREATE INDEX IF NOT EXISTS idx_factures_company ON factures(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_depenses_status ON depenses(status)',
    'CREATE INDEX IF NOT EXISTS idx_depenses_date ON depenses(date_depense DESC)',
    'CREATE INDEX IF NOT EXISTS idx_factures_fourn_status ON factures_fournisseurs(status)',
    'CREATE INDEX IF NOT EXISTS idx_factures_fourn_due ON factures_fournisseurs(due_date)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_company ON tasks(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_contact ON tasks(contact_id)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)',
  ];

  // Add columns that may be missing from older schema versions
  const migrations = [
    'ALTER TABLE products ADD COLUMN airtable_id TEXT',
    'ALTER TABLE products ADD COLUMN image_url TEXT',
    'ALTER TABLE contacts ADD COLUMN airtable_id TEXT',
    'ALTER TABLE order_items ADD COLUMN airtable_id TEXT',
    'ALTER TABLE tickets ADD COLUMN airtable_id TEXT',
    'ALTER TABLE serial_numbers ADD COLUMN order_item_id TEXT REFERENCES order_items(id)',
    'ALTER TABLE shipments ADD COLUMN airtable_id TEXT',
    'ALTER TABLE serial_numbers ADD COLUMN address TEXT',
    'ALTER TABLE serial_numbers ADD COLUMN manufacture_date TEXT',
    'ALTER TABLE serial_numbers ADD COLUMN last_programmed_date TEXT',
    'ALTER TABLE serial_numbers ADD COLUMN manufacture_value REAL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN ftp_username TEXT',
    'ALTER TABLE users ADD COLUMN phone_number TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ftp_username ON users(ftp_username) WHERE ftp_username IS NOT NULL',
    'ALTER TABLE products ADD COLUMN order_qty INTEGER DEFAULT 0',
    'ALTER TABLE airtable_inventaire_config ADD COLUMN extra_tables TEXT',
    'ALTER TABLE airtable_inventaire_config RENAME TO airtable_projets_config',
    // returns enhancements
    'ALTER TABLE returns ADD COLUMN airtable_id TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_returns_airtable ON returns(airtable_id) WHERE airtable_id IS NOT NULL',
    'ALTER TABLE returns ADD COLUMN contact_id TEXT REFERENCES contacts(id)',
    'ALTER TABLE returns ADD COLUMN return_number TEXT',
    'ALTER TABLE returns ADD COLUMN tracking_number TEXT',
    'ALTER TABLE returns ADD COLUMN processing_status TEXT',
    'ALTER TABLE returns ADD COLUMN billed_at TEXT',
    // return_items enhancements
    'ALTER TABLE return_items ADD COLUMN airtable_id TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_return_items_airtable ON return_items(airtable_id) WHERE airtable_id IS NOT NULL',
    'ALTER TABLE return_items ADD COLUMN serial_id TEXT REFERENCES serial_numbers(id)',
    'ALTER TABLE return_items ADD COLUMN company_id TEXT REFERENCES companies(id)',
    'ALTER TABLE return_items ADD COLUMN return_reason TEXT',
    'ALTER TABLE return_items ADD COLUMN return_reason_notes TEXT',
    'ALTER TABLE return_items ADD COLUMN action TEXT',
    'ALTER TABLE return_items ADD COLUMN received_at TEXT',
    'ALTER TABLE return_items ADD COLUMN received_by TEXT',
    'ALTER TABLE return_items ADD COLUMN analyzed_by TEXT',
    'ALTER TABLE return_items ADD COLUMN product_send_id TEXT REFERENCES products(id)',
    // subscriptions enhancements
    'ALTER TABLE subscriptions ADD COLUMN airtable_id TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_airtable ON subscriptions(airtable_id) WHERE airtable_id IS NOT NULL',
    'ALTER TABLE subscriptions ADD COLUMN type TEXT',
    'ALTER TABLE subscriptions ADD COLUMN interval_count INTEGER',
    'ALTER TABLE subscriptions ADD COLUMN interval_type TEXT',
    'ALTER TABLE subscriptions ADD COLUMN customer_id TEXT',
    'ALTER TABLE subscriptions ADD COLUMN customer_email TEXT',
    'ALTER TABLE subscriptions ADD COLUMN trial_end_date TEXT',
    'ALTER TABLE subscriptions ADD COLUMN stripe_url TEXT',
    'ALTER TABLE subscriptions ADD COLUMN amount_after_discount REAL',
    'ALTER TABLE sale_receipts ADD COLUMN quickbooks_id TEXT',
    // document items
    `CREATE TABLE IF NOT EXISTS document_items (
      id TEXT PRIMARY KEY,
      document_type TEXT NOT NULL,
      document_id TEXT NOT NULL,
      catalog_product_id TEXT REFERENCES catalog_products(id),
      qty INTEGER NOT NULL DEFAULT 1,
      unit_price_cad REAL DEFAULT 0,
      description_fr TEXT,
      description_en TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    'CREATE INDEX IF NOT EXISTS idx_document_items_doc ON document_items(document_id, document_type)',
    // soumissions enhancements
    'ALTER TABLE soumissions ADD COLUMN company_id TEXT REFERENCES companies(id)',
    'ALTER TABLE soumissions ADD COLUMN contact_id TEXT REFERENCES contacts(id)',
    "ALTER TABLE soumissions ADD COLUMN language TEXT DEFAULT 'French'",
    "ALTER TABLE soumissions ADD COLUMN status TEXT DEFAULT 'Brouillon'",
    'ALTER TABLE soumissions ADD COLUMN title TEXT',
    'ALTER TABLE soumissions ADD COLUMN notes TEXT',
    'ALTER TABLE soumissions ADD COLUMN generated_pdf_path TEXT',
    // factures enhancements
    'ALTER TABLE factures ADD COLUMN generated_pdf_path TEXT',
    'ALTER TABLE factures ADD COLUMN shipping_country TEXT',
    // products — sellable fields (merged from catalog)
    'ALTER TABLE products ADD COLUMN price_usd REAL DEFAULT 0',
    'ALTER TABLE products ADD COLUMN monthly_price_cad REAL DEFAULT 0',
    'ALTER TABLE products ADD COLUMN monthly_price_usd REAL DEFAULT 0',
    'ALTER TABLE products ADD COLUMN is_sellable INTEGER DEFAULT 0',
    // soumissions — auto-numbering
    'ALTER TABLE soumissions ADD COLUMN quote_number INTEGER',
    // document_items — discounts (kept for schema compat, unused)
    'ALTER TABLE orders ADD COLUMN date_commande TEXT',
    'ALTER TABLE document_items ADD COLUMN discount_pct REAL DEFAULT 0',
    'ALTER TABLE document_items ADD COLUMN discount_amount REAL DEFAULT 0',
    // soumissions — currency and global discount
    "ALTER TABLE soumissions ADD COLUMN currency TEXT DEFAULT 'CAD'",
    'ALTER TABLE soumissions ADD COLUMN discount_pct REAL DEFAULT 0',
    'ALTER TABLE soumissions ADD COLUMN discount_amount REAL DEFAULT 0',
    'ALTER TABLE soumissions ADD COLUMN discount_valid_until TEXT',
    'ALTER TABLE table_view_pills ADD COLUMN visible_columns TEXT DEFAULT \'[]\'',
    'ALTER TABLE table_view_pills ADD COLUMN sort TEXT DEFAULT \'[]\'',
    'ALTER TABLE table_view_pills ADD COLUMN group_by TEXT DEFAULT NULL',
    // delivery address on orders and shipments
    'ALTER TABLE orders ADD COLUMN address_id TEXT REFERENCES adresses(id)',
    'ALTER TABLE shipments ADD COLUMN address_id TEXT REFERENCES adresses(id)',
    // Phase 1b — columns for dynamic tables/fields/views
    'ALTER TABLE base_tables ADD COLUMN slug TEXT',
    'ALTER TABLE base_tables ADD COLUMN color TEXT',
    'ALTER TABLE base_tables ADD COLUMN autonumber_seq INTEGER DEFAULT 0',
    'ALTER TABLE base_fields ADD COLUMN key TEXT',
    'ALTER TABLE base_fields ADD COLUMN required INTEGER DEFAULT 0',
    'ALTER TABLE base_fields ADD COLUMN default_value TEXT',
    'ALTER TABLE base_views ADD COLUMN is_default INTEGER DEFAULT 0',
    'DROP TABLE IF EXISTS webhooks',
    'ALTER TABLE notifications ADD COLUMN read_at TEXT',
    // Phase 3 — Automations engine columns
    'ALTER TABLE automations ADD COLUMN description TEXT',
    'ALTER TABLE automations ADD COLUMN script TEXT',
    'ALTER TABLE automations ADD COLUMN last_run_at TEXT',
    'ALTER TABLE automations ADD COLUMN last_run_status TEXT',
    'ALTER TABLE automation_logs ADD COLUMN duration_ms INTEGER',
    // Phase 5a — Interface builder columns
    'ALTER TABLE base_interfaces ADD COLUMN color TEXT DEFAULT \'indigo\'',
    'ALTER TABLE base_interfaces ADD COLUMN role_access TEXT DEFAULT \'[]\'',
    'ALTER TABLE base_interface_blocks ADD COLUMN condition TEXT',
    // Phase 6 — Airtable-like interactions
    `CREATE TABLE IF NOT EXISTS base_interactions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('call','email','sms','note','meeting')),
      direction TEXT CHECK(direction IN ('inbound','outbound')),
      subject TEXT,
      body TEXT,
      body_html TEXT,
      status TEXT DEFAULT 'completed',
      duration_seconds INTEGER,
      phone_number TEXT,
      from_address TEXT,
      to_addresses TEXT DEFAULT '[]',
      cc_addresses TEXT DEFAULT '[]',
      bcc_addresses TEXT DEFAULT '[]',
      thread_id TEXT,
      message_id TEXT,
      source TEXT DEFAULT 'manual',
      external_id TEXT,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      scheduled_at TEXT,
      completed_at TEXT,
      deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_base_interactions_dedup ON base_interactions(source, external_id) WHERE external_id IS NOT NULL',
    `CREATE TABLE IF NOT EXISTS base_interaction_links (
      id TEXT PRIMARY KEY,
      interaction_id TEXT NOT NULL REFERENCES base_interactions(id) ON DELETE CASCADE,
      table_id TEXT,
      record_id TEXT,
      UNIQUE(interaction_id, record_id)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_base_interaction_links_record ON base_interaction_links(record_id)',
    'CREATE INDEX IF NOT EXISTS idx_base_interaction_links_itr ON base_interaction_links(interaction_id)',
    `CREATE TABLE IF NOT EXISTS base_interaction_attachments (
      id TEXT PRIMARY KEY,
      interaction_id TEXT NOT NULL REFERENCES base_interactions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS base_connector_configs (
      id TEXT PRIMARY KEY,
      connector TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      config TEXT DEFAULT '{}',
      credentials TEXT,
      sync_interval_minutes INTEGER DEFAULT 15,
      last_sync_at TEXT,
      last_sync_status TEXT,
      last_sync_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    // Agent tasks feedback column
    'ALTER TABLE agent_tasks ADD COLUMN feedback INTEGER',
    // Bon de livraison PDF
    'ALTER TABLE orders ADD COLUMN bon_livraison_path TEXT',
    // Déduplication FTP ingest
    'ALTER TABLE calls ADD COLUMN original_filename TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_original_filename ON calls(original_filename) WHERE original_filename IS NOT NULL',
    // Pays de l'envoi
    'ALTER TABLE shipments ADD COLUMN pays TEXT',
    // Order items sort
    'ALTER TABLE order_items ADD COLUMN sort_order INTEGER DEFAULT 0',
    'ALTER TABLE order_items ADD COLUMN replaced_serial TEXT',
    // Novoxpress shipping labels
    'ALTER TABLE shipments ADD COLUMN novoxpress_shipment_id TEXT',
    'ALTER TABLE shipments ADD COLUMN label_pdf_path TEXT',
    'ALTER TABLE emails ADD COLUMN automated INTEGER DEFAULT 0',
    'ALTER TABLE emails ADD COLUMN open_count INTEGER DEFAULT 0',
    'ALTER TABLE shipments ADD COLUMN novoxpress_pickup_id TEXT',
    'ALTER TABLE shipments ADD COLUMN tracking_email_sent_at TEXT',
    'ALTER TABLE shipments ADD COLUMN tracking_email_interaction_id TEXT',
    'ALTER TABLE shipments ADD COLUMN tracking_email_contact_id TEXT',
    // Fulfillment — expedition mode
    'ALTER TABLE products ADD COLUMN location TEXT',
    "ALTER TABLE order_items ADD COLUMN fulfillment_status TEXT DEFAULT 'À prélever'",
    'ALTER TABLE order_items ADD COLUMN shipment_id TEXT REFERENCES shipments(id)',
    'ALTER TABLE order_items ADD COLUMN fulfilled_qty INTEGER DEFAULT 0',
    'ALTER TABLE shipments ADD COLUMN bon_livraison_path TEXT',
    // Line items sur factures fournisseurs et dépenses
    'ALTER TABLE factures_fournisseurs ADD COLUMN lines TEXT',
    'ALTER TABLE depenses ADD COLUMN lines TEXT',
    // Fournisseurs — lien companies ↔ QB ↔ factures/dépenses
    'ALTER TABLE companies ADD COLUMN quickbooks_vendor_id TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_qb_vendor ON companies(quickbooks_vendor_id) WHERE quickbooks_vendor_id IS NOT NULL',
    'ALTER TABLE factures_fournisseurs ADD COLUMN vendor_id TEXT REFERENCES companies(id)',
    'ALTER TABLE depenses ADD COLUMN vendor_id TEXT REFERENCES companies(id)',
    // Champ abonnement sur les commandes
    'ALTER TABLE orders ADD COLUMN is_subscription INTEGER DEFAULT 0',
    // Airtable webhooks — remplace le polling horaire
    `CREATE TABLE IF NOT EXISTS airtable_webhooks (
      id TEXT PRIMARY KEY,
      base_id TEXT NOT NULL,
      webhook_id TEXT NOT NULL UNIQUE,
      cursor INTEGER DEFAULT 1,
      mac_secret TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(base_id)
    )`,
    // Webhook sync retry queue — stores failed webhook changes for retry
    `CREATE TABLE IF NOT EXISTS webhook_sync_retry (
      id TEXT PRIMARY KEY,
      module TEXT NOT NULL,
      changes TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      next_retry_at TEXT DEFAULT (datetime('now'))
    )`,
    // Sync log — 7-day rolling history of all Airtable syncs
    `CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK(trigger IN ('webhook','manual','scheduled')),
      status TEXT NOT NULL CHECK(status IN ('success','error')),
      records_modified INTEGER DEFAULT 0,
      records_destroyed INTEGER DEFAULT 0,
      error_message TEXT,
      duration_ms INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    'CREATE INDEX IF NOT EXISTS idx_sync_log_created ON sync_log(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_sync_log_module ON sync_log(module, created_at)',
    // Chemin local du PDF de facture téléchargé depuis Airtable
    'ALTER TABLE factures ADD COLUMN airtable_pdf_path TEXT',
    // Prix unitaire gelé au moment de l'envoi
    'ALTER TABLE order_items ADD COLUMN shipped_unit_cost REAL',
    // Lien facture → abonnement
    'ALTER TABLE factures ADD COLUMN subscription_id TEXT REFERENCES subscriptions(id)',
    // Stripe → QB Sales Receipt queue
    `CREATE TABLE IF NOT EXISTS stripe_invoice_queue (
      id TEXT PRIMARY KEY,
      stripe_invoice_id TEXT NOT NULL,
      stripe_customer_id TEXT,
      customer_name TEXT,
      customer_email TEXT,
      company_id TEXT REFERENCES companies(id),
      invoice_number TEXT,
      invoice_date TEXT,
      currency TEXT DEFAULT 'CAD',
      subtotal INTEGER DEFAULT 0,
      tax_amount INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0,
      stripe_fee INTEGER DEFAULT 0,
      line_items TEXT DEFAULT '[]',
      tax_details TEXT DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','pushed','rejected','error')),
      error_message TEXT,
      quickbooks_id TEXT,
      qb_customer_id TEXT,
      qb_income_account_id TEXT,
      qb_deposit_account_id TEXT,
      qb_tax_code TEXT,
      stripe_raw TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(stripe_invoice_id)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_stripe_queue_status ON stripe_invoice_queue(status)',
    'CREATE INDEX IF NOT EXISTS idx_stripe_queue_stripe ON stripe_invoice_queue(stripe_invoice_id)',
    `CREATE TABLE IF NOT EXISTS stripe_qb_tax_mapping (
      id TEXT PRIMARY KEY,
      stripe_tax_id TEXT NOT NULL,
      stripe_tax_description TEXT,
      stripe_tax_percentage REAL,
      qb_tax_code TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(stripe_tax_id)
    )`,
  ]

  // Backfill shipped_unit_cost from Airtable's "Coût total au moment de l'envoi" (total cost / qty)
  // Falls back to current unit_cost for shipped items without Airtable data
  try {
    db.prepare(`
      UPDATE order_items SET shipped_unit_cost = CAST(cout_total_au_moment_de_l_envoi AS REAL) / MAX(qty, 1)
      WHERE shipped_unit_cost IS NULL
        AND cout_total_au_moment_de_l_envoi IS NOT NULL
        AND cout_total_au_moment_de_l_envoi != ''
        AND CAST(cout_total_au_moment_de_l_envoi AS REAL) > 0
    `).run()
  } catch {}
  try {
    db.prepare(`
      UPDATE order_items SET shipped_unit_cost = unit_cost
      WHERE shipment_id IS NOT NULL AND shipped_unit_cost IS NULL AND unit_cost > 0
    `).run()
  } catch {}


  // ── Detail page field layout (admin-configurable) ──────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS detail_field_configs (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      field_order TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(entity_type)
    );
  `)

  // ── Airtable dynamic field definitions ─────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS airtable_field_defs (
      id TEXT PRIMARY KEY,
      module TEXT NOT NULL,
      erp_table TEXT NOT NULL,
      airtable_field_id TEXT,
      airtable_field_name TEXT,
      column_name TEXT NOT NULL,
      field_type TEXT NOT NULL DEFAULT 'text',
      options TEXT DEFAULT '{}',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(erp_table, column_name)
    );
  `)

  // ── Phase 1a: Airtable-like meta-tables ───────────────────────────────────
  db.exec(`
    -- Dynamic tables registry
    CREATE TABLE IF NOT EXISTS base_tables (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      description TEXT,
      sort_order INTEGER DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(name)
    );

    -- Dynamic fields registry
    CREATE TABLE IF NOT EXISTS base_fields (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL REFERENCES base_tables(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'single_line_text',
      options TEXT DEFAULT '{}',
      formula TEXT,
      sort_order INTEGER DEFAULT 0,
      width INTEGER DEFAULT 160,
      is_primary INTEGER DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Dynamic records
    CREATE TABLE IF NOT EXISTS base_records (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL REFERENCES base_tables(id) ON DELETE CASCADE,
      data TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Record links (many-to-many between records of different tables)
    CREATE TABLE IF NOT EXISTS base_record_links (
      id TEXT PRIMARY KEY,
      field_id TEXT NOT NULL REFERENCES base_fields(id) ON DELETE CASCADE,
      source_record_id TEXT NOT NULL REFERENCES base_records(id) ON DELETE CASCADE,
      target_record_id TEXT NOT NULL REFERENCES base_records(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(field_id, source_record_id, target_record_id)
    );

    -- Views (grid, etc.)
    CREATE TABLE IF NOT EXISTS base_views (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL REFERENCES base_tables(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'grid',
      config TEXT DEFAULT '{}',
      sort_order INTEGER DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Record history (audit trail)
    CREATE TABLE IF NOT EXISTS record_history (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      user_id TEXT REFERENCES users(id),
      action TEXT NOT NULL CHECK(action IN ('create','update','delete','restore')),
      diff TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Automations
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      table_id TEXT REFERENCES base_tables(id),
      name TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_config TEXT DEFAULT '{}',
      action_type TEXT NOT NULL,
      action_config TEXT DEFAULT '{}',
      active INTEGER DEFAULT 1,
      deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Automation logs
    CREATE TABLE IF NOT EXISTS automation_logs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('success','error','skipped')),
      trigger_data TEXT,
      result TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Interface pages builder
    CREATE TABLE IF NOT EXISTS base_interfaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      sort_order INTEGER DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS base_interface_pages (
      id TEXT PRIMARY KEY,
      interface_id TEXT NOT NULL REFERENCES base_interfaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS base_interface_blocks (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL REFERENCES base_interface_pages(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      config TEXT DEFAULT '{}',
      x INTEGER DEFAULT 0,
      y INTEGER DEFAULT 0,
      w INTEGER DEFAULT 4,
      h INTEGER DEFAULT 4,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Notifications
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      read INTEGER DEFAULT 0,
      link TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Agent autonomous tasks queue
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','in_progress','done','blocked','rejected')),
      priority INTEGER NOT NULL DEFAULT 0,
      user_comment TEXT,
      agent_result TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
  `)

  // Phase 1a indexes
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_base_records_table ON base_records(table_id, deleted_at)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_base_fields_table ON base_fields(table_id, deleted_at, sort_order)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_base_views_table ON base_views(table_id, deleted_at)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_record_history_record ON record_history(table_id, record_id, created_at)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_automation_logs_auto ON automation_logs(automation_id, created_at)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_base_record_links_source ON base_record_links(field_id, source_record_id)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at)') } catch {}
  for (const sql of migrations) {
    try { db.exec(sql) } catch { /* column already exists */ }
  }

  // Migrate orders status CHECK constraint to include 'Drop ship seulement'
  const ordersDef = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get()
  if (ordersDef && !ordersDef.sql.includes('Drop ship seulement')) {
    const oldPattern = `'Commande vide','Gel d''envois','En attente','Items à fabriquer ou à acheter','Tous les items sont disponibles','Tout est dans la boite','Partiellement envoyé','JWT-config','Envoyé aujourd''hui','Envoyé','ERREUR SYSTÈME'`
    const newPattern = `'Commande vide','Gel d''envois','En attente','Items à fabriquer ou à acheter','Tous les items sont disponibles','Tout est dans la boite','Partiellement envoyé','Drop ship seulement','JWT-config','Envoyé aujourd''hui','Envoyé','ERREUR SYSTÈME'`
    try {
      const newSql = ordersDef.sql.replace(oldPattern, newPattern).replace('CREATE TABLE "orders"', 'CREATE TABLE "orders_new"')
      db.exec('PRAGMA foreign_keys = OFF')
      db.exec(newSql)
      db.exec('INSERT INTO "orders_new" SELECT * FROM "orders"')
      db.exec('DROP TABLE "orders"')
      db.exec('ALTER TABLE "orders_new" RENAME TO "orders"')
      db.exec('PRAGMA foreign_keys = ON')
    } catch { /* already migrated */ }
  }

  // Migrate orders table to new statuses if still using old CHECK constraint
  const ordersDef2 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get()
  if (ordersDef2 && ordersDef2.sql.includes("'Brouillon'")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE orders_new (
        id TEXT PRIMARY KEY,
        order_number INTEGER NOT NULL,
        company_id TEXT REFERENCES companies(id),
        project_id TEXT REFERENCES projects(id),
        assigned_to TEXT REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'Commande vide' CHECK(status IN ('Commande vide','Gel d''envois','En attente','Items à fabriquer ou à acheter','Tous les items sont disponibles','Tout est dans la boite','Partiellement envoyé','Drop ship seulement','JWT-config','Envoyé aujourd''hui','Envoyé','ERREUR SYSTÈME')),
        priority TEXT,
        notes TEXT,
        airtable_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO orders_new SELECT
        id, order_number, company_id, project_id, assigned_to,
        CASE status
          WHEN 'Brouillon'             THEN 'Commande vide'
          WHEN 'Confirmée'             THEN 'En attente'
          WHEN 'En préparation'        THEN 'Items à fabriquer ou à acheter'
          WHEN 'Envoyée'               THEN 'Envoyé'
          WHEN 'Partiellement envoyée' THEN 'Partiellement envoyé'
          WHEN 'Annulée'               THEN 'ERREUR SYSTÈME'
          ELSE 'Commande vide'
        END,
        priority, notes, airtable_id, created_at, updated_at
      FROM orders;
      DROP TABLE orders;
      ALTER TABLE orders_new RENAME TO orders;
      PRAGMA foreign_keys = ON;
    `)
    console.log('✅ Orders table migrated to new statuses')
  }

  // Migrate tickets table to new English statuses
  const ticketsDef = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tickets'").get()
  if (ticketsDef && ticketsDef.sql.includes("'Ouvert'")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE tickets_new (
        id TEXT PRIMARY KEY,
        company_id TEXT REFERENCES companies(id),
        contact_id TEXT REFERENCES contacts(id),
        assigned_to TEXT REFERENCES users(id),
        title TEXT NOT NULL,
        description TEXT,
        type TEXT CHECK(type IN ('Aide software','Defect software','Aide hardware','Defect hardware','Erreur de commande','Formation','Installation')),
        status TEXT NOT NULL DEFAULT 'Waiting on us' CHECK(status IN ('Waiting on us','Waiting on them','Closed')),
        duration_minutes INTEGER DEFAULT 0,
        notes TEXT,
        airtable_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO tickets_new SELECT
        id, company_id, contact_id, assigned_to, title, description, type,
        CASE status
          WHEN 'Ouvert'            THEN 'Waiting on us'
          WHEN 'En attente nous'   THEN 'Waiting on us'
          WHEN 'En attente client' THEN 'Waiting on them'
          WHEN 'Fermé'             THEN 'Closed'
          ELSE 'Waiting on us'
        END,
        duration_minutes, notes, airtable_id, created_at, updated_at
      FROM tickets;
      DROP TABLE tickets;
      ALTER TABLE tickets_new RENAME TO tickets;
      PRAGMA foreign_keys = ON;
    `)
    console.log('✅ Tickets table migrated to new statuses (Waiting on us / Waiting on them / Closed)')
  }

  // Rebuild document_items if it still references catalog_products (old FK)
  const diDef = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='document_items'").get()
  if (diDef && diDef.sql.includes('catalog_products')) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE document_items_new (
        id TEXT PRIMARY KEY,
        document_type TEXT NOT NULL,
        document_id TEXT NOT NULL,
        catalog_product_id TEXT REFERENCES products(id),
        qty INTEGER NOT NULL DEFAULT 1,
        unit_price_cad REAL DEFAULT 0,
        discount_pct REAL DEFAULT 0,
        discount_amount REAL DEFAULT 0,
        description_fr TEXT,
        description_en TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO document_items_new
        SELECT id, document_type, document_id,
          NULL,
          qty, unit_price_cad,
          COALESCE(discount_pct, 0), COALESCE(discount_amount, 0),
          description_fr, description_en, sort_order, created_at
        FROM document_items;
      DROP TABLE document_items;
      ALTER TABLE document_items_new RENAME TO document_items;
      CREATE INDEX IF NOT EXISTS idx_document_items_doc ON document_items(document_id, document_type);
      PRAGMA foreign_keys = ON;
    `)
    console.log('✅ document_items rebuilt to reference products(id)')
  }

  for (const sql of indexes) {
    try {
      db.exec(sql);
    } catch (e) {
      // Index may already exist
    }
  }

  console.log('Database schema initialized');
}


const SELLABLE_DEFAULTS = [
  { name_fr: 'Assistant',               name_en: 'Helper',                       sku: 'SVC-001', sort: 0 },
  { name_fr: 'Chef de culture',         name_en: 'Chief grower',                 sku: 'SVC-002', sort: 1 },
  { name_fr: 'Accès internet mobile',   name_en: 'Mobile Internet Access',       sku: 'SVC-003', sort: 2 },
  { name_fr: 'Orisha dans la serre',    name_en: 'Get Orisha in the greenhouse', sku: 'SVC-004', sort: 3 },
  { name_fr: 'Prévention des maladies', name_en: 'Disease Prevention',           sku: 'SVC-005', sort: 4 },
]

export function seedSellableProducts() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO products (id, sku, name_fr, name_en, type, is_sellable, price_cad, price_usd, monthly_price_cad, monthly_price_usd)
    VALUES (?, ?, ?, ?, 'Service', 1, 0, 0, 0, 0)
  `)
  const run = db.transaction(() => {
    for (const p of SELLABLE_DEFAULTS) {
      insert.run(`sellable-${p.sort}`, p.sku, p.name_fr, p.name_en)
    }
  })
  run()
  console.log(`✅ Sellable products seeded`)
}

