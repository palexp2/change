import db from './database.js';

export function initSchema() {
  // One-shot reshape: la 1ère version de serial_accounting_rules avait NOT NULL
  // sur debit/credit; la nouvelle forme tolère NULL pour les transitions skip.
  // La table étant introduite récemment et vide, on peut la déposer sans risque.
  try {
    const cnt = db.prepare("SELECT COUNT(*) as c FROM serial_accounting_rules").get().c
    const cols = db.prepare("PRAGMA table_info(serial_accounting_rules)").all()
    const hasSkip = cols.some(c => c.name === 'skip_accounting')
    if (cnt === 0 && !hasSkip) {
      db.exec('DROP TABLE IF EXISTS serial_accounting_rules')
    }
  } catch {}

  db.exec(`
    -- Users
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','sales','support','ops')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- Projects
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      company_id TEXT REFERENCES companies(id),
      contact_id TEXT REFERENCES contacts(id),
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- Returns
    CREATE TABLE IF NOT EXISTS returns (
      id TEXT PRIMARY KEY,
      company_id TEXT REFERENCES companies(id),
      order_id TEXT REFERENCES orders(id),
      status TEXT DEFAULT 'Ouvert' CHECK(status IN ('Ouvert','Reçu','Analysé','Fermé')),
      problem_status TEXT CHECK(problem_status IN ('À régler','Règlé')),
      notes TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- Support Tickets
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      company_id TEXT REFERENCES companies(id),
      contact_id TEXT REFERENCES contacts(id),
      assigned_to TEXT REFERENCES users(id),
      title TEXT,
      description TEXT,
      type TEXT,
      status TEXT DEFAULT 'Waiting on us',
      duration_minutes INTEGER DEFAULT 0,
      airtable_id TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- Soumissions (quotes linked to projects)
    CREATE TABLE IF NOT EXISTS soumissions (
      id TEXT PRIMARY KEY,
      airtable_id TEXT UNIQUE,
      project_id TEXT REFERENCES projects(id),
      quote_url TEXT,
      pdf_url TEXT,
      purchase_price REAL DEFAULT 0,
      subscription_price REAL DEFAULT 0,
      expiration_date TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- BOM Items (bill of materials)
    CREATE TABLE IF NOT EXISTS bom_items (
      id TEXT PRIMARY KEY,
      airtable_id TEXT UNIQUE,
      product_id TEXT REFERENCES products(id),
      component_id TEXT REFERENCES products(id),
      qty_required REAL DEFAULT 1,
      ref_des TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- Serial state changes (history)
    CREATE TABLE IF NOT EXISTS serial_state_changes (
      id TEXT PRIMARY KEY,
      airtable_id TEXT UNIQUE,
      serial_id TEXT REFERENCES serial_numbers(id),
      previous_status TEXT,
      new_status TEXT,
      changed_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- Mapping comptable des transitions de statut de numéros de série
    -- (utilisé par le job hebdomadaire d'écriture de journal QB)
    CREATE TABLE IF NOT EXISTS serial_accounting_rules (
      id TEXT PRIMARY KEY,
      previous_status TEXT,           -- NULL = wildcard / création de serial
      new_status TEXT NOT NULL,
      skip_accounting INTEGER NOT NULL DEFAULT 0,  -- 1 = "Aucune écriture" (transition reconnue, pas de JE)
      debit_account_id TEXT,             -- QB Account.Id (NULL si skip)
      debit_account_name TEXT,
      credit_account_id TEXT,
      credit_account_name TEXT,
      valuation_source TEXT NOT NULL DEFAULT 'manufacture_value'
        CHECK(valuation_source IN ('manufacture_value','fixed_amount','product_cost')),
      fixed_amount REAL,
      memo_template TEXT,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(previous_status, new_status)
    );

    -- Assemblages (production runs)
    CREATE TABLE IF NOT EXISTS assemblages (
      id TEXT PRIMARY KEY,
      airtable_id TEXT UNIQUE,
      product_id TEXT REFERENCES products(id),
      qty_produced INTEGER DEFAULT 0,
      assembled_at TEXT,
      assembly_points INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- Employees
    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      airtable_id TEXT UNIQUE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      phone_personal TEXT,
      phone_work TEXT,
      email_personal TEXT,
      email_work TEXT,
      birth_date TEXT,
      hire_date TEXT,
      matricule TEXT,
      active INTEGER DEFAULT 1,
      gender TEXT,
      address TEXT,
      emergency_contact TEXT,
      end_date TEXT,
      office_key INTEGER DEFAULT 0,
      insurance_id TEXT,
      nethris_username TEXT,
      is_salesperson INTEGER DEFAULT 0,
      is_consultant INTEGER DEFAULT 0,
      accounting_department TEXT,
      hours_per_week REAL,
      last_raise_date TEXT,
      group_insurance INTEGER DEFAULT 0,
      address_verified INTEGER DEFAULT 0,
      banking_info TEXT,
      issues TEXT,
      peer_reviews TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- Paies (payroll periods)
    CREATE TABLE IF NOT EXISTS paies (
      id TEXT PRIMARY KEY,
      airtable_id TEXT UNIQUE,
      number INTEGER,
      period_end TEXT,
      status TEXT,
      csv TEXT,
      nb_holiday_days INTEGER,
      total_with_charges_and_reimb REAL,
      timesheets_deadline TEXT,
      includes_hourly INTEGER DEFAULT 0,
      includes_mileage INTEGER DEFAULT 0,
      includes_expense_reimb INTEGER DEFAULT 0,
      includes_paid_leave INTEGER DEFAULT 0,
      includes_holiday_hours INTEGER DEFAULT 0,
      includes_sales_commissions INTEGER DEFAULT 0,
      timesheets_sent INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- Paie items (payroll line items)
    CREATE TABLE IF NOT EXISTS paie_items (
      id TEXT PRIMARY KEY,
      airtable_id TEXT UNIQUE,
      paie_id TEXT REFERENCES paies(id) ON DELETE SET NULL,
      paie_airtable_id TEXT,
      employee_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
      employee_airtable_id TEXT,
      start_date TEXT,
      hourly_rate REAL,
      regular_hours REAL,
      holiday_hours REAL,
      vacation REAL,
      commission REAL,
      expense_reimb REAL,
      rsde_pct REAL,
      insurance_gains REAL,
      holiday_1_20 REAL,
      paid_leave TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
    'ALTER TABLE tickets ADD COLUMN response TEXT',
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
    // stock_movements — Airtable sync enhancements
    'ALTER TABLE stock_movements ADD COLUMN airtable_id TEXT',
    'ALTER TABLE stock_movements ADD COLUMN unit_cost REAL',
    'ALTER TABLE stock_movements ADD COLUMN movement_value REAL',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_movements_airtable ON stock_movements(airtable_id) WHERE airtable_id IS NOT NULL',
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
    "ALTER TABLE table_view_configs ADD COLUMN column_widths TEXT DEFAULT '{}'",
    // delivery address on orders and shipments
    'ALTER TABLE orders ADD COLUMN address_id TEXT REFERENCES adresses(id)',
    'ALTER TABLE shipments ADD COLUMN address_id TEXT REFERENCES adresses(id)',

    'DROP TABLE IF EXISTS webhooks',
    'ALTER TABLE notifications ADD COLUMN read_at TEXT',
    // Phase 3 — Automations engine columns
    'ALTER TABLE automations ADD COLUMN description TEXT',
    'ALTER TABLE automations ADD COLUMN script TEXT',
    'ALTER TABLE automations ADD COLUMN last_run_at TEXT',
    'ALTER TABLE automations ADD COLUMN last_run_status TEXT',
    'ALTER TABLE automations ADD COLUMN system INTEGER DEFAULT 0',
    'ALTER TABLE automation_logs ADD COLUMN duration_ms INTEGER',

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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`,
    // Agent tasks feedback column
    'ALTER TABLE agent_tasks ADD COLUMN feedback INTEGER',
    // Bon de livraison PDF
    'ALTER TABLE orders ADD COLUMN bon_livraison_path TEXT',
    // Déduplication FTP ingest
    'ALTER TABLE calls ADD COLUMN original_filename TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_original_filename ON calls(original_filename) WHERE original_filename IS NOT NULL',
    // Résumé + prochaines étapes générés par GPT après transcription
    'ALTER TABLE calls ADD COLUMN summary TEXT',
    'ALTER TABLE calls ADD COLUMN next_steps TEXT',
    // Champs d'info technique post-achat (JSON array de field defs)
    'ALTER TABLE products ADD COLUMN tech_info_fields TEXT',
    // Factures en attente de paiement (avant qu'une vraie facture Stripe soit créée).
    // Chaque ligne représente un draft local OU une facture envoyée mais pas encore payée.
    // Permet le lien de paiement permanent /pay/:id qui crée/refresh la Checkout Session.
    `CREATE TABLE IF NOT EXISTS pending_invoices (
      id TEXT PRIMARY KEY,
      company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
      soumission_id TEXT REFERENCES soumissions(id) ON DELETE SET NULL,
      currency TEXT DEFAULT 'CAD',
      items_json TEXT NOT NULL,
      shipping_province TEXT NOT NULL,
      shipping_country TEXT NOT NULL DEFAULT 'Canada',
      due_days INTEGER DEFAULT 30,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','paid','cancelled')),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      sent_at TEXT,
      last_session_id TEXT,
      last_session_url TEXT,
      last_session_expires_at TEXT,
      paid_invoice_id TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`,
    'CREATE INDEX IF NOT EXISTS idx_pending_invoices_company ON pending_invoices(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_pending_invoices_status ON pending_invoices(status)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_invoices_paid ON pending_invoices(paid_invoice_id) WHERE paid_invoice_id IS NOT NULL',
    // Réponses au formulaire d'info technique après paiement
    `CREATE TABLE IF NOT EXISTS customer_tech_info_responses (
      id TEXT PRIMARY KEY,
      pending_invoice_id TEXT REFERENCES pending_invoices(id) ON DELETE SET NULL,
      stripe_invoice_id TEXT,
      stripe_session_id TEXT,
      product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
      responses_json TEXT NOT NULL,
      submitted_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(stripe_invoice_id, product_id)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_tech_resp_invoice ON customer_tech_info_responses(stripe_invoice_id)',
    'CREATE INDEX IF NOT EXISTS idx_tech_resp_pending ON customer_tech_info_responses(pending_invoice_id)',
    // Role pour détecter les produits-fonctionnalité dans une commande Stripe
    // (helper, chief_grower, mobile_controller, valve_block_onetime, valve_block_sub,
    //  valve_1in, guide_pipe).
    'ALTER TABLE products ADD COLUMN role TEXT',
    'CREATE INDEX IF NOT EXISTS idx_products_role ON products(role) WHERE role IS NOT NULL',
    // Wizard d'onboarding rempli par le client après paiement Stripe.
    // Une seule ligne par stripe_session_id (autosave + soumission finale).
    `CREATE TABLE IF NOT EXISTS customer_onboarding_responses (
      id TEXT PRIMARY KEY,
      stripe_session_id TEXT UNIQUE NOT NULL,
      stripe_invoice_id TEXT,
      pending_invoice_id TEXT,
      company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
      is_new_site TEXT,
      farm_address_json TEXT,
      shipping_same_as_farm INTEGER,
      shipping_address_json TEXT,
      network_access TEXT,
      wifi_ssid TEXT,
      wifi_password TEXT,
      permission_level TEXT,
      num_greenhouses INTEGER,
      greenhouses_json TEXT,
      extras_json TEXT,
      extras_pending_invoice_id TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','submitted')),
      submitted_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`,
    'CREATE INDEX IF NOT EXISTS idx_onboarding_invoice ON customer_onboarding_responses(stripe_invoice_id)',
    'CREATE INDEX IF NOT EXISTS idx_onboarding_company ON customer_onboarding_responses(company_id)',
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
    // Fournisseurs — lien companies ↔ QB
    'ALTER TABLE companies ADD COLUMN quickbooks_vendor_id TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_qb_vendor ON companies(quickbooks_vendor_id) WHERE quickbooks_vendor_id IS NOT NULL',
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(base_id)
    )`,
    // Webhook sync retry queue — stores failed webhook changes for retry
    `CREATE TABLE IF NOT EXISTS webhook_sync_retry (
      id TEXT PRIMARY KEY,
      module TEXT NOT NULL,
      changes TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      last_error TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      next_retry_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(stripe_invoice_id)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_stripe_queue_status ON stripe_invoice_queue(status)',
    'CREATE INDEX IF NOT EXISTS idx_stripe_queue_stripe ON stripe_invoice_queue(stripe_invoice_id)',
    `CREATE TABLE IF NOT EXISTS stripe_qb_tax_mapping (
      id TEXT PRIMARY KEY,
      stripe_tax_id TEXT NOT NULL,
      stripe_tax_description TEXT,
      qb_tax_code TEXT NOT NULL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(stripe_tax_id)
    )`,
    // Persist collapsed groups state per view
    "ALTER TABLE table_view_pills ADD COLUMN collapsed_groups TEXT DEFAULT '[]'",
    // Employees — add airtable_id for Airtable sync
    'ALTER TABLE employees ADD COLUMN airtable_id TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_airtable ON employees(airtable_id) WHERE airtable_id IS NOT NULL',
    // Employees — extended fields from Airtable
    'ALTER TABLE employees ADD COLUMN active INTEGER DEFAULT 1',
    'ALTER TABLE employees ADD COLUMN gender TEXT',
    'ALTER TABLE employees ADD COLUMN address TEXT',
    'ALTER TABLE employees ADD COLUMN emergency_contact TEXT',
    'ALTER TABLE employees ADD COLUMN end_date TEXT',
    'ALTER TABLE employees ADD COLUMN office_key INTEGER DEFAULT 0',
    'ALTER TABLE employees ADD COLUMN insurance_id TEXT',
    'ALTER TABLE employees ADD COLUMN nethris_username TEXT',
    'ALTER TABLE employees ADD COLUMN is_salesperson INTEGER DEFAULT 0',
    'ALTER TABLE employees ADD COLUMN is_consultant INTEGER DEFAULT 0',
    'ALTER TABLE employees ADD COLUMN accounting_department TEXT',
    'ALTER TABLE employees ADD COLUMN hours_per_week REAL',
    'ALTER TABLE employees ADD COLUMN last_raise_date TEXT',
    'ALTER TABLE employees ADD COLUMN group_insurance INTEGER DEFAULT 0',
    'ALTER TABLE employees ADD COLUMN address_verified INTEGER DEFAULT 0',
    'ALTER TABLE employees ADD COLUMN banking_info TEXT',
    'ALTER TABLE employees ADD COLUMN issues TEXT',
    'ALTER TABLE employees ADD COLUMN peer_reviews TEXT',
    // Clear stale field_map so the next sync re-derives the complete mapping
    "UPDATE airtable_module_config SET field_map=NULL WHERE module='employees'",
    // Seed Airtable module config for paies + paie_items (same base as employees)
    "INSERT OR IGNORE INTO airtable_module_config (module, base_id, table_id) VALUES ('paies', 'appqavqAf83Td3exW', 'tblrno7j8yt2M0RaK')",
    "INSERT OR IGNORE INTO airtable_module_config (module, base_id, table_id) VALUES ('paie_items', 'appqavqAf83Td3exW', 'tblv8wtCpVThzQ306')",
    // Seed Airtable module config for mouvements d'inventaire (stock_movements)
    `INSERT OR IGNORE INTO airtable_module_config (module, base_id, table_id, field_map) VALUES ('stock_movements', 'appB4Fehk9jYd4s4B', 'tblamR5pAVkC2RcnR', '{"product":"Pièces","qty_change":"Changement","type":"Type","occurred_at":"Created","unit_cost":"Coût unitaire au moment du mouvement","movement_value":"Valeur du mouvement"}')`,
    'CREATE INDEX IF NOT EXISTS idx_paie_items_paie ON paie_items(paie_id)',
    'CREATE INDEX IF NOT EXISTS idx_paie_items_employee ON paie_items(employee_id)',
    // Declarative field-rule automations: discriminator + per-record fire tracking
    'ALTER TABLE automations ADD COLUMN kind TEXT',
    `CREATE TABLE IF NOT EXISTS automation_rule_fires (
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      record_table  TEXT NOT NULL,
      record_id     TEXT NOT NULL,
      fired_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (automation_id, record_table, record_id)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_rule_fires_table_record ON automation_rule_fires(record_table, record_id)',
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
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(erp_table, column_name)
    );

    -- Columns that the Airtable sync must NOT overwrite (frozen = lives only in ERP DB)
    CREATE TABLE IF NOT EXISTS airtable_frozen_columns (
      erp_table TEXT NOT NULL,
      column_name TEXT NOT NULL,
      frozen_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      frozen_by TEXT,
      PRIMARY KEY (erp_table, column_name)
    );
  `)

  db.exec(`
    -- Automations
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_config TEXT DEFAULT '{}',
      action_type TEXT NOT NULL,
      action_config TEXT DEFAULT '{}',
      active INTEGER DEFAULT 1,
      deleted_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- Automation logs
    CREATE TABLE IF NOT EXISTS automation_logs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('success','error','skipped')),
      trigger_data TEXT,
      result TEXT,
      error TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- Subscription change history
    CREATE TABLE IF NOT EXISTS subscription_events (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
      event_date TEXT NOT NULL,
      event_type TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- Agent autonomous tasks queue
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','in_progress','done','blocked','rejected')),
      priority INTEGER NOT NULL DEFAULT 0,
      user_comment TEXT,
      agent_result TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS task_keywords (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL UNIQUE,
      color TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS stripe_payouts (
      id TEXT PRIMARY KEY,
      stripe_id TEXT NOT NULL UNIQUE,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      status TEXT,
      arrival_date TEXT,
      created_date TEXT,
      method TEXT,
      type TEXT,
      description TEXT,
      statement_descriptor TEXT,
      destination TEXT,
      bank_name TEXT,
      bank_last4 TEXT,
      failure_code TEXT,
      failure_message TEXT,
      automatic INTEGER DEFAULT 0,
      stripe_url TEXT,
      raw TEXT,
      synced_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `)

  try { db.exec("ALTER TABLE tasks ADD COLUMN keywords TEXT DEFAULT '[]'") } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN deleted_at TEXT") } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN hubspot_task_id TEXT") } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN last_hubspot_sync TEXT") } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_hubspot_id ON tasks(hubspot_task_id) WHERE hubspot_task_id IS NOT NULL") } catch {}
  try { db.exec("ALTER TABLE users ADD COLUMN hubspot_owner_id TEXT") } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_hubspot_owner ON users(hubspot_owner_id) WHERE hubspot_owner_id IS NOT NULL") } catch {}

  // Indexes
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_automation_logs_auto ON automation_logs(automation_id, created_at)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at)') } catch {}
  for (const sql of migrations) {
    try { db.exec(sql) } catch { /* column already exists */ }
  }

  // Rename soumissions price columns to reflect customer currency (not CAD)
  try { db.exec('ALTER TABLE soumissions RENAME COLUMN purchase_price_cad TO purchase_price') } catch {}
  try { db.exec('ALTER TABLE soumissions RENAME COLUMN subscription_price_cad TO subscription_price') } catch {}

  // Computed project value in CAD, derived from the latest soumission's purchase price,
  // converted via the Bank of Canada FX rate on the soumission date when needed.
  try { db.exec('ALTER TABLE projects ADD COLUMN valeur_cad_calc REAL') } catch {}

  // User-editable display label for dynamic Airtable fields. Overrides
  // airtable_field_name in the UI when set; preserved across syncs.
  try { db.exec('ALTER TABLE airtable_field_defs ADD COLUMN display_label TEXT') } catch {}
  // Permet de désactiver l'import d'un champ Airtable depuis la modale de sync.
  // Quand =1, le sync skip ce champ (n'écrit pas dans la colonne ERP correspondante).
  try { db.exec('ALTER TABLE airtable_field_defs ADD COLUMN import_disabled INTEGER DEFAULT 0') } catch {}

  // QB multi-currency support — store transaction currency + exchange rate on imports
  try { db.exec("ALTER TABLE factures_fournisseurs ADD COLUMN currency TEXT DEFAULT 'CAD'") } catch {}
  try { db.exec('ALTER TABLE factures_fournisseurs ADD COLUMN exchange_rate REAL DEFAULT 1') } catch {}
  try { db.exec("ALTER TABLE depenses ADD COLUMN currency TEXT DEFAULT 'CAD'") } catch {}
  try { db.exec('ALTER TABLE depenses ADD COLUMN exchange_rate REAL DEFAULT 1') } catch {}
  try { db.exec('ALTER TABLE factures_fournisseurs ADD COLUMN vendor_id TEXT') } catch {}

  // Unified achats_fournisseurs table — merges dépenses (QB Purchase) + factures fournisseurs (QB Bill)
  db.exec(`
    CREATE TABLE IF NOT EXISTS achats_fournisseurs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('bill','purchase')),
      date_achat TEXT NOT NULL,
      due_date TEXT,
      vendor TEXT,
      vendor_id TEXT,
      vendor_invoice_number TEXT,
      bill_number TEXT,
      reference TEXT,
      description TEXT,
      category TEXT,
      payment_method TEXT,
      amount_cad REAL DEFAULT 0,
      tax_cad REAL DEFAULT 0,
      total_cad REAL DEFAULT 0,
      amount_paid_cad REAL DEFAULT 0,
      balance_due_cad REAL GENERATED ALWAYS AS (total_cad - amount_paid_cad) STORED,
      currency TEXT DEFAULT 'CAD',
      exchange_rate REAL DEFAULT 1,
      status TEXT NOT NULL,
      lines TEXT,
      notes TEXT,
      created_by TEXT REFERENCES users(id),
      quickbooks_id TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_achats_date ON achats_fournisseurs(date_achat);
    CREATE INDEX IF NOT EXISTS idx_achats_type ON achats_fournisseurs(type);
    CREATE INDEX IF NOT EXISTS idx_achats_vendor ON achats_fournisseurs(vendor_id);
    CREATE INDEX IF NOT EXISTS idx_achats_qbid ON achats_fournisseurs(quickbooks_id);
  `)

  const achatsCount = db.prepare('SELECT COUNT(*) AS c FROM achats_fournisseurs').get().c
  const hasDepenses = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='depenses'").get()
  const hasFactFourn = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='factures_fournisseurs'").get()

  if (achatsCount === 0 && (hasDepenses || hasFactFourn)) {
    db.transaction(() => {
      if (hasDepenses) {
        db.exec(`
          INSERT INTO achats_fournisseurs
            (id, type, date_achat, vendor, vendor_id, reference, description, category, payment_method,
             amount_cad, tax_cad, total_cad, currency, exchange_rate, status, lines, notes,
             created_by, quickbooks_id, created_at, updated_at)
          SELECT id, 'purchase', date_depense, vendor, vendor_id, reference, description, category, payment_method,
             amount_cad, tax_cad, COALESCE(total_cad, amount_cad + tax_cad),
             COALESCE(currency, 'CAD'), COALESCE(exchange_rate, 1),
             status, lines, notes, created_by, quickbooks_id, created_at, updated_at
          FROM depenses
        `)
      }
      if (hasFactFourn) {
        db.exec(`
          INSERT INTO achats_fournisseurs
            (id, type, date_achat, due_date, vendor, vendor_id, vendor_invoice_number, bill_number,
             category, amount_cad, tax_cad, total_cad, amount_paid_cad,
             currency, exchange_rate, status, lines, notes, quickbooks_id, created_at, updated_at)
          SELECT id, 'bill', date_facture, due_date, vendor, vendor_id, vendor_invoice_number, bill_number,
             category, amount_cad, tax_cad, total_cad, amount_paid_cad,
             COALESCE(currency, 'CAD'), COALESCE(exchange_rate, 1),
             status, lines, notes, quickbooks_id, created_at, updated_at
          FROM factures_fournisseurs
        `)
      }
    })()
    console.log(`✅ Migration achats_fournisseurs: ${db.prepare('SELECT COUNT(*) AS c FROM achats_fournisseurs').get().c} lignes migrées`)
  }

  try { db.exec('DROP TABLE IF EXISTS depenses') } catch {}
  try { db.exec('DROP TABLE IF EXISTS factures_fournisseurs') } catch {}

  // Achat par PO — lien produit → fournisseur (company) pour générer bons de commande
  try { db.exec('ALTER TABLE products ADD COLUMN buy_via_po INTEGER DEFAULT 0') } catch {}
  try { db.exec('ALTER TABLE products ADD COLUMN supplier_company_id TEXT REFERENCES companies(id)') } catch {}
  // Destinataire par défaut pour l'envoi du bon de commande (sinon premier contact fournisseur)
  try { db.exec('ALTER TABLE products ADD COLUMN order_email TEXT') } catch {}
  // Lien purchases.supplier (texte libre hérité d'Airtable) → companies
  try { db.exec('ALTER TABLE purchases ADD COLUMN supplier_company_id TEXT REFERENCES companies(id)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_purchases_supplier_company ON purchases(supplier_company_id)') } catch {}
  // Devise et langue par fournisseur (utilisées pour pré-remplir les PO)
  try { db.exec("ALTER TABLE companies ADD COLUMN currency TEXT DEFAULT 'CAD'") } catch {}
  try { db.exec('ALTER TABLE companies ADD COLUMN language TEXT') } catch {}

  // FX rate cache (Bank of Canada Valet daily observations, e.g. USDCAD)
  db.exec(`
    CREATE TABLE IF NOT EXISTS fx_rates (
      pair TEXT NOT NULL,
      date TEXT NOT NULL,
      rate REAL NOT NULL,
      fetched_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (pair, date)
    )
  `)

  // Migrate soumissions field_map keys to match renamed columns
  try {
    const cfg = db.prepare("SELECT field_map FROM airtable_module_config WHERE module='soumissions'").get()
    if (cfg?.field_map) {
      const fm = JSON.parse(cfg.field_map)
      let changed = false
      if (fm.purchase_price_cad && !fm.purchase_price) { fm.purchase_price = fm.purchase_price_cad; delete fm.purchase_price_cad; changed = true }
      if (fm.subscription_price_cad && !fm.subscription_price) { fm.subscription_price = fm.subscription_price_cad; delete fm.subscription_price_cad; changed = true }
      if (fm.pdf_url && !fm.pdf) { fm.pdf = fm.pdf_url; delete fm.pdf_url; changed = true }
      if (changed) {
        db.prepare("UPDATE airtable_module_config SET field_map=? WHERE module='soumissions'").run(JSON.stringify(fm))
      }
    }
  } catch {}

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
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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

  // Remove CHECK constraints from tickets table
  const ticketsDef2 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tickets'").get()
  if (ticketsDef2 && ticketsDef2.sql.includes('CHECK')) {
    const cols = db.pragma('table_info(tickets)').map(c => c.name)
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE tickets_new (
        id TEXT PRIMARY KEY,
        company_id TEXT REFERENCES companies(id),
        contact_id TEXT REFERENCES contacts(id),
        assigned_to TEXT REFERENCES users(id),
        title TEXT,
        description TEXT,
        type TEXT,
        status TEXT DEFAULT 'Waiting on us',
        duration_minutes INTEGER DEFAULT 0,
        notes TEXT,
        airtable_id TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      INSERT INTO tickets_new SELECT ${cols.slice(0, 13).map(c => '"' + c + '"').join(', ')} FROM tickets;
    `)
    // Re-add dynamic columns and copy data
    const baseCols = new Set(['id','company_id','contact_id','assigned_to','title','description','type','status','duration_minutes','notes','airtable_id','created_at','updated_at'])
    const dynCols = cols.filter(c => !baseCols.has(c))
    for (const col of dynCols) {
      try { db.exec(`ALTER TABLE tickets_new ADD COLUMN "${col}" TEXT`) } catch {}
    }
    if (dynCols.length > 0) {
      const allCols = cols.map(c => '"' + c + '"').join(', ')
      db.exec(`DELETE FROM tickets_new; INSERT INTO tickets_new (${allCols}) SELECT ${allCols} FROM tickets;`)
    }
    db.exec(`
      DROP TABLE tickets;
      ALTER TABLE tickets_new RENAME TO tickets;
      PRAGMA foreign_keys = ON;
    `)
    console.log('✅ Tickets: CHECK constraints removed')
  }

  // Drop unused 'notes' column from tickets
  const ticketHasNotes = db.pragma('table_info(tickets)').some(c => c.name === 'notes')
  if (ticketHasNotes) {
    db.exec('ALTER TABLE tickets DROP COLUMN notes')
    console.log('✅ Tickets: dropped unused notes column')
  }

  // Installation follow-up email — 21 days after first shipment. Set once per company
  // when the email is sent successfully; used as the idempotency guard.
  const hasInstallFollowup = db.pragma('table_info(companies)').some(c => c.name === 'installation_followup_sent_at')
  if (!hasInstallFollowup) {
    db.exec('ALTER TABLE companies ADD COLUMN installation_followup_sent_at DATETIME DEFAULT NULL')
    console.log('✅ Companies: added installation_followup_sent_at')
  }

  // Companies marquées comme « vendeur Orisha » — éligibles comme valeur du
  // champ vendeur sur les projets (à côté des employés salesperson).
  try { db.exec('ALTER TABLE companies ADD COLUMN is_vendeur_orisha INTEGER DEFAULT 0') } catch {}

  // Nouveau champ vendeur sur les projets — référence polymorphe (employé OU
  // company partenaire). Format : `employee:UUID` ou `company:UUID`.
  // L'ancien champ `vendeur` (texte libre Airtable) est renommé "Vendeur AT" côté UI.
  try { db.exec('ALTER TABLE projects ADD COLUMN vendeur_ref TEXT') } catch {}

  // Custom fields : permet aux utilisateurs de créer des colonnes ERP-only
  // (texte ou nombre avec N décimales) sur certaines tables principales.
  // Les colonnes correspondantes sont créées dynamiquement via ALTER TABLE.
  // Soft-delete via deleted_at — restaurable depuis la corbeille admin.
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_fields (
      id TEXT PRIMARY KEY,
      erp_table TEXT NOT NULL,
      name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('text','number')),
      decimals INTEGER,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT,
      UNIQUE(erp_table, column_name)
    );
    CREATE INDEX IF NOT EXISTS idx_custom_fields_table ON custom_fields(erp_table) WHERE deleted_at IS NULL;
  `)

  // Legacy tickets.slack_notified_hardware column — superseded by automation_rule_fires.
  // Drop it once the field_rule engine has taken over.
  if (db.pragma('table_info(tickets)').some(c => c.name === 'slack_notified_hardware')) {
    db.exec('ALTER TABLE tickets DROP COLUMN slack_notified_hardware')
    console.log('✅ Tickets: dropped legacy slack_notified_hardware column')
  }

  // Drop 'assigned_to' column from projects
  const projectHasAssigned = db.pragma('table_info(projects)').some(c => c.name === 'assigned_to')
  if (projectHasAssigned) {
    db.exec('ALTER TABLE projects DROP COLUMN assigned_to')
    console.log('✅ Projects: dropped assigned_to column')
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
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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

  // QuickBooks attachments synced locally for achats_fournisseurs (bills & purchases)
  db.exec(`
    CREATE TABLE IF NOT EXISTS qb_attachments (
      id TEXT PRIMARY KEY,
      achat_id TEXT NOT NULL REFERENCES achats_fournisseurs(id) ON DELETE CASCADE,
      qb_id TEXT NOT NULL,
      file_name TEXT,
      content_type TEXT,
      file_size INTEGER,
      file_path TEXT NOT NULL,
      note TEXT,
      fetched_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(achat_id, qb_id)
    );
    CREATE INDEX IF NOT EXISTS idx_qb_attachments_achat ON qb_attachments(achat_id);
  `)

  for (const sql of indexes) {
    try {
      db.exec(sql);
    } catch {
      // Index may already exist
    }
  }

  // Stripe payouts → QB Deposit: track push state
  try { db.exec('ALTER TABLE stripe_payouts ADD COLUMN qb_deposit_id TEXT') } catch {}
  try { db.exec('ALTER TABLE stripe_payouts ADD COLUMN qb_pushed_at TEXT') } catch {}

  // Stripe balance_transactions — detailed line items per payout
  db.exec(`
    CREATE TABLE IF NOT EXISTS stripe_balance_transactions (
      id TEXT PRIMARY KEY,
      stripe_id TEXT NOT NULL UNIQUE,
      payout_stripe_id TEXT,
      type TEXT,
      reporting_category TEXT,
      amount REAL,
      fee REAL,
      net REAL,
      currency TEXT,
      description TEXT,
      source_id TEXT,
      source_type TEXT,
      stripe_invoice_id TEXT,
      invoice_number TEXT,
      stripe_customer_id TEXT,
      customer_name TEXT,
      is_subscription INTEGER,
      qb_customer_id TEXT,
      qb_tax_code TEXT,
      tax_details TEXT,
      available_on TEXT,
      created_date TEXT,
      raw TEXT,
      synced_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sbt_payout ON stripe_balance_transactions(payout_stripe_id);
    CREATE INDEX IF NOT EXISTS idx_sbt_type ON stripe_balance_transactions(type);
  `)

  // Stripe invoice line items — un row par ligne de facture Stripe (option C : pas dédupé).
  // Idempotent via stripe_line_id (= il_xxx fourni par Stripe ; pour les lignes ad-hoc
  // sans ID Stripe stable, le service synthétise une clé déterministe).
  // Le champ product_id (FK products) sert au mapping manuel Stripe → ERP.
  db.exec(`
    CREATE TABLE IF NOT EXISTS stripe_invoice_items (
      id TEXT PRIMARY KEY,
      facture_id TEXT REFERENCES factures(id),
      stripe_invoice_id TEXT NOT NULL,
      stripe_line_id TEXT NOT NULL UNIQUE,
      stripe_price_id TEXT,
      stripe_product_id TEXT,
      description TEXT,
      quantity INTEGER DEFAULT 1,
      unit_amount INTEGER,
      amount INTEGER,
      currency TEXT,
      period_start TEXT,
      period_end TEXT,
      proration INTEGER DEFAULT 0,
      product_id TEXT REFERENCES products(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sii_facture ON stripe_invoice_items(facture_id);
    CREATE INDEX IF NOT EXISTS idx_sii_invoice ON stripe_invoice_items(stripe_invoice_id);
    CREATE INDEX IF NOT EXISTS idx_sii_product ON stripe_invoice_items(product_id);
    CREATE INDEX IF NOT EXISTS idx_sii_price ON stripe_invoice_items(stripe_price_id);
  `)

  // Stripe balance_transactions — extracted invoice tax amounts (TPS/TVQ collected from client)
  try { db.exec('ALTER TABLE stripe_balance_transactions ADD COLUMN invoice_tax_gst REAL DEFAULT 0') } catch {}
  try { db.exec('ALTER TABLE stripe_balance_transactions ADD COLUMN invoice_tax_qst REAL DEFAULT 0') } catch {}
  // ... et taxes sur les frais Stripe (extraites de fee_details)
  try { db.exec('ALTER TABLE stripe_balance_transactions ADD COLUMN fee_tax_gst REAL DEFAULT 0') } catch {}
  try { db.exec('ALTER TABLE stripe_balance_transactions ADD COLUMN fee_tax_qst REAL DEFAULT 0') } catch {}

  // Toggle admin — autoriser la suppression en lot pour une table (par défaut off)
  try { db.exec('ALTER TABLE table_view_configs ADD COLUMN bulk_delete_enabled INTEGER DEFAULT 0') } catch {}

  // Tasks — champ Type (single select libre, ex. "Problème")
  try { db.exec('ALTER TABLE tasks ADD COLUMN type TEXT') } catch {}

  // Tasks — lien optionnel vers un billet
  try { db.exec('ALTER TABLE tasks ADD COLUMN ticket_id TEXT REFERENCES tickets(id)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_ticket ON tasks(ticket_id)') } catch {}

  // Mapping user ↔ employee (pour feuilles de temps, feuilles de paie, etc.)
  try { db.exec('ALTER TABLE users ADD COLUMN employee_id TEXT REFERENCES employees(id)') } catch {}
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee ON users(employee_id) WHERE employee_id IS NOT NULL') } catch {}

  // Préférence persistante du mode de feuille de temps par utilisateur
  try { db.exec("ALTER TABLE users ADD COLUMN timesheet_default_mode TEXT DEFAULT 'simple'") } catch {}

  // Feuilles de temps — un header par (user_id, date) avec mode + champs du mode simple.
  // Les entrées du mode "detailed" sont dans timesheet_entries (child).
  db.exec(`
    CREATE TABLE IF NOT EXISTS timesheet_days (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'simple',
      start_time TEXT,
      end_time TEXT,
      break_minutes INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_timesheet_days_user_date ON timesheet_days(user_id, date) WHERE deleted_at IS NULL') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_timesheet_days_date ON timesheet_days(date) WHERE deleted_at IS NULL') } catch {}

  // Paies — période de 14 jours. period_start est optionnel en DB : si vide, on calcule à la volée
  // à partir de la paie précédente (period_end + 1 jour) ou via un fallback (period_end - 13j).
  try { db.exec('ALTER TABLE paies ADD COLUMN period_start TEXT') } catch {}

  // Banque d'heures — excédent/déficit entre heures régulières contractuelles et heures
  // réellement travaillées (sommées depuis les feuilles de temps). Une entrée positive signifie
  // que l'employé a fait plus d'heures que prévu sur la période ; négative = déficit.
  db.exec(`
    CREATE TABLE IF NOT EXISTS hour_bank_entries (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL REFERENCES employees(id),
      paie_id TEXT REFERENCES paies(id),
      paie_item_id TEXT REFERENCES paie_items(id),
      date TEXT NOT NULL,
      hours REAL NOT NULL,
      source TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_hour_bank_employee ON hour_bank_entries(employee_id) WHERE deleted_at IS NULL') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_hour_bank_paie ON hour_bank_entries(paie_id) WHERE deleted_at IS NULL') } catch {}

  // Codes d'activité — liste RH indépendante des projets clients, utilisée sur les feuilles de temps
  // (ex: Formation, Administration, Vacances, R&D général).
  // payable = 1 par défaut : les heures imputées à ce code comptent dans le total à payer.
  // payable = 0 pour les codes non rémunérés (ex. Vacances non payées, Absence sans solde).
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_codes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      active INTEGER DEFAULT 1,
      payable INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_activity_codes_name ON activity_codes(name) WHERE deleted_at IS NULL') } catch {}
  // Migration pour devs qui ont créé la table sans la colonne payable
  try { db.exec('ALTER TABLE activity_codes ADD COLUMN payable INTEGER DEFAULT 1') } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS timesheet_entries (
      id TEXT PRIMARY KEY,
      day_id TEXT NOT NULL REFERENCES timesheet_days(id),
      sort_order INTEGER DEFAULT 0,
      description TEXT,
      activity_code_id TEXT REFERENCES activity_codes(id),
      company_id TEXT REFERENCES companies(id),
      duration_minutes INTEGER DEFAULT 0,
      rsde INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_timesheet_entries_day ON timesheet_entries(day_id, sort_order)') } catch {}

  // Migration: un dev précoce a peut-être créé la table avec project_id REFERENCES projects(id), ou
  // renommé la colonne via ALTER (garde alors la FK vers projects). On reconstruit si la FK pointe
  // vers le mauvais parent.
  try {
    const cols = db.prepare(`SELECT name FROM pragma_table_info('timesheet_entries')`).all().map(r => r.name)
    const fks = db.prepare(`SELECT * FROM pragma_foreign_key_list('timesheet_entries')`).all()
    const needsRebuild = cols.includes('project_id') ||
      !!fks.find(fk => (fk.from === 'activity_code_id' || fk.from === 'project_id') && fk.table === 'projects')
    if (needsRebuild) {
      const hasProject = cols.includes('project_id')
      const hasActivity = cols.includes('activity_code_id')
      const srcCol = hasActivity ? 'activity_code_id' : (hasProject ? 'project_id' : 'NULL')
      db.exec(`
        CREATE TABLE timesheet_entries__new (
          id TEXT PRIMARY KEY,
          day_id TEXT NOT NULL REFERENCES timesheet_days(id),
          sort_order INTEGER DEFAULT 0,
          description TEXT,
          activity_code_id TEXT REFERENCES activity_codes(id),
          company_id TEXT REFERENCES companies(id),
          duration_minutes INTEGER DEFAULT 0,
          rsde INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        INSERT INTO timesheet_entries__new
          (id, day_id, sort_order, description, activity_code_id, company_id, duration_minutes, rsde, created_at, updated_at)
          SELECT id, day_id, sort_order, description, NULL, company_id, duration_minutes, rsde, created_at, updated_at FROM timesheet_entries;
        DROP TABLE timesheet_entries;
        ALTER TABLE timesheet_entries__new RENAME TO timesheet_entries;
        CREATE INDEX IF NOT EXISTS idx_timesheet_entries_day ON timesheet_entries(day_id, sort_order);
      `)
      // NULL-out the stale references (they pointed to projects, not activity_codes)
      void srcCol
    }
  } catch (e) {
    console.error('Migration timesheet_entries échouée:', e.message)
  }

  // Vacances — plages de congé par employé. `paid` = 1 pour congé payé, 0 pour sans solde.
  db.exec(`
    CREATE TABLE IF NOT EXISTS vacations (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      start_date TEXT,
      end_date TEXT,
      paid INTEGER DEFAULT 1,
      notes TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_vacations_employee ON vacations(employee_id)') } catch {}

  // Revenu perçu d'avance — pour factures publiées avant qu'un envoi soit fait sur la commande liée.
  try { db.exec('ALTER TABLE factures ADD COLUMN deferred_revenue_at TEXT') } catch {}
  try { db.exec('ALTER TABLE factures ADD COLUMN deferred_revenue_amount_native REAL') } catch {}
  try { db.exec('ALTER TABLE factures ADD COLUMN deferred_revenue_amount_cad REAL') } catch {}
  try { db.exec('ALTER TABLE factures ADD COLUMN deferred_revenue_currency TEXT') } catch {}
  try { db.exec('ALTER TABLE factures ADD COLUMN revenue_recognized_at TEXT') } catch {}
  try { db.exec('ALTER TABLE factures ADD COLUMN revenue_recognized_je_id TEXT') } catch {}
  // Référence QB de la transaction qui a posté le revenu reçu d'avance.
  // Format : `salesreceipt:<id>` (postInvoicePaidJE) ou `deposit:<id>` (pushDepositFromPayout).
  // Conservée même si la ligne `payments` est supprimée — permet de retrouver
  // la transaction QB depuis la fiche facture.
  try { db.exec('ALTER TABLE factures ADD COLUMN deferred_revenue_qb_ref TEXT') } catch {}

  // Encaissement Stripe — populé par le webhook invoice.paid pour avoir la
  // date exacte du paiement avant que le payout (et ses balance_transactions)
  // soient synchronisés. Reset à NULL sur invoice.payment_failed / voided.
  try { db.exec('ALTER TABLE factures ADD COLUMN paid_at TEXT') } catch {}
  try { db.exec('ALTER TABLE factures ADD COLUMN paid_amount REAL') } catch {}
  try { db.exec('ALTER TABLE factures ADD COLUMN paid_charge_id TEXT') } catch {}
  // Stripe API ≥ 2024 : `inv.charge` est null. Le PaymentIntent vit sous
  // inv.payments.data[0].payment.payment_intent. On le stocke pour pouvoir
  // matcher les balance_transactions (qui ont source.payment_intent dans leur raw).
  try { db.exec('ALTER TABLE factures ADD COLUMN paid_payment_intent TEXT') } catch {}

  // Override manuel pour la colonne « Envoyée » : par défaut on calcule via
  // has_linked_shipment. Si =1, l'utilisateur force is_sent=true (utile pour
  // factures sans matériel physique : services, frais, etc.).
  try { db.exec('ALTER TABLE factures ADD COLUMN is_sent_manual INTEGER DEFAULT 0') } catch {}

  // QB Customer ID persistant sur companies — évite le lookup par nom à chaque JE.
  // Note : QB Online lie une devise unique par Customer. Pour les clients facturés
  // dans plusieurs devises, on crée un 2e Customer suffixé " USD" et on stocke son ID.
  try { db.exec('ALTER TABLE companies ADD COLUMN quickbooks_customer_id TEXT') } catch {}
  try { db.exec('ALTER TABLE companies ADD COLUMN quickbooks_customer_id_usd TEXT') } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_companies_qb_customer ON companies(quickbooks_customer_id) WHERE quickbooks_customer_id IS NOT NULL") } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_companies_qb_customer_usd ON companies(quickbooks_customer_id_usd) WHERE quickbooks_customer_id_usd IS NOT NULL") } catch {}

  // Type de facture pour router les écritures comptables :
  //   'order'        → vente de pièces, constat à l'expédition (rail principal)
  //   'subscription' → abonnement Stripe, constat immédiat à invoice.paid (rail séparé)
  // Backfill : subscription_id présent → 'subscription', sinon 'order'.
  try { db.exec("ALTER TABLE factures ADD COLUMN kind TEXT DEFAULT 'order'") } catch {}
  try {
    db.exec("UPDATE factures SET kind='subscription' WHERE subscription_id IS NOT NULL AND (kind IS NULL OR kind='order')")
  } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_factures_kind ON factures(kind)") } catch {}

  // Table `payments` — chaque encaissement OU remboursement appliqué à une facture, peu importe
  // le canal (Stripe ou hors-Stripe). Source unique de vérité pour le suivi des AR et la
  // construction des QB Payment / Refund Receipt. Les charges Stripe alimentent cette table
  // automatiquement (au webhook invoice.paid), les paiements manuels via UI.
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      facture_id TEXT NOT NULL REFERENCES factures(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      method TEXT NOT NULL CHECK(method IN ('stripe','cheque','virement_bancaire','interac','comptant','autre')),
      received_at TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CAD',
      amount_cad REAL,
      exchange_rate REAL DEFAULT 1,
      stripe_balance_tx_id TEXT,
      stripe_charge_id TEXT,
      stripe_refund_id TEXT,
      qb_payment_id TEXT,
      qb_journal_entry_id TEXT,
      notes TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_payments_facture ON payments(facture_id)") } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_payments_received ON payments(received_at)") } catch {}
  // Idempotence Stripe : un même balance_transaction ne crée qu'une ligne ; un même refund non plus.
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_stripe_btx ON payments(stripe_balance_tx_id) WHERE stripe_balance_tx_id IS NOT NULL") } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_stripe_refund ON payments(stripe_refund_id) WHERE stripe_refund_id IS NOT NULL") } catch {}

  // QB Invoice ID séparé : on crée une Invoice QB + un Receive Payment qui la solde.
  // qb_payment_id porte le Payment, qb_invoice_id porte l'Invoice. Permet le LinkedTxn
  // Payment → Invoice (et Deposit → Payment) supporté par l'API QB.
  // Pour les refunds : qb_invoice_id porte le Credit Memo lié.
  try { db.exec('ALTER TABLE payments ADD COLUMN qb_invoice_id TEXT') } catch {}

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

