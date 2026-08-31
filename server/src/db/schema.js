import { randomUUID } from 'node:crypto';
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

    -- Défauts débit/crédit pour la prépopulation des écritures de journal.
    -- operation_key : 'shipped.replacement', 'shipped.sale', ou 'movement.<raison>'.
    CREATE TABLE IF NOT EXISTS journal_entry_defaults (
      operation_key TEXT PRIMARY KEY,
      debit_account_id TEXT,
      debit_account_name TEXT,
      credit_account_id TEXT,
      credit_account_name TEXT,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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

    -- Overrides éditables pour le générateur d'email de relance.
    -- scope = 'global' pour les règles générales partagées entre tous les
    -- emails, sinon qc_id pour les instructions spécifiques à un qualif call.
    CREATE TABLE IF NOT EXISTS email_relance_overrides (
      scope TEXT PRIMARY KEY,
      instructions TEXT,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- Qualification calls (importées d'Airtable « Communication interne » → « Qualification calls »)
    -- Formulaire structuré rempli pendant les appels de qualification commerciale.
    CREATE TABLE IF NOT EXISTS qualification_calls (
      id TEXT PRIMARY KEY,
      airtable_record_id TEXT UNIQUE NOT NULL,
      company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
      company_name_raw TEXT,
      call_date TEXT,
      status TEXT,
      assignee TEXT,
      contact_full_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      decision_maker_name TEXT,
      decision_maker_role TEXT,
      farm_description TEXT,
      has_employees INTEGER,
      employees_count TEXT,
      is_charity INTEGER,
      can_issue_charity_receipt INTEGER,
      challenges TEXT,
      challenge_duration TEXT,
      challenge_financial_impact TEXT,
      short_term_goals TEXT,
      motivation_today TEXT,
      motivation_why_now TEXT,
      importance_score TEXT,
      readiness_score TEXT,
      has_budget TEXT,
      budget_amount TEXT,
      timeline TEXT,
      role_in_company TEXT,
      business_models TEXT,
      current_management TEXT,
      management_effective TEXT,
      pain_points TEXT,
      grows_tomatoes TEXT,
      tomato_season_months TEXT,
      summary TEXT,
      next_steps TEXT,
      notes TEXT,
      heard_about TEXT,
      red_flags TEXT,
      created_by TEXT,
      raw_fields TEXT,
      airtable_created_at TEXT,
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

    CREATE TABLE IF NOT EXISTS sale_receipt_events (
      id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL,
      user_id TEXT REFERENCES users(id),
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- Journal d'activité applicatif généralisé (qui / quoi / quand).
    -- Écrit au niveau route via le point de passage central emitEntity/emitOrder/
    -- emitCompany (services/realtimeEmitters.js) quand un acteur humain est connu.
    -- Distinct de change_log (rétention 48h, sans utilisateur, dédié au cache
    -- client) : persistant et axé sur l'attribution utilisateur, à l'image du
    -- patron éprouvé sale_receipt_events mais transverse à toutes les entités.
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT REFERENCES users(id),
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  // Create indexes for performance
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)',
    'CREATE INDEX IF NOT EXISTS idx_sale_receipt_events_receipt ON sale_receipt_events(receipt_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_activity_log_entity ON activity_log(entity_type, entity_id)',
    'CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id)',
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
    'CREATE INDEX IF NOT EXISTS idx_orders_project ON orders(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_projects_deleted_updated ON projects(deleted_at, updated_at DESC)',
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
    'CREATE INDEX IF NOT EXISTS idx_qualification_calls_company ON qualification_calls(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_qualification_calls_date ON qualification_calls(call_date DESC)',
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
    'ALTER TABLE serial_numbers ADD COLUMN permissions TEXT',
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
    // return label automation (étiquette de retour générée depuis l'ERP) —
    // return_label_tracking_number est distinct de tracking_number (écrasé à
    // chaque sync Airtable, cf. airtable.js) pour ne pas perdre le suivi acheté.
    'ALTER TABLE returns ADD COLUMN return_label_pdf_path TEXT',
    'ALTER TABLE returns ADD COLUMN return_label_tracking_number TEXT',
    'ALTER TABLE returns ADD COLUMN return_novoxpress_shipment_id TEXT',
    'ALTER TABLE returns ADD COLUMN return_carrier TEXT',
    'ALTER TABLE returns ADD COLUMN return_service_name TEXT',
    'ALTER TABLE returns ADD COLUMN return_carrier_reason TEXT',
    'ALTER TABLE returns ADD COLUMN return_label_cost REAL',
    'ALTER TABLE returns ADD COLUMN return_label_created_at TEXT',
    'ALTER TABLE returns ADD COLUMN return_address_id TEXT REFERENCES adresses(id)',
    'ALTER TABLE returns ADD COLUMN memo_pdf_path TEXT',
    'ALTER TABLE returns ADD COLUMN memo_generated_at TEXT',
    'ALTER TABLE returns ADD COLUMN instructions_sent_at TEXT',
    'ALTER TABLE returns ADD COLUMN instructions_interaction_id TEXT',
    // Étiquette de retour UPS (Shipping API, ReturnService 9). Le transporteur,
    // le suivi, le coût et le PDF réutilisent les colonnes return_label_*
    // ci-dessus (partagées avec Novoxpress) ; seuls l'identifiant d'expédition
    // UPS, la devise du coût et la trace d'envoi au client sont propres à UPS.
    'ALTER TABLE returns ADD COLUMN return_ups_shipment_id TEXT',
    'ALTER TABLE returns ADD COLUMN return_label_currency TEXT',
    'ALTER TABLE returns ADD COLUMN return_label_sent_at TEXT',
    'ALTER TABLE returns ADD COLUMN return_label_email_interaction_id TEXT',
    // Suivi UPS d'un envoi sortant (Tracking API), rafraîchi à la demande
    // depuis la fiche envoi.
    'ALTER TABLE shipments ADD COLUMN ups_tracking_status TEXT',
    'ALTER TABLE shipments ADD COLUMN ups_tracking_last_activity TEXT',
    'ALTER TABLE shipments ADD COLUMN ups_tracking_checked_at TEXT',
    // Étiquette + suivi Purolator (Shipping/Tracking E-Ship). tracking_number,
    // carrier et label_pdf_path partagés (colonnes génériques déjà utilisées
    // par Novoxpress/UPS) ; seul le PIN d'expédition Purolator et le suivi
    // horaire (cf. services/purolator.js → refreshPurolatorTracking) sont propres.
    'ALTER TABLE shipments ADD COLUMN purolator_shipment_id TEXT',
    'ALTER TABLE shipments ADD COLUMN purolator_tracking_status TEXT',
    'ALTER TABLE shipments ADD COLUMN purolator_tracking_last_activity TEXT',
    'ALTER TABLE shipments ADD COLUMN purolator_tracking_checked_at TEXT',
    // Import des automatisations Airtable « Retours » (Phase 2) — ligne de
    // remplacement créée automatiquement pour un échange de garantie immédiat.
    // `order_items.item_type` a déjà les valeurs 'Facturable'|'Remplacement'|
    // 'Non facturable' (CHECK, schema.js:139) et `orders.priority` existe déjà
    // nativement (schema.js:124) — les deux couvrent respectivement « Type » et
    // « Priorité » d'Airtable, aucune nouvelle colonne nécessaire pour ces deux.
    'ALTER TABLE order_items ADD COLUMN document_type TEXT',
    'ALTER TABLE order_items ADD COLUMN return_id TEXT REFERENCES returns(id)',
    // Marqueurs d'idempotence des watchers de retour (Phase 2) — change_log ne
    // distingue pas INSERT/UPDATE (les deux sont loggés 'upsert'), ces claims
    // évitent qu'une mise à jour ultérieure (ex. réception) ne redéclenche la
    // logique de création, et vice-versa.
    'ALTER TABLE return_items ADD COLUMN rma_processed_at TEXT',
    'ALTER TABLE return_items ADD COLUMN reception_processed_at TEXT',
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
    'ALTER TABLE sale_receipts ADD COLUMN source TEXT DEFAULT \'upload\'',
    'ALTER TABLE sale_receipts ADD COLUMN gmail_message_id TEXT',
    'CREATE INDEX IF NOT EXISTS idx_sale_receipts_gmail_msg ON sale_receipts(gmail_message_id) WHERE gmail_message_id IS NOT NULL',
    // Type d'objet QB poussé : 'purchase' (Purchase, déjà payé) ou 'bill' (Bill, à payer).
    // NULL pour les anciens enregistrements pré-toggle = traités comme 'purchase'.
    'ALTER TABLE sale_receipts ADD COLUMN quickbooks_type TEXT',
    // Soft delete : on conserve la ligne (au moins le gmail_message_id) pour éviter
    // que syncInvoiceLabel ne réimporte le même email à chaque tour, mais le fichier
    // disque est purgé et la ligne disparaît du UI (filtre `deleted_at IS NULL`).
    'ALTER TABLE sale_receipts ADD COLUMN deleted_at TEXT',
    // Archive : sort le reçu du flux « À publier » sans le supprimer. NULL = actif.
    'ALTER TABLE sale_receipts ADD COLUMN archived_at TEXT',
    // Mémo : envoyé comme PrivateNote (« Memo ») à QB à la publication.
    // Vide → on y met la description générale (general_description), pas la liste d'articles.
    'ALTER TABLE sale_receipts ADD COLUMN memo TEXT',
    // Description générale : résumé d'une ligne de l'objet principal de la facture
    // (extrait par l'IA, éditable). Sert de mémo QB par défaut — on ne veut pas les
    // 15 articles dans le mémo, seulement la description principale du document.
    'ALTER TABLE sale_receipts ADD COLUMN general_description TEXT',
    // Période couverte par la facture (abonnements, télécom, services récurrents) :
    // libellé concis extrait par l'IA, ex. « juillet 2026 », « 15 juil. – 14 août 2026 ».
    // Reporté dans le mémo QB et suffixé aux lignes d'articles, pour qu'en fin d'année
    // on sache d'un coup d'œil quelle facture couvre quel mois. NULL = achat ponctuel.
    'ALTER TABLE sale_receipts ADD COLUMN service_period TEXT',
    // Choix de comptabilisation retenus à la publication QB — conservés pour
    // servir de modèle aux futurs reçus du même fournisseur (panneau "transactions
    // passées" + bouton "Utiliser comme modèle"). Ids QuickBooks.
    'ALTER TABLE sale_receipts ADD COLUMN expense_account_id TEXT',
    'ALTER TABLE sale_receipts ADD COLUMN payment_account_id TEXT',
    'ALTER TABLE sale_receipts ADD COLUMN tax_code_id TEXT',
    'ALTER TABLE sale_receipts ADD COLUMN vendor_id TEXT',
    // Connecteur Amazon Business : ID de facture Amazon (Reconciliation/Document API).
    // Sert de clé de dédup — empêche la sync de réimporter la même facture à chaque tour.
    'ALTER TABLE sale_receipts ADD COLUMN amazon_invoice_id TEXT',
    'CREATE INDEX IF NOT EXISTS idx_sale_receipts_amazon_invoice ON sale_receipts(amazon_invoice_id) WHERE amazon_invoice_id IS NOT NULL',
    // Vérification du statut fiscal (cf. services/fiscalStatus.js) : type de transaction
    // confirmé à la publication QB — détermine le code de taxe attendu. NULL = pas encore
    // classé. fiscal_force_reason : justification saisie quand on publie malgré un écart
    // entre le code choisi et le code attendu (échappatoire tracée).
    'ALTER TABLE sale_receipts ADD COLUMN transaction_type TEXT',
    'ALTER TABLE sale_receipts ADD COLUMN fiscal_force_reason TEXT',
    // Classification fiscale proposée par l'IA à l'extraction (clé de fiscalStatus.js,
    // validée avant écriture). Signal parmi d'autres du résolveur de détection fiscale
    // (services/fiscalDetection.js) — jamais appliqué sans confirmation de l'opérateur.
    'ALTER TABLE sale_receipts ADD COLUMN extracted_transaction_type TEXT',
    // Document multipage : pages additionnelles (2..N) accumulées à la capture/upload.
    // La page 1 reste dans filename/file_type/original_name (compat routes existantes) ;
    // extra_pages = JSON [{filename, file_type, original_name}] pour les pages suivantes.
    // L'extraction IA et l'attachement QB parcourent l'ensemble (page 1 + extra_pages).
    "ALTER TABLE sale_receipts ADD COLUMN extra_pages TEXT DEFAULT '[]'",
    // Dédup inter-boîtes des factures reçues par courriel : factures@orisha.io est un
    // alias livré dans plusieurs boîtes connectées — le même message y porte des
    // gmail_message_id différents mais un seul Message-ID RFC822. On ne l'importe qu'une fois.
    'ALTER TABLE sale_receipts ADD COLUMN rfc822_message_id TEXT',
    'CREATE INDEX IF NOT EXISTS idx_sale_receipts_rfc822 ON sale_receipts(rfc822_message_id) WHERE rfc822_message_id IS NOT NULL',
    // Dédup par contenu : le Message-ID ne suffit pas quand la même facture est
    // transférée (le transfert est un nouveau message). Le hash SHA-256 du fichier
    // identifie la pièce elle-même, peu importe le chemin d'arrivée.
    'ALTER TABLE sale_receipts ADD COLUMN content_sha256 TEXT',
    'CREATE INDEX IF NOT EXISTS idx_sale_receipts_content_sha ON sale_receipts(content_sha256) WHERE content_sha256 IS NOT NULL',
    // Montant réellement débité à la banque quand il diffère du total de la facture
    // (conversion de devise). Paramètre de publication saisi dans le formulaire QB —
    // persisté comme le reste du brouillon de comptabilisation pour être retrouvé
    // quand on revient finaliser la facture plus tard.
    'ALTER TABLE sale_receipts ADD COLUMN bank_charged_total REAL',
    // qualification_calls — colonnes additionnelles pour le module d'appel guidé
    'ALTER TABLE qualification_calls ADD COLUMN heard_about TEXT',
    'ALTER TABLE qualification_calls ADD COLUMN red_flags TEXT',
    'ALTER TABLE qualification_calls ADD COLUMN created_by TEXT',
    // Devis live durant l'appel — onglet Quote dans la slide Proposal.
    'ALTER TABLE qualification_calls ADD COLUMN quote_currency TEXT DEFAULT \'USD\'',
    'ALTER TABLE qualification_calls ADD COLUMN quote_helper_count INTEGER DEFAULT 0',
    'ALTER TABLE qualification_calls ADD COLUMN quote_chief_count INTEGER DEFAULT 0',
    // Paiement Stripe effectué pendant l'appel — set par /subscribe-card, pas par le client.
    'ALTER TABLE qualification_calls ADD COLUMN quote_paid_at TEXT',
    'ALTER TABLE qualification_calls ADD COLUMN quote_paid_email TEXT',
    'ALTER TABLE qualification_calls ADD COLUMN quote_subscription_id TEXT',
    // Notes System Builder — saisies pendant l'appel pour les serres qui débordent
    // des 3 slots du formulaire Fillout (>3 serres vendues). Référence interne.
    'ALTER TABLE qualification_calls ADD COLUMN system_builder_notes TEXT',
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
    "ALTER TABLE table_view_pills ADD COLUMN group_order TEXT DEFAULT NULL",
    // subscription_events — colonnes structurées pour le panel "Mouvements
    // d'abonnements" du dashboard et la page Mouvements. Catégories actuelles :
    // 'creation' / 'upgrade' / 'downgrade' / 'churn' / 'reactivation'.
    // event_type est conservé en DB mais devenu redondant avec category (UI
    // à colonne unique) ; on les écrit identiques dans les nouveaux events.
    "ALTER TABLE subscription_events ADD COLUMN company_id TEXT REFERENCES companies(id)",
    "ALTER TABLE subscription_events ADD COLUMN category TEXT",
    "ALTER TABLE subscription_events ADD COLUMN amount_cad_delta REAL",
    "ALTER TABLE subscription_events ADD COLUMN previous_amount_cad REAL",
    "ALTER TABLE subscription_events ADD COLUMN new_amount_cad REAL",
    "ALTER TABLE subscription_events ADD COLUMN currency TEXT",
    "ALTER TABLE subscription_events ADD COLUMN stripe_event_id TEXT",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_events_stripe_event_id ON subscription_events(stripe_event_id) WHERE stripe_event_id IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_subscription_events_date ON subscription_events(event_date)",
    "CREATE INDEX IF NOT EXISTS idx_subscription_events_company ON subscription_events(company_id)",
    // Migration unique catégories : 'new' → 'creation', supprime 'other' et
    // les events sans catégorie (legacy pré-enrichissement, transitions
    // active↔past_due qui ne sont plus enregistrées). Idempotent (sans effet
    // au 2e démarrage).
    "UPDATE subscription_events SET category = 'creation' WHERE category = 'new'",
    "UPDATE subscription_events SET event_type = category WHERE category IN ('creation','upgrade','downgrade','churn','reactivation') AND (event_type IS NULL OR event_type != category)",
    "DELETE FROM subscription_events WHERE category = 'other' OR category IS NULL",
    // Ancien champ texte libre `details` (array JSON de strings + payload diagnostic
    // webhook). Retiré : les colonnes structurées category/previous_amount_cad/
    // new_amount_cad/amount_cad_delta/currency couvrent l'info utile.
    "ALTER TABLE subscription_events DROP COLUMN details",
    "ALTER TABLE table_view_configs ADD COLUMN column_widths TEXT DEFAULT '{}'",
    // delivery address on orders and shipments
    'ALTER TABLE orders ADD COLUMN address_id TEXT REFERENCES adresses(id)',
    'ALTER TABLE shipments ADD COLUMN address_id TEXT REFERENCES adresses(id)',

    // Vérificateur d'adresses postales (services/addressCheck.js) : verdict de
    // la dernière passe. check_status = 'ok' | 'warning' | 'error' (NULL = pas
    // encore vérifiée), check_issues = tableau JSON des problèmes trouvés.
    'ALTER TABLE adresses ADD COLUMN check_status TEXT',
    'ALTER TABLE adresses ADD COLUMN check_issues TEXT',
    'ALTER TABLE adresses ADD COLUMN checked_at TEXT',

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
      stripe_session_id TEXT UNIQUE,
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
      qualification_call_id TEXT,
      stripe_subscription_id TEXT,
      public_token TEXT,
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
    // Override manuel du revenu d'une commande (quick fix de la valeur réelle).
    // NULL = utiliser le revenu calculé depuis les factures (cf. dashboard rentabilité).
    'ALTER TABLE orders ADD COLUMN revenue_override_cad REAL',
    // Traçabilité quote-to-cash : commande issue d'une soumission convertie.
    // NULL = commande créée directement. Permet d'afficher « déjà convertie » côté
    // soumission et d'éviter une double conversion accidentelle.
    'ALTER TABLE orders ADD COLUMN soumission_id TEXT REFERENCES soumissions(id)',
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
    // Verrouillage de vue (lecture seule) — empêche la dérive des vues
    // partagées critiques (reporting de conformité). Togglable par admin ;
    // une vue verrouillée refuse toute édition (filtres/tris/colonnes) et
    // toute suppression côté serveur tant qu'elle n'est pas déverrouillée.
    'ALTER TABLE table_view_pills ADD COLUMN locked INTEGER DEFAULT 0',
    // Largeurs de colonnes persistées PAR VUE (et non globalement à la table).
    // Avant : column_widths vivait sur table_view_configs → toutes les vues d'une
    // même table partageaient la mise en page, et passer d'une vue « résumé » à
    // une vue « détail » écrasait les largeurs. Désormais chaque pill garde les
    // siennes ; le column_widths de table_view_configs reste comme fallback legacy
    // (vue « Tous »/forceAllView et migration des vues sans largeurs propres).
    // JSON { [colId]: pixels }, même format que table_view_configs.column_widths.
    "ALTER TABLE table_view_pills ADD COLUMN column_widths TEXT DEFAULT '{}'",
    // Formatage conditionnel PAR VUE (règles de couleur à la Airtable).
    // JSON array ordonné : [{ id, color, filters }] où `filters` reprend le
    // format des filtres de vue ({conjunction, rules} ou array plat legacy).
    // La première règle qui matche colore la ligne ; évaluation côté client
    // (applyFilterGroup), le serveur ne fait que persister.
    "ALTER TABLE table_view_pills ADD COLUMN color_rules TEXT DEFAULT '[]'",
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
    // Droit annuel de vacances payées (en jours ouvrables). Sert au calcul du
    // solde restant et à l'avertissement de dépassement sur la fiche employé.
    'ALTER TABLE employees ADD COLUMN vacation_days_per_year REAL DEFAULT 0',
    // Clear stale field_map so the next sync re-derives the complete mapping
    "UPDATE airtable_module_config SET field_map=NULL WHERE module='employees'",
    // Réparation : la suppression d'un champ issu d'Airtable ne coupait pas son
    // import (corrigé dans routes/custom-fields.js). Les colonnes concernées
    // restaient alimentées par la sync et réapparaissaient dans la page de
    // configuration des champs comme colonnes ERP non adoptées — la suppression
    // semblait sans effet. On coupe l'import des mappings dont le champ a été
    // supprimé et qui n'ont plus aucun champ actif sur la même colonne. Les
    // valeurs déjà importées sont conservées.
    `UPDATE airtable_field_mappings SET import_disabled=1
       WHERE import_disabled=0
         AND EXISTS (SELECT 1 FROM custom_fields cf
                     WHERE cf.erp_table = airtable_field_mappings.erp_table
                       AND cf.column_name = airtable_field_mappings.column_name
                       AND cf.deleted_at IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM custom_fields cf
                         WHERE cf.erp_table = airtable_field_mappings.erp_table
                           AND cf.column_name = airtable_field_mappings.column_name
                           AND cf.deleted_at IS NULL)`,
    // Seed Airtable module config for paies + paie_items (same base as employees)
    "INSERT OR IGNORE INTO airtable_module_config (module, base_id, table_id) VALUES ('paies', 'appqavqAf83Td3exW', 'tblrno7j8yt2M0RaK')",
    "INSERT OR IGNORE INTO airtable_module_config (module, base_id, table_id) VALUES ('paie_items', 'appqavqAf83Td3exW', 'tblv8wtCpVThzQ306')",
    // Seed Airtable module config for mouvements d'inventaire (stock_movements)
    `INSERT OR IGNORE INTO airtable_module_config (module, base_id, table_id, field_map) VALUES ('stock_movements', 'appB4Fehk9jYd4s4B', 'tblamR5pAVkC2RcnR', '{"product":"Pièces","qty_change":"Changement","type":"Type","occurred_at":"Created","unit_cost":"Coût unitaire au moment du mouvement","movement_value":"Valeur du mouvement"}')`,
    // Seed Airtable module config for factures (liens projet/commande seulement —
    // base/table historiquement hardcodées dans services/factureLinks.js ;
    // le field_map alimente la modale « Mapping Airtable » de /factures)
    `INSERT OR IGNORE INTO airtable_module_config (module, base_id, table_id, field_map) VALUES ('factures', 'appB4Fehk9jYd4s4B', 'tblEfH4UV8hm0YHkG', '{"document_number":"Numéro de document","project":"Projet","order":"Commande"}')`,
    // Un row legacy 'factures' (ancien sync complet débranché) peut exister sans
    // base/table — les compléter sans écraser une éventuelle valeur existante
    `UPDATE airtable_module_config SET base_id=COALESCE(base_id,'appB4Fehk9jYd4s4B'), table_id=COALESCE(table_id,'tblEfH4UV8hm0YHkG') WHERE module='factures'`,
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
    // Backpressure queue for field rules: when a single evaluation matches more
    // records than CANDIDATE_CAP can dispatch, the overflow is parked here instead
    // of being silently dropped. A background drain job (automationScheduler) chews
    // through it batch by batch, even if the trigger field never changes again, and
    // the queue depth is surfaced in the UI as an observable backpressure gauge.
    `CREATE TABLE IF NOT EXISTS automation_deferred_candidates (
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      record_table  TEXT NOT NULL,
      record_id     TEXT NOT NULL,
      enqueued_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (automation_id, record_table, record_id)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_deferred_candidates_auto ON automation_deferred_candidates(automation_id, enqueued_at)',
    // Webhook automations (kind='webhook'): compact unguessable token = the inbound
    // endpoint secret (POST|GET /api/hooks/:token). Partial unique index so only the
    // tokenized rows are constrained, leaving every other automation's NULL token free.
    'ALTER TABLE automations ADD COLUMN webhook_token TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_automations_webhook_token ON automations(webhook_token) WHERE webhook_token IS NOT NULL',
    // Throttle for webhook failure emails : au plus un courriel par webhook par
    // fenêtre (cf. webhookEngine). Une ligne par automation, last_sent_at mis à jour
    // quand un courriel d'échec part réellement.
    `CREATE TABLE IF NOT EXISTS webhook_failure_throttle (
      automation_id TEXT PRIMARY KEY REFERENCES automations(id) ON DELETE CASCADE,
      last_sent_at  TEXT
    )`,
    // Anti-spam send log for outgoing field-rule actions (email/slack). One row per
    // SUCCESSFUL send, used to enforce per-recipient and per-automation frequency
    // caps within a sliding window (cf. fieldRuleEngine.makeRateGuard). Generalises
    // the webhook_failure_throttle pattern to every client-facing channel, and
    // doubles as an audit trail of every external message a rule has sent.
    `CREATE TABLE IF NOT EXISTS automation_send_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      channel       TEXT NOT NULL,
      recipient     TEXT NOT NULL,
      record_table  TEXT,
      record_id     TEXT,
      sent_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`,
    'CREATE INDEX IF NOT EXISTS idx_send_log_window ON automation_send_log(automation_id, channel, recipient, sent_at)',
    // Version history for automations : chaque édition sauvegardée capture un
    // snapshot complet (script/action_config/trigger_config + qui/quand) → audit
    // + rollback. Une ligne par révision distincte ; les éditions rapprochées du
    // même auteur sont coalescées (cf. recordAutomationVersion dans la route).
    `CREATE TABLE IF NOT EXISTS automation_versions (
      id             TEXT PRIMARY KEY,
      automation_id  TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      version        INTEGER NOT NULL,
      name           TEXT,
      description    TEXT,
      trigger_type   TEXT,
      trigger_config TEXT,
      action_type    TEXT,
      action_config  TEXT,
      script         TEXT,
      active         INTEGER,
      kind           TEXT,
      edited_by      TEXT,
      edited_by_name TEXT,
      change_summary TEXT,
      created_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`,
    'CREATE INDEX IF NOT EXISTS idx_automation_versions_auto ON automation_versions(automation_id, version DESC)',
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


  // ── File d'attente du constat de vente (revenue recognition) ───────────────
  // Persiste les échecs de reconnaissance de revenu (JE Dr 23900|AR / Cr 40000)
  // pour les retenter avec backoff jusqu'au succès. Alimentée par le watcher
  // revenueRecognitionWatcher : une ligne par facture en échec, supprimée dès
  // que la facture est constatée (ou devient terminale : annulée, abonnement…).
  // Garantit qu'un revenu non reconnu (QB down au moment de l'expédition) n'est
  // jamais silencieusement perdu — voir services/revenueRecognitionWatcher.js.
  db.exec(`
    CREATE TABLE IF NOT EXISTS revenue_recognition_queue (
      facture_id      TEXT PRIMARY KEY,
      order_id        TEXT,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      last_attempt_at TEXT,
      next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rev_rec_queue_next ON revenue_recognition_queue(next_attempt_at);
  `)

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

    -- Garde anti-boucle du write-back ERP→Airtable.
    -- Quand l'ERP pousse une modif vers Airtable, on mémorise ici les valeurs
    -- envoyées. Le webhook Airtable qui revient (echo de notre propre écriture)
    -- est alors reconnu et ignoré par le sync entrant, évitant la boucle avec
    -- sys_airtable_webhook_router. Les entrées sont consommées/expirées (TTL).
    CREATE TABLE IF NOT EXISTS airtable_writeback_guard (
      airtable_id TEXT PRIMARY KEY,
      fields_json TEXT NOT NULL,
      written_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- Sens de synchronisation choisi par l'utilisateur, par champ d'un module
    -- Airtable (modale de mapping). 'pull' = Airtable → ERP seulement, 'push' =
    -- ERP → Airtable seulement, 'both' = bidirectionnel. Absence de ligne = défaut
    -- dérivé du code (fieldMapDirection). Ne concerne que les champs write-back
    -- éligibles (scalaires non liés) ; les linked records restent 'pull'.
    CREATE TABLE IF NOT EXISTS airtable_field_directions (
      module TEXT NOT NULL,
      field_key TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'both',
      PRIMARY KEY (module, field_key)
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

    -- Commentaires + @mentions par enregistrement (fil de discussion lié à une fiche)
    CREATE TABLE IF NOT EXISTS record_comments (
      id TEXT PRIMARY KEY,
      record_type TEXT NOT NULL,
      record_id TEXT NOT NULL,
      author_id TEXT REFERENCES users(id),
      body TEXT NOT NULL,
      mentions TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
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

  // ── Subscription events — détection de "rachat" après churn ──────────────
  // Quand un client se désabonne (category='churn'), il arrive qu'il achète
  // l'équipement à la place plutôt que de continuer la location. Les colonnes
  // ci-dessous tracent ce cas : rachat_status (NULL=non vérifié, 'probable'=auto
  // détecté, 'confirmed'=confirmé manuel, 'none'=pas de rachat), rachat_order_id
  // pointe sur la commande candidate, rachat_checked_at = dernier passage de la
  // détection auto. Cf. logique dans services/subscriptionEvents.js.
  try { db.exec("ALTER TABLE subscription_events ADD COLUMN rachat_status TEXT") } catch {}
  try { db.exec("ALTER TABLE subscription_events ADD COLUMN rachat_order_id TEXT REFERENCES orders(id)") } catch {}
  try { db.exec("ALTER TABLE subscription_events ADD COLUMN rachat_checked_at TEXT") } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_subscription_events_rachat_status ON subscription_events(rachat_status) WHERE rachat_status IS NOT NULL") } catch {}

  // Snapshots des items d'abonnement avant / après l'événement. JSON arrays
  // de { stripe_item_id, stripe_price_id, stripe_product_id, name, quantity,
  // unit_amount, currency, recurring_interval }. Permet à l'UI "Mouvements
  // d'abonnements" d'afficher immédiatement les produits ajoutés/retirés sur
  // un upgrade/downgrade — sans dépendre de la facturation suivante.
  try { db.exec("ALTER TABLE subscription_events ADD COLUMN items_before_json TEXT") } catch {}
  try { db.exec("ALTER TABLE subscription_events ADD COLUMN items_after_json TEXT") } catch {}

  // Miroir de l'état courant des items par abonnement, mis à jour à chaque
  // webhook / polling. Source de vérité pour le snapshot "before" lors du
  // recordEvent suivant (le payload webhook ne contient que l'état nouveau).
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscription_current_items (
      subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id),
      items_json TEXT NOT NULL,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `)

  // Fichiers publics — uploadés par n'importe quel utilisateur authentifié,
  // accessibles ensuite via une URL opaque /erp/p/<token>/<original_name> sans auth.
  db.exec(`
    CREATE TABLE IF NOT EXISTS public_files (
      id TEXT PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER,
      folder TEXT DEFAULT '',
      description TEXT,
      tags TEXT DEFAULT '[]',
      uploaded_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_public_files_folder ON public_files(folder)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_public_files_created ON public_files(created_at DESC)') } catch {}

  try { db.exec("ALTER TABLE tasks ADD COLUMN hubspot_task_id TEXT") } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN last_hubspot_sync TEXT") } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_hubspot_id ON tasks(hubspot_task_id) WHERE hubspot_task_id IS NOT NULL") } catch {}
  try { db.exec("ALTER TABLE users ADD COLUMN hubspot_owner_id TEXT") } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_hubspot_owner ON users(hubspot_owner_id) WHERE hubspot_owner_id IS NOT NULL") } catch {}

  // File d'attente des push HubSpot échoués (ERP → HubSpot). Sans cette
  // persistance, un push fire-and-forget qui échoue (5xx au create, 500
  // récurrent sur tasks/search, etc.) était avalé dans un console.error : l'ERP
  // se croyait synchronisé alors qu'il divergeait silencieusement de HubSpot.
  // Chaque échec est enregistré ici avec un compteur de tentatives et un
  // next_retry_at (backoff exponentiel) ; un worker périodique les rejoue
  // jusqu'à succès, puis la ligne est supprimée.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hubspot_push_failures (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        first_failed_at TEXT,
        last_attempt_at TEXT,
        next_retry_at TEXT
      )
    `)
  } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_hubspot_push_failures_retry ON hubspot_push_failures(next_retry_at)") } catch {}

  // ── File de retry — détection "rachat" après churn ───────────────────────
  // detectRachatForChurn() est appelée en fire-and-forget à l'ingestion du
  // webhook Stripe (recordEvent) et lors des rescans/backfills. Avant cette
  // file, un échec (DB verrouillée, FX indispo, etc.) était avalé dans un
  // catch {} muet : le webhook répondait 200 et un client réellement réabonné
  // restait marqué churné, sans jamais être retenté — divergence silencieuse.
  // Chaque échec est persisté ici avec un compteur de tentatives et un
  // next_retry_at (backoff exponentiel) ; un worker périodique rejoue les
  // events échus jusqu'au succès, puis la ligne est supprimée. Même pattern
  // que hubspot_push_failures. Cf. services/subscriptionEvents.js.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rachat_detect_failures (
        event_id TEXT PRIMARY KEY REFERENCES subscription_events(id) ON DELETE CASCADE,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        first_failed_at TEXT,
        last_attempt_at TEXT,
        next_retry_at TEXT
      )
    `)
  } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_rachat_detect_failures_retry ON rachat_detect_failures(next_retry_at)") } catch {}

  // Indexes
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_automation_logs_auto ON automation_logs(automation_id, created_at)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_record_comments_record ON record_comments(record_type, record_id, created_at)') } catch {}
  for (const sql of migrations) {
    try { db.exec(sql) } catch { /* column already exists */ }
  }

  // Colonnes de l'automation « étiquette de retour » — jamais écrasées par la
  // sync Airtable entrante (returns est synchronisée depuis Airtable). Seed
  // idempotent (INSERT OR IGNORE, clé composite erp_table+column_name) : ne
  // touche pas un gel/dégel fait à la main depuis l'UI ensuite.
  try {
    const freezeReturnColumn = db.prepare(
      `INSERT OR IGNORE INTO airtable_frozen_columns (erp_table, column_name) VALUES ('returns', ?)`
    )
    for (const col of [
      'return_label_pdf_path', 'return_label_tracking_number', 'return_novoxpress_shipment_id',
      'return_carrier', 'return_service_name', 'return_carrier_reason', 'return_label_cost',
      'return_label_created_at', 'return_address_id', 'memo_pdf_path', 'memo_generated_at',
      'instructions_sent_at', 'instructions_interaction_id',
      'return_ups_shipment_id', 'return_label_currency', 'return_label_sent_at',
      'return_label_email_interaction_id',
    ]) freezeReturnColumn.run(col)

    // `instructions_pour_le_receptionniste` est un champ dynamique synced
    // depuis Airtable sur return_items — dès que les watchers de retour (Phase
    // 2) y écrivent, il faut le geler pour ne pas se faire écraser au sync
    // suivant, exactement comme les colonnes returns ci-dessus.
    db.prepare(
      `INSERT OR IGNORE INTO airtable_frozen_columns (erp_table, column_name) VALUES ('return_items', 'instructions_pour_le_receptionniste')`
    ).run()
  } catch { /* table not created yet on very first boot ordering edge case */ }

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

  // Modèle de comptabilisation mémorisé par fournisseur (comme sale_receipts) :
  // pré-rempli depuis le dernier achat publié du même vendor, prioritaire sur la
  // config QB globale au moment du push.
  try { db.exec('ALTER TABLE achats_fournisseurs ADD COLUMN expense_account_id TEXT') } catch {}
  try { db.exec('ALTER TABLE achats_fournisseurs ADD COLUMN payment_account_id TEXT') } catch {}
  try { db.exec('ALTER TABLE achats_fournisseurs ADD COLUMN tax_code_id TEXT') } catch {}

  // Mémo publié dans le champ « Memo » de QuickBooks (PrivateNote). Opt-in : vide,
  // le mémo QB reste vierge (comportement historique). Rempli par les écritures
  // automatiques qui veulent un libellé lisible dans les livres (recharges Twilio).
  try { db.exec('ALTER TABLE achats_fournisseurs ADD COLUMN qb_memo TEXT') } catch {}

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
  // Copies locales des PDFs d'installation/remplacement (chemin relatif à uploads/, ex: products/docs/<id>-installation-fr.pdf)
  try { db.exec('ALTER TABLE products ADD COLUMN lien_pdf_installation_fr_local TEXT') } catch {}
  try { db.exec('ALTER TABLE products ADD COLUMN lien_pdf_installation_en_local TEXT') } catch {}
  try { db.exec('ALTER TABLE products ADD COLUMN lien_pdf_remplacement_fr_local TEXT') } catch {}
  try { db.exec('ALTER TABLE products ADD COLUMN lien_pdf_remplacement_en_local TEXT') } catch {}
  // Étape 5 « Priorité d'assemblage » — champs produits finis synchronisés depuis Airtable (one-way Airtable → ERP)
  try { db.exec('ALTER TABLE products ADD COLUMN assembly_status REAL') } catch {}            // « Status d'assemblage » (%)
  try { db.exec('ALTER TABLE products ADD COLUMN finished_min_stock INTEGER') } catch {}      // « Seuil min. produits fini »
  try { db.exec('ALTER TABLE products ADD COLUMN projected_available_qty INTEGER') } catch {} // « Quantité sera disponible »
  try { db.exec('ALTER TABLE products ADD COLUMN producible_qty INTEGER') } catch {}          // « nombre de produit possible »
  // Étape 4 « Priorité d'assemblage »
  try { db.exec('ALTER TABLE products ADD COLUMN supplier_link TEXT') } catch {}              // « Lien fournisseur » (sync Airtable, bouton externe)
  try { db.exec('ALTER TABLE products ADD COLUMN purchase_snooze_until TEXT') } catch {}      // report étape 4 (ISO UTC Z, nullable)
  // Lien purchases.supplier (texte libre hérité d'Airtable) → companies
  try { db.exec('ALTER TABLE purchases ADD COLUMN supplier_company_id TEXT REFERENCES companies(id)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_purchases_supplier_company ON purchases(supplier_company_id)') } catch {}
  // Fournisseur d'un achat, résolu depuis le champ LIÉ « Fournisseur » d'Airtable
  // (table Fournisseurs) — et non depuis le single-select « Fournisseur - LEGACY »
  // gelé auquel purchases.supplier est mappé. Le nom de la table Fournisseurs est le
  // nom EXACT du fournisseur QuickBooks (variantes « … USD » incluses), ce qui permet
  // de rapprocher un achat LIA d'une facture fournisseur sans appariement flou.
  try { db.exec('ALTER TABLE purchases ADD COLUMN supplier_vendor_name TEXT') } catch {}
  try { db.exec('ALTER TABLE purchases ADD COLUMN supplier_qb_vendor_id TEXT') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_purchases_supplier_vendor ON purchases(supplier_vendor_name)') } catch {}
  // Cache de la table Airtable « Fournisseurs » : rec id → nom canonique + Id vendor QB.
  // Rafraîchi à chaque sync complète des achats ; sert à résoudre le champ lié ci-dessus.
  db.exec(`
    CREATE TABLE IF NOT EXISTS airtable_vendor_links (
      airtable_id TEXT PRIMARY KEY,
      name TEXT,
      qb_vendor_id TEXT,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `)
  // Devise et langue par fournisseur (utilisées pour pré-remplir les PO)
  try { db.exec("ALTER TABLE companies ADD COLUMN currency TEXT DEFAULT 'CAD'") } catch {}
  try { db.exec('ALTER TABLE companies ADD COLUMN language TEXT') } catch {}

  // Géocodage de l'adresse de l'entreprise — mis en cache pour ne pas rappeler
  // Google Places à chaque consultation de la météo au site (GET /api/weather).
  try { db.exec('ALTER TABLE companies ADD COLUMN latitude REAL') } catch {}
  try { db.exec('ALTER TABLE companies ADD COLUMN longitude REAL') } catch {}
  try { db.exec('ALTER TABLE companies ADD COLUMN geocoded_at TEXT') } catch {}

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

  // Retirer le CHECK constraint sur users.role pour permettre l'ajout de nouveaux
  // rôles (rh d'abord) sans devoir migrer la table à chaque fois. Validation
  // côté application dans server/src/routes/admin.js (validRoles).
  const usersDef = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get()
  if (usersDef && usersDef.sql.includes('CHECK(role IN')) {
    const cols = db.pragma('table_info(users)').map(c => c.name)
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec(`
      CREATE TABLE users_new (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ftp_username TEXT,
        phone_number TEXT,
        hubspot_owner_id TEXT,
        employee_id TEXT REFERENCES employees(id),
        timesheet_default_mode TEXT DEFAULT 'simple',
        UNIQUE(email)
      );
    `)
    const knownCols = ['id','email','password_hash','name','role','active','created_at','ftp_username','phone_number','hubspot_owner_id','employee_id','timesheet_default_mode']
    const presentCols = knownCols.filter(c => cols.includes(c))
    const colList = presentCols.map(c => '"' + c + '"').join(', ')
    db.exec(`INSERT INTO users_new (${colList}) SELECT ${colList} FROM users`)
    db.exec('DROP TABLE users')
    db.exec('ALTER TABLE users_new RENAME TO users')
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee ON users(employee_id) WHERE employee_id IS NOT NULL')
    db.exec('PRAGMA foreign_keys = ON')
    console.log('✅ Users: CHECK constraint on role removed (rh now accepted)')
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

  // Unification de la date de création des projets sur le champ `creation`
  // (originellement importé d'Airtable). Les projets créés nativement avant
  // cette unification ont `creation IS NULL` — on remplit avec `created_at`
  // pour avoir un seul champ canonique. Backfill idempotent : ne touche que
  // les lignes vides. Voir routes/projects.js POST qui remplit `creation` à
  // la création pour les futurs projets.
  try {
    const hasCreation = db.pragma('table_info(projects)').some(c => c.name === 'creation')
    if (hasCreation) {
      const r = db.prepare('UPDATE projects SET creation = created_at WHERE creation IS NULL').run()
      if (r.changes > 0) console.log(`✅ Projects: backfilled creation pour ${r.changes} ligne(s)`)
    }
  } catch (e) { console.warn('Projects creation backfill skipped:', e.message) }

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

  // Champs custom — extensions formule / lookup.
  // kind = 'data' : colonne réelle ALTER TABLE ADD COLUMN (l'existant)
  // kind = 'formula' : expression SQLite stockée, exposée via la VUE <table>_v
  //   (pas de colonne physique sur la table source — la vue calcule à la lecture)
  // kind = 'lookup' : pareil que formula mais via un JOIN FK → table cible
  // result_type pilote l'affichage côté client (text/number/date)
  try { db.exec("ALTER TABLE custom_fields ADD COLUMN kind TEXT NOT NULL DEFAULT 'data'") } catch {}
  try { db.exec('ALTER TABLE custom_fields ADD COLUMN formula_expr TEXT') } catch {}
  try { db.exec('ALTER TABLE custom_fields ADD COLUMN lookup_fk TEXT') } catch {}
  try { db.exec('ALTER TABLE custom_fields ADD COLUMN lookup_target_table TEXT') } catch {}
  try { db.exec('ALTER TABLE custom_fields ADD COLUMN lookup_target_column TEXT') } catch {}
  try { db.exec('ALTER TABLE custom_fields ADD COLUMN result_type TEXT') } catch {}
  // kind = 'rollup' : agrège une colonne d'une table ENFANT qui référence la
  //   table source via une FK inverse (ex: projects ← orders.project_id), exposé
  //   via une sous-requête corrélée dans la VUE <table>_v.
  //   rollup_target_table  : table enfant (ex: orders)
  //   rollup_target_fk     : colonne de l'enfant pointant vers source.id (ex: project_id)
  //   rollup_target_column : colonne à agréger (NULL pour COUNT)
  //   rollup_agg           : SUM | COUNT | AVG | MIN | MAX
  try { db.exec('ALTER TABLE custom_fields ADD COLUMN rollup_target_table TEXT') } catch {}
  try { db.exec('ALTER TABLE custom_fields ADD COLUMN rollup_target_fk TEXT') } catch {}
  try { db.exec('ALTER TABLE custom_fields ADD COLUMN rollup_target_column TEXT') } catch {}
  try { db.exec('ALTER TABLE custom_fields ADD COLUMN rollup_agg TEXT') } catch {}
  // view_error : dernier message d'erreur de régénération de la VUE pour ce champ
  // virtuel (formule/lookup/rollup référençant une colonne supprimée/renommée).
  // NULL = sain. Renseigné par regenerateView() qui dégrade la colonne en NULL
  // plutôt que de casser toute la vue, et lu côté client pour afficher #ERROR.
  try { db.exec('ALTER TABLE custom_fields ADD COLUMN view_error TEXT') } catch {}

  // type = 'single_select' : choix unique parmi une liste configurable.
  // `options` (JSON) porte la config : { choices:[{id,label,color}], default_id, alphabetize }.
  // La colonne physique cf_* stocke le LABEL choisi (valeur lisible partout :
  // formules, recherche, exports). Le rendu mappe label→couleur via `options`.
  try { db.exec('ALTER TABLE custom_fields ADD COLUMN options TEXT') } catch {}

  // default_value : valeur par défaut posée à la création d'un record sur les
  // champs kind='data' (text/number/currency/url). Stockée en TEXT ; pour
  // number/currency la colonne cf_* (REAL) coerce le texte numérique. Les
  // single_select utilisent options.default_id, pas cette colonne.
  try { db.exec('ALTER TABLE custom_fields ADD COLUMN default_value TEXT') } catch {}

  // kind = 'link' : champ de LIAISON bidirectionnel à la Airtable. Contrairement
  // au 'lookup' (qui lit une colonne d'un record déjà lié via une FK existante),
  // le 'link' matérialise une vraie relation entre deux tables, stockée dans la
  // table de jonction `custom_field_links`. Créer un champ link engendre
  // automatiquement le CHAMP INVERSE sur la table cible (les deux champs
  // partagent `link_group_id`, donc toute modification d'un côté se reflète
  // instantanément de l'autre — pas de désynchronisation possible).
  //   link_target_table : table pointée par CE champ
  //   link_group_id     : identifiant partagé entre le champ et son inverse
  //   link_role         : 'source' | 'target' — quelle colonne de la jonction
  //                       porte l'id de CE record (source_id ou target_id)
  //   link_single       : 1 si ce côté est limité à un seul record lié
  //                       (one_to_one : 1/1 ; one_to_many : source 0, cible 1 ;
  //                        many_to_many : 0/0)
  // Le champ est virtuel (exposé via la VUE <table>_v en tableau JSON d'ids+labels).
  try { db.exec('ALTER TABLE custom_fields ADD COLUMN link_target_table TEXT') } catch {}
  try { db.exec('ALTER TABLE custom_fields ADD COLUMN link_group_id TEXT') } catch {}
  try { db.exec('ALTER TABLE custom_fields ADD COLUMN link_role TEXT') } catch {}
  try { db.exec('ALTER TABLE custom_fields ADD COLUMN link_single INTEGER DEFAULT 0') } catch {}

  // Table de jonction des champs link. Une ligne = une relation entre un record
  // source et un record cible, rattachée à un `link_group_id` (donc visible par
  // les DEUX champs appariés). L'orientation source/target est fixée à la
  // création (le champ créé en premier est la « source »). La contrainte UNIQUE
  // empêche les doublons ; les index accélèrent la lecture par côté.
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_field_links (
      id TEXT PRIMARY KEY,
      link_group_id TEXT NOT NULL,
      source_table TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_table TEXT NOT NULL,
      target_id TEXT NOT NULL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(link_group_id, source_id, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cfl_group_source ON custom_field_links(link_group_id, source_id);
    CREATE INDEX IF NOT EXISTS idx_cfl_group_target ON custom_field_links(link_group_id, target_id);
  `)

  // Le CHECK historique sur custom_fields.type ne listait que ('text','number'),
  // ce qui rejetait currency/url (latent, jamais déclenché) et bloque maintenant
  // single_select. SQLite ne sait pas ALTER une contrainte CHECK → rebuild guardé
  // et idempotent : ne s'exécute que tant que l'ancien CHECK est présent. La
  // validation des types se fait désormais dans la route (custom-fields.js).
  const cfDef = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='custom_fields'").get()
  if (cfDef && /CHECK\s*\(\s*type\s+IN\s*\(\s*'text'\s*,\s*'number'\s*\)\s*\)/i.test(cfDef.sql)) {
    const cols = db.pragma('table_info(custom_fields)').map(c => c.name)
    const colList = cols.join(', ')
    const rebuild = db.transaction(() => {
      db.exec('ALTER TABLE custom_fields RENAME TO custom_fields__old')
      db.exec(`
        CREATE TABLE custom_fields (
          id TEXT PRIMARY KEY,
          erp_table TEXT NOT NULL,
          name TEXT NOT NULL,
          column_name TEXT NOT NULL,
          type TEXT NOT NULL,
          decimals INTEGER,
          sort_order INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          deleted_at TEXT,
          kind TEXT NOT NULL DEFAULT 'data',
          formula_expr TEXT,
          lookup_fk TEXT,
          lookup_target_table TEXT,
          lookup_target_column TEXT,
          result_type TEXT,
          rollup_target_table TEXT,
          rollup_target_fk TEXT,
          rollup_target_column TEXT,
          rollup_agg TEXT,
          view_error TEXT,
          options TEXT,
          default_value TEXT,
          link_target_table TEXT,
          link_group_id TEXT,
          link_role TEXT,
          link_single INTEGER DEFAULT 0,
          UNIQUE(erp_table, column_name)
        )
      `)
      db.exec(`INSERT INTO custom_fields (${colList}) SELECT ${colList} FROM custom_fields__old`)
      db.exec('DROP TABLE custom_fields__old')
      db.exec('CREATE INDEX IF NOT EXISTS idx_custom_fields_table ON custom_fields(erp_table) WHERE deleted_at IS NULL')
    })
    rebuild()
    console.log('✅ custom_fields: contrainte CHECK(type) élargie (rebuild)')
  }

  // Fusion custom_fields / airtable_field_defs — un champ qui adopte une
  // colonne native pré-existante (alimentée par le sync Airtable) plutôt que
  // de créer sa propre colonne cf_*. `source` distingue le comportement de
  // suppression (jamais de DROP pour 'airtable') ; `airtable_mapping_id`
  // pointe vers airtable_field_mappings.id pour retrouver le mapping Airtable.
  try { db.exec("ALTER TABLE custom_fields ADD COLUMN source TEXT NOT NULL DEFAULT 'native'") } catch {}
  try { db.exec('ALTER TABLE custom_fields ADD COLUMN airtable_mapping_id TEXT') } catch {}

  // ── Palier 1 de l'unification des champs : custom_fields absorbe field_overrides ──
  //
  // Jusqu'ici deux systèmes coexistaient : `custom_fields` pour les champs créés
  // par l'utilisateur, `field_overrides` pour les retouches d'affichage des
  // champs NATIFS (ceux définis en dur dans client/src/lib/tableDefs.js). Deux
  // tables, deux routes, deux modales, deux listes de types — pour un même objet
  // « champ ». Les natifs deviennent donc des lignes de custom_fields avec
  // kind='native'.
  //
  // Conventions propres à kind='native', qui n'a PAS de colonne cf_* à lui :
  //   • column_name    = l'`id` de la colonne dans tableDefs.js. Ce n'est pas
  //                      forcément un nom de colonne SQL (ex. 'full_name',
  //                      'company_name' sont calculés par la requête ou le JSX) —
  //                      d'où l'exclusion de ces lignes partout où une colonne
  //                      physique est supposée (getActiveCustomColumns, la vue
  //                      <table>_v, les défauts à la création).
  //   • erp_table      = clé de vue DataTable, pas forcément une table SQL
  //                      (ex. 'company_orders', 'project_factures').
  //   • name = ''      = pas de renommage ; le libellé de tableDefs fait foi.
  //   • type = ''      = pas de re-typage ; le type de tableDefs fait foi.
  //     Le vide plutôt que NULL parce que les deux colonnes sont NOT NULL, et
  //     plutôt qu'une copie du défaut pour que le code reste la source de vérité :
  //     si tableDefs change un libellé, les champs non personnalisés suivent.
  //   • Revenir à l'original = supprimer la ligne (pas de soft delete) : la
  //     contrainte UNIQUE(erp_table, column_name) ne distingue pas les lignes
  //     supprimées, une ligne fantôme bloquerait toute repersonnalisation.
  //
  // `boolean` (vocabulaire des overrides) devient `checkbox` (vocabulaire des
  // champs perso) : même chose sous deux noms, on n'en garde qu'un.
  try { db.exec('ALTER TABLE custom_fields ADD COLUMN country_code TEXT') } catch {}

  // Masquage GLOBAL d'un champ (palier 2 de l'unification). « Supprimer » un
  // champ natif ne peut pas détruire sa colonne — des routes, des syncs et des
  // fiches en dépendent — mais l'utilisateur doit voir le champ disparaître
  // partout, et pouvoir le récupérer. hidden=1 le retire des tableaux, panneaux,
  // filtres, tris et sélecteurs, sans toucher ni à la colonne ni aux données.
  // À distinguer de la visibilité PAR VUE (table_view_pills.visible_columns),
  // qui est un choix d'affichage local et non une suppression.
  try { db.exec('ALTER TABLE custom_fields ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0') } catch {}

  const hasFieldOverrides = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='field_overrides'"
  ).get()
  if (hasFieldOverrides) {
    const pending = db.prepare(`
      SELECT o.erp_table, o.field_id, o.label, o.type, o.decimals, o.country_code, o.sort_order,
             o.created_at, o.updated_at
      FROM field_overrides o
      WHERE o.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM custom_fields cf
          WHERE cf.erp_table = o.erp_table AND cf.column_name = o.field_id
        )
    `).all()
    if (pending.length) {
      const ins = db.prepare(`
        INSERT INTO custom_fields
          (id, erp_table, name, column_name, type, decimals, country_code, sort_order,
           created_at, updated_at, kind, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'native', 'native')
      `)
      const migrate = db.transaction(rows => {
        for (const r of rows) {
          ins.run(
            randomUUID(), r.erp_table, r.label || '', r.field_id,
            r.type === 'boolean' ? 'checkbox' : (r.type || ''),
            r.decimals, r.country_code, r.sort_order,
            r.created_at || null, r.updated_at || null,
          )
        }
      })
      migrate(pending)
      console.log(`✅ custom_fields: ${pending.length} override(s) de champ natif migré(s) depuis field_overrides`)
    }
  }

  // Table de mapping Airtable ↔ colonne ERP — remplace airtable_field_defs
  // pour tout ce qui concerne le mapping (module/airtable_field_id/import_disabled).
  // Le type/rendu (field_type/display_label) migre vers custom_fields. `options`
  // est CONSERVÉE ici (contrairement au plan initial) : elle porte
  // link_target_table, une config de RÉSOLUTION du sync (quelle table ERP cible
  // un champ lien Airtable), pas de rendu — consommée par convertValue() dans
  // airtableAutoSync.js, indépendamment du type d'affichage choisi par l'utilisateur.
  db.exec(`
    CREATE TABLE IF NOT EXISTS airtable_field_mappings (
      id TEXT PRIMARY KEY,
      module TEXT NOT NULL,
      erp_table TEXT NOT NULL,
      airtable_field_id TEXT,
      airtable_field_name TEXT,
      column_name TEXT NOT NULL,
      options TEXT DEFAULT '{}',
      import_disabled INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(erp_table, column_name)
    );
  `)

  // Migration one-shot airtable_field_defs → (airtable_field_mappings ∪ custom_fields).
  // Guard : ne s'exécute que si airtable_field_defs existe encore ET
  // airtable_field_mappings est vide (jamais migré). airtable_field_defs n'est
  // plus lue/écrite par le reste du code après cette migration — conservée
  // telle quelle un temps comme filet de sécurité (pas de DROP ici).
  {
    const legacyDefsExist = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='airtable_field_defs'"
    ).get()
    if (legacyDefsExist) {
      const alreadyMigrated = db.prepare('SELECT COUNT(*) AS n FROM airtable_field_mappings').get().n > 0
      if (!alreadyMigrated) {
        const rows = db.prepare('SELECT * FROM airtable_field_defs').all()
        const insMap = db.prepare(`
          INSERT INTO airtable_field_mappings
            (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, options, import_disabled, sort_order, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `)
        const insCf = db.prepare(`
          INSERT OR IGNORE INTO custom_fields
            (id, erp_table, name, column_name, type, kind, sort_order, options, source, airtable_mapping_id, created_at, updated_at)
          VALUES (?,?,?,?,?, 'data', ?, ?, 'airtable', ?, ?, ?)
        `)
        // Correspondance field_type (airtable_field_defs) → type (custom_fields).
        function mapLegacyFieldType(row) {
          const ft = row.field_type
          let opts = row.options
          if (typeof opts === 'string') { try { opts = JSON.parse(opts) } catch { opts = null } }
          if (ft === 'link') return { type: 'text', options: { airtable_link_hint: true } }
          if (['text', 'long_text', 'number', 'date', 'checkbox'].includes(ft)) {
            return { type: ft, options: null }
          }
          if (ft === 'single_select' || ft === 'multi_select') {
            const rawChoices = Array.isArray(opts?.choices) ? opts.choices : []
            const choices = rawChoices.map(c => ({
              id: c.id || `opt_${Math.random().toString(36).slice(2, 10)}`,
              label: c.label || c.name || '',
              color: c.color || 'gray',
            })).filter(c => c.label !== '')
            return { type: ft, options: { choices, default_id: null, default_ids: [], alphabetize: false } }
          }
          return { type: 'text', options: null }
        }
        const tx = db.transaction(() => {
          for (const r of rows) {
            insMap.run(r.id, r.module, r.erp_table, r.airtable_field_id, r.airtable_field_name,
              r.column_name, r.options || '{}', r.import_disabled || 0, r.sort_order || 0, r.created_at, r.updated_at)
            const isNative = String(r.airtable_field_id || '').startsWith('native_')
            // Les defs 'native_*' (whitelisting interne) et '__pending__'
            // (colonne jamais matérialisée) ne migrent pas vers custom_fields —
            // bruit inutile dans l'UI « champs custom » (voir plan de fusion).
            if (isNative || r.column_name === '__pending__') continue
            const mapped = mapLegacyFieldType(r)
            const label = r.display_label || r.airtable_field_name || r.column_name
            insCf.run(
              randomUUID(), r.erp_table, label, r.column_name, mapped.type,
              r.sort_order || 0, mapped.options ? JSON.stringify(mapped.options) : null,
              r.id, r.created_at, r.updated_at
            )
          }
        })
        tx()
        console.log(`✅ Migration airtable_field_defs → airtable_field_mappings + custom_fields (${rows.length} lignes)`)
      }
    }
  }

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
    CREATE INDEX IF NOT EXISTS idx_sbt_source ON stripe_balance_transactions(source_id);
    CREATE INDEX IF NOT EXISTS idx_sbt_invoice ON stripe_balance_transactions(stripe_invoice_id);
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

  // Barre de totaux en pied de DataTable — agrégation par colonne (sum/avg/count/min/max).
  // JSON { [colId]: 'sum'|'avg'|'count'|'empty'|'min'|'max' }, comme column_widths.
  try { db.exec("ALTER TABLE table_view_configs ADD COLUMN footer_aggregations TEXT DEFAULT '{}'") } catch {}

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

  // Préférences UI par utilisateur — items/groupes du menu de gauche masqués.
  // Liste JSON de clés cachées (blacklist) : item = route `to`, groupe = `group:<nom>`.
  // Sémantique blacklist => tout nouvel item ajouté au code reste visible par défaut.
  try { db.exec("ALTER TABLE users ADD COLUMN nav_hidden TEXT DEFAULT '[]'") } catch {}

  // Ordre personnalisé du menu de gauche. Objet JSON { "<conteneur>": ["<clé>", …] }
  // où conteneur = 'root' (sections + items à plat) ou `group:<nom>` (sous-items
  // d'une section), et clé = route `to` / `group:<nom>` / href externe.
  // Sémantique partielle => toute clé absente garde sa position par défaut, à la
  // suite des clés ordonnées.
  try { db.exec("ALTER TABLE users ADD COLUMN nav_order TEXT DEFAULT '{}'") } catch {}

  // Préférences d'affichage des décimales par colonne numérique. Objet JSON
  // { "<table>::<field>": <0-5> } : nombre de décimales à afficher dans DataTable
  // pour la colonne `field` de la table `table`. Absent = rendu brut (legacy).
  try { db.exec("ALTER TABLE users ADD COLUMN decimal_preferences TEXT DEFAULT '{}'") } catch {}

  // Largeur (px) du panneau latéral side-peek (RecordPeekDrawer), redimensionnable
  // par l'utilisateur en tirant la frontière gauche du panneau. NULL = défaut applicatif.
  try { db.exec("ALTER TABLE users ADD COLUMN peek_width INTEGER") } catch {}

  // Soft delete des utilisateurs — DELETE /admin/users/:id pose deleted_at (et
  // tombstone l'email pour libérer l'adresse malgré UNIQUE(email)).
  try { db.exec('ALTER TABLE users ADD COLUMN deleted_at TEXT') } catch {}

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

  // Workflow d'approbation / verrouillage des feuilles de temps avant la paie.
  // status : 'draft' (éditable par l'employé) → 'submitted' (verrouillée côté employé, en attente du
  // gestionnaire) → 'approved' (verrouillée pour tous, signée par un gestionnaire). 'rejected' rouvre
  // l'édition côté employé avec un motif. Les colonnes submitted/approved/rejected_by + *_at constituent
  // la piste d'audit conservée jusqu'à la création de la paie.
  try { db.exec("ALTER TABLE timesheet_days ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'") } catch {}
  try { db.exec('ALTER TABLE timesheet_days ADD COLUMN submitted_at TEXT') } catch {}
  try { db.exec('ALTER TABLE timesheet_days ADD COLUMN submitted_by TEXT REFERENCES users(id)') } catch {}
  try { db.exec('ALTER TABLE timesheet_days ADD COLUMN approved_at TEXT') } catch {}
  try { db.exec('ALTER TABLE timesheet_days ADD COLUMN approved_by TEXT REFERENCES users(id)') } catch {}
  try { db.exec('ALTER TABLE timesheet_days ADD COLUMN rejected_at TEXT') } catch {}
  try { db.exec('ALTER TABLE timesheet_days ADD COLUMN rejected_by TEXT REFERENCES users(id)') } catch {}
  try { db.exec('ALTER TABLE timesheet_days ADD COLUMN rejection_reason TEXT') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_timesheet_days_status ON timesheet_days(status) WHERE deleted_at IS NULL') } catch {}

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
      rsde_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_activity_codes_name ON activity_codes(name) WHERE deleted_at IS NULL') } catch {}
  // Migration pour devs qui ont créé la table sans la colonne payable
  try { db.exec('ALTER TABLE activity_codes ADD COLUMN payable INTEGER DEFAULT 1') } catch {}
  // rsde_default = 1 : pré-coche automatiquement la case RSDE des entrées de feuille de
  // temps qui utilisent ce code (l'employé peut toujours décocher au cas par cas).
  try { db.exec('ALTER TABLE activity_codes ADD COLUMN rsde_default INTEGER DEFAULT 0') } catch {}

  // Visibilité des codes d'activité par utilisateur. Sémantique : un code sans aucune
  // ligne dans cette table est *public* (visible à tous, défaut). Dès qu'un user est
  // listé pour un code, le code devient *restreint* à cette liste de users. Les admins
  // ne sont PAS bypass — ils ne voient un code restreint dans leur picker de feuille de
  // temps que s'ils sont eux-mêmes dans la liste. La page de gestion utilise `?all=1`.
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_code_users (
      code_id TEXT NOT NULL REFERENCES activity_codes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (code_id, user_id)
    )
  `)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_activity_code_users_user ON activity_code_users(user_id)') } catch {}

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

  // Courriel du client Stripe (invoice.customer_email) — mapping configurable
  // via la modale « Mapping Stripe » sur /factures. Utile pour identifier les
  // clients Stripe qui n'ont pas d'entreprise dans l'ERP (company_id NULL).
  try { db.exec('ALTER TABLE factures ADD COLUMN customer_email TEXT') } catch {}

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

  // Provenance d'une entreprise créée par un import externe (ex. 'MAPAQ' pour
  // les prospects du registre des exploitations en serre). Distinct de
  // `type_de_source` (Inbound / Outbound / Referral…), qui qualifie l'origine
  // commerciale et reste saisi par l'équipe.
  try { db.exec('ALTER TABLE companies ADD COLUMN source TEXT') } catch {}

  // NEQ — numéro d'entreprise du Québec, clé du Registre des entreprises (REQ).
  // Rempli par la liaison manuelle ou confirmée depuis la fiche entreprise
  // (bloc « Registre des entreprises »), jamais par l'import : le registre est
  // en lecture seule et ne décide pas tout seul qu'une fiche ERP lui correspond.
  try { db.exec('ALTER TABLE companies ADD COLUMN neq TEXT') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_companies_neq ON companies(neq) WHERE neq IS NOT NULL') } catch {}

  // Registre des entreprises du Québec (données ouvertes du Registraire, via
  // Données Québec). Miroir LOCAL et EN LECTURE SEULE : rien ne repart jamais
  // vers le REQ. L'import est purement additif — voir services/reqImport.js,
  // qui fait un upsert par NEQ et ne supprime jamais une ligne (une entreprise
  // disparue d'une livraison garde sa dernière version connue).
  db.exec(`
    CREATE TABLE IF NOT EXISTS req_entreprises (
      neq TEXT PRIMARY KEY,
      nom_legal TEXT,
      nom_normalise TEXT,
      noms_usage TEXT,                 -- JSON: autres noms sous lesquels l'entreprise fait affaire
      statut_immat TEXT,
      date_immat TEXT,                 -- date métier YYYY-MM-DD (pas de composante horaire)
      date_statut_immat TEXT,
      forme_juridique TEXT,
      adresse TEXT,
      ville TEXT,
      province TEXT,
      code_postal TEXT,
      code_activite TEXT,
      desc_activite TEXT,
      code_activite2 TEXT,
      desc_activite2 TEXT,
      source_version TEXT,             -- livraison d'où vient la ligne (nom de fichier / date)
      imported_at TEXT,
      deleted_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `)
  // Nom normalisé : c'est la clé de rapprochement avec companies.name (la
  // recherche par nom exact sur `nom_legal` ne trouve rien, les formes
  // juridiques et les accents diffèrent d'une source à l'autre).
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_req_nom_normalise ON req_entreprises(nom_normalise)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_req_code_activite ON req_entreprises(code_activite)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_req_ville ON req_entreprises(ville)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_req_statut ON req_entreprises(statut_immat)') } catch {}

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

  // Règles de visibilité conditionnelle sur les champs des pages détail.
  // Configurées globalement (admin), évaluées côté client à partir du record
  // courant. `context` = nom de la page/entité (ex. 'facture', 'order'),
  // `field_id` = identifiant stable du champ (passé via <FieldGuard fieldId>),
  // `conditions_json` = arbre AND/OR sérialisé. Si une règle matche, le champ
  // est masqué.
  db.exec(`
    CREATE TABLE IF NOT EXISTS field_visibility_rules (
      id TEXT PRIMARY KEY,
      context TEXT NOT NULL,
      field_id TEXT NOT NULL,
      conditions_json TEXT NOT NULL,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_field_vis_rules_context ON field_visibility_rules(context, field_id)') } catch {}

  // Overrides d'affichage des champs NATIFS (renommage / changement de type)
  // par table — configurés via le menu contextuel d'en-tête de DataTable
  // (« Modifier le champ » sur une colonne non-custom). Ne touche PAS aux
  // colonnes SQL ni aux syncs : l'override est appliqué côté client (label
  // affiché, type d'affichage/tri/filtre). `erp_table` = clé DataTable (ex.
  // 'factures'), `field_id` = id de colonne dans tableDefs.js.
  db.exec(`
    CREATE TABLE IF NOT EXISTS field_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      erp_table TEXT NOT NULL,
      field_id TEXT NOT NULL,
      label TEXT,
      type TEXT,
      decimals INTEGER,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT,
      deleted_at TEXT,
      UNIQUE(erp_table, field_id)
    )
  `)
  // Préférence d'affichage de l'indicatif de pays pour les champs téléphone
  // ('show' | 'hide' | null). Cosmétique : appliquée par PhoneValue côté client.
  try { db.exec('ALTER TABLE field_overrides ADD COLUMN country_code TEXT') } catch {}
  // Ordre d'affichage des champs d'une table (panneau « Champs », modale de
  // configuration des champs). NULL = pas d'ordre explicite → position d'origine
  // dans tableDefs.js / après les champs ordonnés.
  try { db.exec('ALTER TABLE field_overrides ADD COLUMN sort_order INTEGER') } catch {}

  // QB Invoice ID séparé : on crée une Invoice QB + un Receive Payment qui la solde.
  // qb_payment_id porte le Payment, qb_invoice_id porte l'Invoice. Permet le LinkedTxn
  // Payment → Invoice (et Deposit → Payment) supporté par l'API QB.
  // Pour les refunds : qb_invoice_id porte le Credit Memo lié.
  try { db.exec('ALTER TABLE payments ADD COLUMN qb_invoice_id TEXT') } catch {}

  // Deposit QB pour les paiements hors Stripe (chèque, virement, Interac, comptant).
  // Remplace l'ancienne JE / SalesReceipt — le Deposit débite la banque réelle (BNC
  // ou Venn USD selon devise) et crédite AR / 23900 / 41000 selon l'état de la facture.
  // Les rows historiques gardent qb_journal_entry_id ou qb_payment_id.
  try { db.exec('ALTER TABLE payments ADD COLUMN qb_deposit_id TEXT') } catch {}

  // qb_skipped : flag explicite "écriture QB déjà postée manuellement, ne pas
  // re-poster". Posé à la création du payment via skip_qb=true (cas typique :
  // facture Stripe paid-out-of-band dont l'encaissement Interac/chèque a été
  // saisi à la main par le comptable dans QB). Sans ce flag, on ne pourrait
  // pas distinguer "QB échoué à poster, retry possible" de "QB intentionnellement
  // skip" — le bouton Retry afficherait dans les deux cas.
  try { db.exec('ALTER TABLE payments ADD COLUMN qb_skipped INTEGER DEFAULT 0') } catch {}

  // qb_skip_reason : motif énuméré obligatoire quand qb_skipped=1. Sans lui, un
  // skip légitime (déjà comptabilisé via le payout / déjà saisi à la main dans
  // QB / encaissement hors-bande) est indistinguable d'un paiement orphelin
  // jamais arrivé en compta. Valeurs : 'deja_poste_payout', 'saisi_manuellement_qb',
  // 'hors_bande', 'autre' (cf. VALID_QB_SKIP_REASONS dans routes/payments.js).
  try { db.exec('ALTER TABLE payments ADD COLUMN qb_skip_reason TEXT') } catch {}

  // Compte crédité par l'écriture QB liée — capturé depuis QB au moment de la
  // liaison manuelle (suggestions: Deposit/JE/SR). Permet de tracer si l'argent
  // a été crédité aux Revenus perçus d'avance (23900), au compte de ventes
  // (40000), aux Revenus de service (41000) ou aux Comptes clients (12000),
  // sans avoir à rouvrir QB. Le name est dénormalisé pour le rendu, l'id permet
  // de pointer vers le compte en QB si besoin.
  try { db.exec('ALTER TABLE payments ADD COLUMN qb_credit_account_id TEXT') } catch {}
  try { db.exec('ALTER TABLE payments ADD COLUMN qb_credit_account_name TEXT') } catch {}

  // Migration : suppression de la vue virtuelle « Tous ». Pour chaque table sans
  // aucune pill, on crée une pill par défaut basée sur la config admin existante,
  // de sorte que toute table affiche au moins une vue persistante (modifiable et
  // supprimable). Idempotent : skip les tables qui ont déjà ≥ 1 pill.
  const VIEW_TABLES = [
    'companies', 'contacts', 'projects', 'products',
    'orders', 'tickets', 'purchases', 'serial_numbers', 'interactions', 'shipments',
    'abonnements', 'retours', 'factures', 'assemblages', 'achats_fournisseurs', 'tasks',
    'employees', 'paies', 'paie_items', 'bom_items', 'company_serials',
  ]
  const cntPill = db.prepare('SELECT COUNT(*) as c FROM table_view_pills WHERE table_name=?')
  const getCfg = db.prepare('SELECT visible_columns, default_sort FROM table_view_configs WHERE table_name=?')
  const insPill = db.prepare(`
    INSERT INTO table_view_pills (id, table_name, label, color, filters, visible_columns, sort, group_by, collapsed_groups, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const t of VIEW_TABLES) {
    if (cntPill.get(t).c > 0) continue
    const cfg = getCfg.get(t)
    insPill.run(
      randomUUID(), t, 'Tous', 'gray',
      '[]',
      cfg?.visible_columns || '[]',
      cfg?.default_sort || '[]',
      null, '[]', 0,
    )
  }

  // Migration `mois_du_document` → champ formule custom_fields.
  // L'ancienne colonne physique sur `factures` était populée par certains
  // chemins (Airtable sync, refunds backfill) mais pas par le webhook Stripe
  // moderne — résultat : 131 factures avec NULL alors que la valeur est
  // trivialement dérivable de document_date. La nouvelle approche : la
  // formule vit dans custom_fields, exposée via la VUE factures_v.
  try {
    const factCols = db.pragma('table_info(factures)').map(c => c.name)
    if (factCols.includes('mois_du_document')) {
      db.exec('ALTER TABLE factures DROP COLUMN mois_du_document')
      console.log('✅ Factures: dropped mois_du_document column (migré en formule)')
    }
    // Insertion idempotente du champ formule (si déjà présent, skip)
    const exists = db.prepare(
      `SELECT 1 FROM custom_fields WHERE erp_table='factures' AND column_name='cf_mois_du_document' AND deleted_at IS NULL`
    ).get()
    if (!exists) {
      db.prepare(`
        INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind, formula_expr, result_type, sort_order)
        VALUES (?, 'factures', 'Mois du document', 'cf_mois_du_document', 'text', 'formula', 'substr(document_date, 1, 7)', 'text', 0)
      `).run(randomUUID())
      console.log('✅ Factures: champ formule cf_mois_du_document créé')
    }
  } catch (e) {
    console.warn('⚠️  Migration mois_du_document:', e.message)
  }

  // Backfill : remonter l'adresse de livraison du client jusqu'aux orders puis
  // aux shipments quand elle n'est pas définie. Idempotent.
  // Étape 1 — orders sans address_id : on prend l'adresse Livraison de
  // l'entreprise rattachée (ou la 1ère adresse non typée à défaut).
  try {
    const r1 = db.prepare(`
      UPDATE orders
         SET address_id = (
           SELECT a.id FROM adresses a
            WHERE a.company_id = orders.company_id
            ORDER BY (CASE WHEN a.address_type = 'Livraison' THEN 0 ELSE 1 END), a.created_at DESC
            LIMIT 1
         )
       WHERE orders.address_id IS NULL
         AND orders.company_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM adresses a WHERE a.company_id = orders.company_id)
    `).run()
    if (r1.changes > 0) console.log(`✅ Orders: backfilled address_id sur ${r1.changes} commande(s) (livraison entreprise)`)
  } catch (e) {
    console.warn('⚠️  Backfill orders.address_id:', e.message)
  }
  // Étape 2 — shipments sans address_id : on copie celle de la commande parente.
  try {
    const r2 = db.prepare(`
      UPDATE shipments
         SET address_id = (SELECT address_id FROM orders WHERE orders.id = shipments.order_id)
       WHERE shipments.address_id IS NULL
         AND EXISTS (SELECT 1 FROM orders WHERE orders.id = shipments.order_id AND orders.address_id IS NOT NULL)
    `).run()
    if (r2.changes > 0) console.log(`✅ Shipments: backfilled address_id sur ${r2.changes} envoi(s)`)
  } catch (e) {
    console.warn('⚠️  Backfill shipments.address_id:', e.message)
  }

  // Multi-entreprise par contact : table de jointure. `contacts.company_id`
  // reste comme cache de l'entreprise principale (is_primary=1) pour ne pas
  // casser les requêtes existantes.
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_companies (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      role TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(contact_id, company_id)
    )
  `)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_contact_companies_contact ON contact_companies(contact_id)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_contact_companies_company ON contact_companies(company_id)') } catch {}
  // Un seul `is_primary=1` par contact.
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_companies_primary ON contact_companies(contact_id) WHERE is_primary = 1') } catch {}

  // Backfill : pour chaque contact avec company_id non NULL, créer la ligne
  // de jointure principale si elle manque encore.
  try {
    const r = db.prepare(`
      INSERT OR IGNORE INTO contact_companies (id, contact_id, company_id, is_primary)
      SELECT lower(hex(randomblob(16))), ct.id, ct.company_id, 1
      FROM contacts ct
      WHERE ct.company_id IS NOT NULL
        AND ct.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM contact_companies cc
          WHERE cc.contact_id = ct.id AND cc.company_id = ct.company_id
        )
    `).run()
    if (r.changes > 0) console.log(`✅ contact_companies: backfilled ${r.changes} liens (entreprise principale)`)
  } catch (e) {
    console.warn('⚠️  Backfill contact_companies:', e.message)
  }

  // Backfill : recalcule balance_due/status pour les factures non payées par
  // Stripe (paid_at IS NULL) qui ont au moins un paiement local "in". Cas
  // typique : facture Stripe acquittée par Interac/virement/chèque — le webhook
  // Stripe gardait balance_due au montant total parce qu'il ignore le paiement
  // local. Import async pour casser le cycle (factureBalance importe db).
  try {
    const candidates = db.prepare(`
      SELECT DISTINCT f.id
      FROM factures f
      JOIN payments p ON p.facture_id = f.id
      WHERE f.paid_at IS NULL
        AND p.direction = 'in'
    `).all()
    if (candidates.length > 0) {
      import('../services/factureBalance.js').then(({ recomputeFactureBalance }) => {
        let fixed = 0
        for (const c of candidates) {
          const before = db.prepare('SELECT balance_due, status FROM factures WHERE id=?').get(c.id)
          recomputeFactureBalance(c.id)
          const after = db.prepare('SELECT balance_due, status FROM factures WHERE id=?').get(c.id)
          if (Number(before?.balance_due) !== Number(after?.balance_due) || before?.status !== after?.status) {
            fixed++
          }
        }
        if (fixed > 0) console.log(`✅ Factures: backfilled balance_due/status sur ${fixed} facture(s) avec paiement hors Stripe`)
      }).catch(e => console.warn('⚠️  Backfill factures balance_due:', e.message))
    }
  } catch (e) {
    console.warn('⚠️  Backfill factures balance_due (candidats):', e.message)
  }

  // Formulaire de découverte technique — lien qualification + token public court.
  try { db.exec('ALTER TABLE customer_onboarding_responses ADD COLUMN qualification_call_id TEXT') } catch {}
  try { db.exec('ALTER TABLE customer_onboarding_responses ADD COLUMN stripe_subscription_id TEXT') } catch {}
  try { db.exec('ALTER TABLE customer_onboarding_responses ADD COLUMN public_token TEXT') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_onboarding_qual_call ON customer_onboarding_responses(qualification_call_id)') } catch {}
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_public_token ON customer_onboarding_responses(public_token) WHERE public_token IS NOT NULL') } catch {}
  // stripe_session_id existant est NOT NULL UNIQUE — incompatible avec entrées issues de qualification (pas de session).
  // On rend la colonne nullable en recréant la table si elle est encore en NOT NULL.
  try {
    const col = db.prepare("SELECT \"notnull\" AS nn FROM pragma_table_info('customer_onboarding_responses') WHERE name='stripe_session_id'").get()
    if (col && col.nn === 1) {
      db.exec(`
        BEGIN;
        CREATE TABLE customer_onboarding_responses__new (
          id TEXT PRIMARY KEY,
          stripe_session_id TEXT UNIQUE,
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
          qualification_call_id TEXT,
          stripe_subscription_id TEXT,
          public_token TEXT,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        INSERT INTO customer_onboarding_responses__new
          SELECT id, stripe_session_id, stripe_invoice_id, pending_invoice_id, company_id,
                 is_new_site, farm_address_json, shipping_same_as_farm, shipping_address_json,
                 network_access, wifi_ssid, wifi_password, permission_level, num_greenhouses,
                 greenhouses_json, extras_json, extras_pending_invoice_id, status, submitted_at,
                 qualification_call_id, stripe_subscription_id, public_token, created_at, updated_at
            FROM customer_onboarding_responses;
        DROP TABLE customer_onboarding_responses;
        ALTER TABLE customer_onboarding_responses__new RENAME TO customer_onboarding_responses;
        CREATE INDEX IF NOT EXISTS idx_onboarding_invoice ON customer_onboarding_responses(stripe_invoice_id);
        CREATE INDEX IF NOT EXISTS idx_onboarding_company ON customer_onboarding_responses(company_id);
        CREATE INDEX IF NOT EXISTS idx_onboarding_qual_call ON customer_onboarding_responses(qualification_call_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_public_token ON customer_onboarding_responses(public_token) WHERE public_token IS NOT NULL;
        COMMIT;
      `)
      console.log('✅ customer_onboarding_responses : stripe_session_id rendu nullable')
    }
  } catch (e) {
    console.warn('⚠️  Migration customer_onboarding_responses nullable stripe_session_id:', e.message)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS slow_page_loads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      user_id INTEGER,
      user_name TEXT,
      url TEXT NOT NULL,
      load_ms INTEGER NOT NULL
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_slow_page_loads_created_at ON slow_page_loads(created_at DESC)`) } catch {}

  // Index ajoutés pour éliminer SCAN TABLE + TEMP B-TREE FOR ORDER BY sur les list pages.
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC)`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_shipments_created ON shipments(created_at DESC)`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_adresses_company_date ON adresses(company_id, created_at)`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets(created_at)`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_serial_state_changes_date ON serial_state_changes(changed_at)`) } catch {}

  // Pièces jointes polymorphes — un PDF/photo/doc attaché à n'importe quel
  // enregistrement (entité = entity_type + entity_id). Remplace l'ancien modèle
  // spécialisé (qb_attachments restait dédié aux achats fournisseurs / sync QB).
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content_type TEXT,
      file_size INTEGER,
      file_path TEXT NOT NULL,
      uploaded_by TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id, deleted_at)`) } catch {}

  // Commandes DigiKey ramenées par l'API (sens unique DigiKey → ERP). Une ligne
  // par commande suivie : `track_key` = numéro de facture DigiKey quand il existe,
  // sinon numéro de commande — c'est la clé de déduplication de la sync.
  // `raw` conserve la réponse de l'API pour pouvoir calibrer un mapping sans
  // relancer un appel réseau. `pdf_path` est relatif à uploads/ (factures/digikey/…).
  db.exec(`
    CREATE TABLE IF NOT EXISTS digikey_orders (
      id TEXT PRIMARY KEY,
      track_key TEXT NOT NULL UNIQUE,
      sales_order_id TEXT,
      invoice_id TEXT,
      achat_id TEXT REFERENCES achats_fournisseurs(id) ON DELETE SET NULL,
      pdf_path TEXT,
      order_date TEXT,
      total REAL,
      currency TEXT,
      raw TEXT,
      synced_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_digikey_orders_achat ON digikey_orders(achat_id)`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_digikey_orders_date ON digikey_orders(order_date DESC)`) } catch {}

  // Abonnements fournisseurs (SaaS et charges récurrentes) — registre des
  // charges attendues (miroir de l'onglet Abonnements du fichier CTB - Suivi).
  // Sert au croisement « charge attendue ↔ reçu ingéré » et à la resynchro de
  // l'onglet du Google Sheets. L'ERP est la source de vérité.
  db.exec(`
    CREATE TABLE IF NOT EXISTS vendor_subscriptions (
      id TEXT PRIMARY KEY,
      vendor TEXT NOT NULL,
      plan TEXT,
      currency TEXT DEFAULT 'CAD',
      variable INTEGER DEFAULT 0,
      amount REAL,
      amount_label TEXT,
      taxes TEXT,
      frequency TEXT NOT NULL DEFAULT 'Mensuel' CHECK(frequency IN ('Mensuel','Annuel')),
      billing_day INTEGER,
      billing_month INTEGER,
      billing_label TEXT,
      period TEXT,
      payment_method TEXT,
      active INTEGER DEFAULT 1,
      comments TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_vendor_subscriptions_vendor ON vendor_subscriptions(vendor, deleted_at)`) } catch {}
  // Date de désabonnement — posée automatiquement quand `active` passe à 0
  // (bouton « Se désabonner »), effacée à la réactivation. Voir routes/vendor-subscriptions.js.
  try { db.exec(`ALTER TABLE vendor_subscriptions ADD COLUMN cancelled_at TEXT`) } catch {}
  // Page de résiliation chez le fournisseur — ouverte par le bouton
  // « Se désabonner » ; l'abonnement n'est retiré de la liste qu'après
  // confirmation explicite que l'annulation a bien été faite là-bas.
  try { db.exec(`ALTER TABLE vendor_subscriptions ADD COLUMN cancel_url TEXT`) } catch {}

  // Profils fournisseurs — source de vérité ERP des DÉFAUTS COMPTABLES par fournisseur
  // (services/vendorProfiles.js) ET du répertoire de particularités (ex-Google Doc
  // « Fournisseurs_Particularités », rapatrié ici et éditable dans /fournisseurs).
  // Défauts appris à chaque publication QB : vendor QB
  // par devise (un vendor QB ne porte qu'UNE devise — un fournisseur bi-devise a deux
  // vendors), compte de dépense, compte de paiement par devise, type de transaction
  // (statut fiscal), code de taxe par devise, termes de paiement (Net N jours).
  // aliases : autres raisons sociales rencontrées sur les documents (JSON [string]).
  db.exec(`
    CREATE TABLE IF NOT EXISTS vendor_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      aliases TEXT DEFAULT '[]',
      qb_vendor_id_cad TEXT,
      qb_vendor_id_usd TEXT,
      default_qb_type TEXT CHECK(default_qb_type IN ('purchase','bill','cc_credit') OR default_qb_type IS NULL),
      default_expense_account_id TEXT,
      default_payment_account_id_cad TEXT,
      default_payment_account_id_usd TEXT,
      default_transaction_type TEXT,
      default_tax_code_id_cad TEXT,
      default_tax_code_id_usd TEXT,
      payment_terms_days INTEGER,
      notes TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)

  // Particularités du fournisseur — rapatriées du Google Doc « Fournisseurs_Particularités »
  // (jadis synchronisé dans la table vendor_directory). L'ERP est désormais la SEULE source
  // de vérité : ces champs s'éditent dans /fournisseurs et alimentent le prompt d'extraction.
  try { db.exec(`ALTER TABLE vendor_profiles ADD COLUMN usual_currency TEXT`) } catch {}
  try { db.exec(`ALTER TABLE vendor_profiles ADD COLUMN payment_method TEXT`) } catch {}
  try { db.exec(`ALTER TABLE vendor_profiles ADD COLUMN qb_category TEXT`) } catch {}
  try { db.exec(`ALTER TABLE vendor_profiles ADD COLUMN description TEXT`) } catch {}
  try { db.exec(`ALTER TABLE vendor_profiles ADD COLUMN particularites TEXT`) } catch {}
  // Commentaire type du paiement émis (« Virement Interac », « Virement entre comptes »,
  // « Chèque post-daté »…) : c'est la MANIÈRE de payer ce fournisseur, apprise du dernier
  // paiement saisi dans /paiements-emis et re-proposée dès qu'on retape son nom.
  try { db.exec(`ALTER TABLE vendor_profiles ADD COLUMN payment_note TEXT`) } catch {}

  // Migration one-shot vendor_directory → vendor_profiles. La table de miroir est
  // ensuite renommée (jamais droppée : copie de sécurité du dernier état du doc) —
  // son absence rend la migration non réexécutable, donc une édition ERP ultérieure
  // ne peut pas être réécrasée par l'ancien contenu du doc.
  try {
    const hasDirectory = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='vendor_directory'`).get()
    if (hasDirectory) {
      const rows = db.prepare('SELECT * FROM vendor_directory WHERE deleted_at IS NULL').all()
      const findProfile = db.prepare('SELECT id FROM vendor_profiles WHERE deleted_at IS NULL AND LOWER(TRIM(name))=LOWER(TRIM(?))')
      const insertProfile = db.prepare('INSERT INTO vendor_profiles (id, name) VALUES (?,?)')
      // COALESCE : une valeur déjà saisie dans l'ERP prime sur celle du doc.
      const fill = db.prepare(`
        UPDATE vendor_profiles SET
          usual_currency = COALESCE(usual_currency, ?), payment_method = COALESCE(payment_method, ?),
          qb_category = COALESCE(qb_category, ?), description = COALESCE(description, ?),
          particularites = COALESCE(particularites, ?)
        WHERE id = ?
      `)
      db.transaction(() => {
        for (const d of rows) {
          let id = findProfile.get(d.name)?.id
          if (!id) { id = randomUUID(); insertProfile.run(id, String(d.name).trim()) }
          fill.run(d.currency || null, d.payment_method || null, d.qb_category || null,
            d.description || null, d.particularites || null, id)
        }
        const hasLegacy = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='vendor_directory_legacy'`).get()
        db.exec(hasLegacy ? 'DROP TABLE vendor_directory' : 'ALTER TABLE vendor_directory RENAME TO vendor_directory_legacy')
      })()
      console.log(`↪ Répertoire fournisseurs migré dans vendor_profiles (${rows.length} fournisseur(s))`)
    }
  } catch (e) {
    console.error('❌ Migration vendor_directory → vendor_profiles:', e.message)
  }

  // Anomalies fiscales relevées par le mentor comptable dans l'onglet
  // « Fournisseurs_TPS_TVQ_Anomalies » du Google Sheet « Sommaire_Statut fiscal des
  // taxes » (voir services/fiscalAnomaliesSheet.js). Miroir local de l'onglet : une
  // ligne = une transaction mal comptabilisée + le statut fiscal qui aurait dû être
  // utilisé. La sync applique la correction au PROFIL du fournisseur (code de taxe
  // par devise + type de transaction), pour que les prochaines transactions du même
  // fournisseur partent du bon statut. `outcome` garde la trace de ce qui a été fait
  // (appliqué / conflit entre deux lignes du même fournisseur / fournisseur inconnu…)
  // et `applied_at` rend la sync idempotente : une ligne déjà traitée n'écrase jamais
  // une édition faite ensuite dans /fournisseurs.
  db.exec(`
    CREATE TABLE IF NOT EXISTS fiscal_anomalies (
      id TEXT PRIMARY KEY,
      row_key TEXT NOT NULL UNIQUE,
      sheet_date TEXT,
      account_label TEXT,
      vendor_name TEXT,
      amount_text TEXT,
      currency TEXT,
      used_status TEXT,
      correct_status TEXT,
      explanation TEXT,
      vendor_profile_id TEXT,
      outcome TEXT,
      outcome_detail TEXT,
      applied_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)

  // Groupes de doublons de profils fournisseurs marqués « pas des doublons » : la
  // détection (findDuplicateProfileGroups) ne re-propose plus un groupe ignoré tant
  // que sa composition (member_ids = JSON des ids triés) reste identique — un nouveau
  // profil qui rejoint le groupe le fait réapparaître.
  db.exec(`
    CREATE TABLE IF NOT EXISTS vendor_duplicate_dismissals (
      id TEXT PRIMARY KEY,
      member_ids TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)

  // Extraction : échéance de paiement. due_date = date d'échéance (imprimée sur la
  // facture ou calculée depuis les termes) ; payment_terms_days = termes détectés
  // (« Payment due 21 days from date of invoice » → 21) ; vendor_profile_id = profil
  // fournisseur rattaché à l'extraction (ou lazily au premier affichage).
  try { db.exec(`ALTER TABLE sale_receipts ADD COLUMN due_date TEXT`) } catch {}
  try { db.exec(`ALTER TABLE sale_receipts ADD COLUMN payment_terms_days INTEGER`) } catch {}
  try { db.exec(`ALTER TABLE sale_receipts ADD COLUMN vendor_profile_id TEXT`) } catch {}

  // Relevé mensuel d'un fournisseur prépayé (Twilio) joint aux transactions QB du
  // mois couvert — voir services/prepaidStatementAttach.js. Trace du dernier
  // rattachement : quand, quel mois, et le détail par transaction (JSON).
  try { db.exec(`ALTER TABLE sale_receipts ADD COLUMN month_attach_at TEXT`) } catch {}
  try { db.exec(`ALTER TABLE sale_receipts ADD COLUMN month_attach_month TEXT`) } catch {}
  try { db.exec(`ALTER TABLE sale_receipts ADD COLUMN month_attach_result TEXT`) } catch {}

  // Répartition comptable de la paie : JE QB publiée depuis la page Paie.
  try { db.exec(`ALTER TABLE paies ADD COLUMN repartition_je_id TEXT`) } catch {}
  try { db.exec(`ALTER TABLE paies ADD COLUMN repartition_pushed_at TEXT`) } catch {}

  // Comptabilisation de la paie : dépense QB (Purchase BNC, fournisseur
  // « Salaires ») publiée depuis le dashboard comptabilité.
  try { db.exec(`ALTER TABLE paies ADD COLUMN salary_purchase_id TEXT`) } catch {}
  try { db.exec(`ALTER TABLE paies ADD COLUMN salary_purchase_pushed_at TEXT`) } catch {}

  // Total de paie par item (formule Airtable « Paie avec remb. dépenses ») —
  // sert à estimer le débit bancaire d'une paie avant sa comptabilisation.
  try { db.exec(`ALTER TABLE paie_items ADD COLUMN total_pay REAL`) } catch {}
  // Date « Débité » (formule Airtable) : jour où la paie est chargée au compte BNC.
  try { db.exec(`ALTER TABLE paie_items ADD COLUMN debited_date TEXT`) } catch {}

  // Trésorerie BNC — remplace le fichier « Maintien du solde disponible BNC ».
  // treasury_balances : saisies du solde disponible réel (une ligne par saisie,
  // la plus récente sert de point de départ à la projection).
  db.exec(`
    CREATE TABLE IF NOT EXISTS treasury_balances (
      id TEXT PRIMARY KEY,
      account TEXT NOT NULL DEFAULT 'bnc_cad',
      balance REAL NOT NULL,
      noted_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      created_by TEXT REFERENCES users(id)
    )
  `)
  // recurring_outflows : sorties récurrentes du compte (paie, loyer, dettes…).
  db.exec(`
    CREATE TABLE IF NOT EXISTS recurring_outflows (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      amount REAL,
      frequency TEXT NOT NULL DEFAULT 'monthly' CHECK(frequency IN ('weekly','biweekly','monthly','quarterly')),
      day_of_month INTEGER,
      anchor_date TEXT,
      active INTEGER DEFAULT 1,
      notes TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  // Montant variable (ex. relevé Mastercard) : le montant saisi ne vaut que pour
  // la prochaine occurrence suivant sa saisie — à ressaisir à chaque cycle.
  try { db.exec(`ALTER TABLE recurring_outflows ADD COLUMN variable_amount INTEGER DEFAULT 0`) } catch {}
  try { db.exec(`ALTER TABLE recurring_outflows ADD COLUMN amount_entered_at TEXT`) } catch {}

  // Réconciliation de la saisie : à chaque nouveau solde réel, on le compare au
  // solde que la projection annonçait pour ce jour-là (snapshot le plus récent
  // antérieur). Un écart inexpliqué = un mouvement que l'ERP ne connaissait pas
  // — c'est le filet qui a manqué le 1er août 2026 (loyer + facture Les Jardins
  // d'Inverness absents de la projection, 11 864,64 $ de trésorerie fantôme).
  try { db.exec(`ALTER TABLE treasury_balances ADD COLUMN predicted_balance REAL`) } catch {}
  try { db.exec(`ALTER TABLE treasury_balances ADD COLUMN variance REAL`) } catch {}
  try { db.exec(`ALTER TABLE treasury_balances ADD COLUMN predicted_from TEXT`) } catch {}
  try { db.exec(`ALTER TABLE treasury_balances ADD COLUMN variance_note TEXT`) } catch {}
  // Provenance de la saisie : NULL = manuelle (page Trésorerie), 'solde_sheet' =
  // importée du Google Sheet « Maintien du solde disponible BNC » (sync auto).
  try { db.exec(`ALTER TABLE treasury_balances ADD COLUMN source TEXT`) } catch {}

  // treasury_snapshots : photo de la projection à chaque exécution (cron
  // quotidien + saisie de solde). Sans elle, impossible de savoir après coup ce
  // que le système annonçait un jour donné — la projection était recalculée à
  // partir d'aujourd'hui et le passé était perdu.
  db.exec(`
    CREATE TABLE IF NOT EXISTS treasury_snapshots (
      id TEXT PRIMARY KEY,
      snapshot_date TEXT NOT NULL,          -- jour de la projection (YYYY-MM-DD)
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      trigger TEXT,
      scenario TEXT DEFAULT 'certain',
      balance_entry_id TEXT,
      start_balance REAL,
      balance_noted_at TEXT,
      threshold REAL,
      min_balance REAL,
      min_date TEXT,
      action_days INTEGER,
      action_min_balance REAL,
      action_min_date TEXT,
      first_negative_date TEXT,
      first_negative_balance REAL,
      suggested_transfer REAL,
      days TEXT                             -- série quotidienne complète (JSON)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_treasury_snap_date ON treasury_snapshots(snapshot_date)`)

  // treasury_cleared_events : mouvements en retard (datés après la saisie du
  // solde mais avant aujourd'hui) que l'utilisateur confirme déjà sortis du
  // compte. Par défaut ces mouvements restent projetés — prudence : mieux vaut
  // une projection trop basse qu'un découvert. Cette table est l'échappatoire.
  db.exec(`
    CREATE TABLE IF NOT EXISTS treasury_cleared_events (
      event_key TEXT PRIMARY KEY,           -- kind:ref:date
      label TEXT,
      amount REAL,
      event_date TEXT,
      cleared_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      cleared_by TEXT REFERENCES users(id)
    )
  `)

  // treasury_payments : paiements et virements ÉMIS — remplace l'onglet
  // « Pmt_Suivi » du fichier CTB - Suivi (colonne Montant coloriée en vert =
  // passé à la banque).
  //
  // C'est le maillon qui manquait entre « la facture est payée » et « l'argent
  // est sorti du compte » : un virement Interac fait le samedi, un chèque
  // post-daté, un renflouement Mastercard, un virement Venn → BNC n'existaient
  // nulle part dans l'ERP. Marquer une facture « Payée » la faisait simplement
  // disparaître de la projection alors que l'argent était encore au compte —
  // et un paiement post-daté (émis aujourd'hui, débité dans deux semaines)
  // n'était visible d'aucune façon.
  //
  //   cleared_at IS NULL  → émis, PAS encore passé à la banque → projeté
  //   cleared_at NOT NULL → passé au compte (le vert du fichier) → plus projeté
  db.exec(`
    CREATE TABLE IF NOT EXISTS treasury_payments (
      id TEXT PRIMARY KEY,
      payment_date TEXT NOT NULL,            -- date de sortie/entrée (peut être future : post-daté)
      direction TEXT NOT NULL DEFAULT 'out' CHECK(direction IN ('out','in')),
      amount REAL NOT NULL,                  -- toujours positif ; le sens vient de direction
      currency TEXT DEFAULT 'CAD',
      account TEXT DEFAULT 'BNC CAD',        -- compte touché (nom bank_accounts)
      label TEXT,                            -- fournisseur ou libellé du virement
      achat_id TEXT,                         -- facture fournisseur payée (optionnel)
      invoice_number TEXT,
      reference TEXT,                        -- # virement Interac / MC / Visa / code de paiement
      method TEXT,                           -- interac, cheque, carte, transfert, code_paiement, autre
      notes TEXT,
      cleared_at TEXT,                       -- NULL = pas encore passé à la banque
      bank_txn_id TEXT,                       -- transaction du relevé appariée (auto)
      source TEXT DEFAULT 'manual',          -- manual | achat | import
      import_key TEXT,                       -- clé naturelle de la ligne du fichier (idempotence)
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  // Deux informations que la saisie « par moyen de paiement » a rendues
  // nécessaires :
  //   - counterparty_account : l'autre compte d'un mouvement interne. `account`
  //     ne porte que le côté projeté (« BNC Épargne à BNC Chèque » stockait la
  //     provenance dans le libellé), donc un transfert Venn → BNC ou un paiement
  //     de carte perdait la moitié de son sens.
  //   - recipient : le bénéficiaire réel d'un virement Interac ou d'un chèque,
  //     souvent distinct du fournisseur facturé (Interac à Antoine Ratteau pour
  //     Les Jardins d'Inverness).
  try { db.exec(`ALTER TABLE treasury_payments ADD COLUMN counterparty_account TEXT`) } catch {}
  try { db.exec(`ALTER TABLE treasury_payments ADD COLUMN recipient TEXT`) } catch {}
  // Date de la facture réglée — colonne « Date de la facture » de l'onglet
  // Pmt_Suivi, saisie à la main pour chaque ligne (indépendante de l'échéance
  // de la facture liée, quand il y en a une).
  try { db.exec(`ALTER TABLE treasury_payments ADD COLUMN invoice_date TEXT`) } catch {}
  // Détection automatique du « passé à la banque » via le fichier « Maintien du
  // solde disponible BNC » (Charles retire la ligne quand le mouvement passe) :
  //   - sheet_seen_at : dernière sync où une ligne du fichier couvrait ce
  //     paiement. C'est le garde-fou : on n'auto-coche JAMAIS un paiement que le
  //     fichier n'a pas connu, et décocher à la main le remet à NULL pour que
  //     l'automatisme ne re-coche pas par-dessus l'utilisateur.
  //   - cleared_source : qui a coché — manual | bank (relevé) | sheet (fichier).
  try { db.exec(`ALTER TABLE treasury_payments ADD COLUMN sheet_seen_at TEXT`) } catch {}
  try { db.exec(`ALTER TABLE treasury_payments ADD COLUMN cleared_source TEXT`) } catch {}
  // Écriture QuickBooks qui prouve le passage à la banque : le rapport
  // GeneralLedger d'un compte bancaire marque chaque écriture « C » (compensée
  // au flux bancaire) ou « R » (rapprochée) — c'est le signal DIRECT, là où le
  // relevé importé et le fichier de suivi sont des signaux indirects. On garde
  // l'id + le type pour offrir le lien vers la transaction dans QB.
  try { db.exec(`ALTER TABLE treasury_payments ADD COLUMN qb_txn_id TEXT`) } catch {}
  try { db.exec(`ALTER TABLE treasury_payments ADD COLUMN qb_txn_type TEXT`) } catch {}
  db.exec(`CREATE INDEX IF NOT EXISTS idx_treasury_pmt_date ON treasury_payments(payment_date)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_treasury_pmt_achat ON treasury_payments(achat_id)`)
  // Clé naturelle d'import (onglet Pmt_Suivi) : ré-importer ne duplique pas.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_treasury_pmt_import ON treasury_payments(import_key) WHERE import_key IS NOT NULL`)

  // ── Cédule hebdomadaire de paiements fournisseurs ──────────────────────────
  // Une facture qu'on décide de NE PAS payer cette semaine (attente d'un avoir,
  // litige, trésorerie serrée) doit sortir de la cédule proposée sans devenir
  // invisible : le report est explicite, daté et motivé. `defer_until` NULL =
  // reporté sans échéance ; sinon la facture revient dans la cédule ce jour-là.
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_schedule_deferrals (
      achat_id TEXT PRIMARY KEY,
      reason TEXT,
      defer_until TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)

  // Récurrente couverte par les vraies factures d'un fournisseur : le loyer est
  // à la fois une sortie récurrente (6 115,89 $ le 1er) et une facture réelle
  // (Les Jardins d'Inverness, 5 748,75 $ payée par Interac) — les deux étaient
  // comptées, ou l'une masquait l'autre. Avec vendor_match, l'occurrence est
  // remplacée par la facture / le paiement réel quand il existe.
  try { db.exec(`ALTER TABLE recurring_outflows ADD COLUMN vendor_match TEXT`) } catch {}
  // Bornes de vie de la récurrence (YYYY-MM-DD, inclusives). Sans elles, une
  // dette dont les versements ne commencent que dans 2 ans (DEC : 1er novembre
  // 2028) serait projetée dès aujourd'hui, et une dette remboursée continuerait
  // à sortir de l'argent pour toujours. NULL = pas de borne de ce côté.
  try { db.exec(`ALTER TABLE recurring_outflows ADD COLUMN starts_on TEXT`) } catch {}
  try { db.exec(`ALTER TABLE recurring_outflows ADD COLUMN ends_on TEXT`) } catch {}
  // ⚠️ AUCUNE valeur seedée ici. Une tentative de lier « Loyer » aux factures
  // « Les Jardins D'Inverness » était FAUSSE : le loyer est un paiement
  // pré-autorisé (« PMTS ENTREPRISES », 5 863,69 $ vers le 4 du mois) et
  // Inverness / Antoine Ratteau est un fournisseur de CONSULTATION facturé au
  // mois — deux dépenses distinctes, toutes deux à projeter. Le champ ne doit
  // être rempli que par l'utilisateur, pour un cas qu'il a lui-même constaté.

  // ── Rapprochement bancaire ─────────────────────────────────────────────────
  // Remplace le fichier TRX_Orisha.xlsx (un onglet par compte, lignes coloriées
  // à la main). Les transactions de relevés sont importées par collage, puis le
  // statut est dérivé automatiquement du matching avec les documents de l'ERP :
  //   a_traiter        (rouge)  — aucun document trouvé (souvent facture manquante)
  //   facture_recue    (bleu)   — document apparié mais pas encore publié à QB
  //   comptabilise     (jaune)  — document apparié et publié à QB (quickbooks_id)
  //   rapproche        (vert)   — comptabilisé + validé contre le relevé
  //   ignore           (gris)   — hors périmètre (transfert interne, etc.)
  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'bank' CHECK(kind IN ('bank','card')),
      currency TEXT NOT NULL DEFAULT 'CAD',
      account_number TEXT,
      institution TEXT,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES bank_accounts(id),
      txn_date TEXT NOT NULL,
      description TEXT,
      reference TEXT,
      amount REAL NOT NULL,
      balance REAL,
      dedup_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'a_traiter'
        CHECK(status IN ('a_traiter','facture_recue','comptabilise','rapproche','ignore')),
      matched_type TEXT CHECK(matched_type IN ('achat','receipt','stripe_payout') OR matched_type IS NULL),
      matched_id TEXT,
      match_method TEXT CHECK(match_method IN ('auto','manuel') OR match_method IS NULL),
      match_confidence REAL,
      reconciled_at TEXT,
      reconciled_by TEXT REFERENCES users(id),
      comment TEXT,
      import_batch_id TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bank_txn_account ON bank_transactions(account_id, txn_date)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bank_txn_status ON bank_transactions(status)`)
  // Pont QuickBooks : chaque compte bancaire ERP pointe vers son (ou ses,
  // séparés par virgule — ex. BNC USD scindé en 10020+10021 côté QB) compte(s)
  // QB, et chaque transaction bancaire peut mémoriser la transaction QB
  // correspondante trouvée via le rapport GeneralLedger (services/bankQbLink.js).
  try { db.exec(`ALTER TABLE bank_accounts ADD COLUMN qb_account_id TEXT`) } catch {}
  // « Autres détails » du relevé BNC : nature réelle de la transaction (le
  // bénéficiaire, p. ex. « NOVO EXPRESS ») alors que description reste
  // générique (« PMTS ENTREPRISES »). Affiché en premier côté UI.
  try { db.exec(`ALTER TABLE bank_transactions ADD COLUMN details TEXT`) } catch {}
  try { db.exec(`ALTER TABLE bank_transactions ADD COLUMN qb_txn_type TEXT`) } catch {}
  try { db.exec(`ALTER TABLE bank_transactions ADD COLUMN qb_txn_id TEXT`) } catch {}
  // Couleur de la ligne dans TRX_Orisha.xlsx — statut déclaré à la main par
  // Michel : 'vert' (comptabilisée ET rapprochée dans QB), 'jaune'
  // (comptabilisée), 'bleu' (facture retracée), 'rouge' (pas encore
  // comptabilisée). Fait autorité sur ce que l'ERP arrive à déduire.
  try { db.exec(`ALTER TABLE bank_transactions ADD COLUMN sheet_color TEXT`) } catch {}
  // Comment l'écriture QB liée a été retrouvée (voir services/bankQbSearch.js)
  // et l'écart de montant résiduel (frais bancaires, conversion de devise).
  try { db.exec(`ALTER TABLE bank_transactions ADD COLUMN qb_match_method TEXT`) } catch {}
  try { db.exec(`ALTER TABLE bank_transactions ADD COLUMN qb_match_delta REAL`) } catch {}
  // Compte QB où l'écriture a été trouvée quand ce n'est pas celui du relevé
  // (virement interne comptabilisé du côté de l'autre compte).
  try { db.exec(`ALTER TABLE bank_transactions ADD COLUMN qb_match_account TEXT`) } catch {}
  // Taux de change vérifié sur l'objet Transfer de QuickBooks quand la ligne
  // est une conversion de devise (le rapport GeneralLedger affiche le montant
  // en devise de transaction des DEUX côtés — sans le taux, l'écart apparent
  // n'a aucun sens).
  try { db.exec(`ALTER TABLE bank_transactions ADD COLUMN qb_match_rate REAL`) } catch {}
  // Seed du mapping (idempotent, ne touche pas un mapping déjà posé à la main).
  for (const [name, qbId] of [
    ['BNC CAD', '61'], ['BNC USD', '234,168'], ['BNC Épargne', '133'],
    ['MasterCard BNC', '66'], ['Desjardins CAD', '236'], ['Desjardins USD', '237'],
    ['Marge Desjardins', '238'], ['VISA Desjardins CAD', '242'], ['VISA Desjardins USD', '239'],
    ['Venn CAD', '254'], ['Venn USD', '256'],
  ]) {
    db.prepare(`UPDATE bank_accounts SET qb_account_id=? WHERE name=? AND qb_account_id IS NULL`).run(qbId, name)
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_import_batches (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES bank_accounts(id),
      row_count INTEGER DEFAULT 0,
      inserted_count INTEGER DEFAULT 0,
      duplicate_count INTEGER DEFAULT 0,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)

  // ── Comptes prépayés ───────────────────────────────────────────────────────
  // Volet 1 — soldes fournisseurs prépayés (remplace le fichier Twilio_Suivi) :
  // un ledger par fournisseur (recharges vs factures de consommation) alimenté
  // par détection des transactions QuickBooks du fournisseur. Le solde positif =
  // crédit prépayé chez le fournisseur (« il nous doit du service »).
  db.exec(`
    CREATE TABLE IF NOT EXISTS prepaid_accounts (
      id TEXT PRIMARY KEY,
      vendor TEXT NOT NULL,
      currency TEXT DEFAULT 'USD',
      qb_vendor_name TEXT,
      qb_vendor_id TEXT,
      qb_asset_acctnum TEXT,
      balance_provider TEXT,
      sync_start_date TEXT,
      active INTEGER DEFAULT 1,
      notes TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS prepaid_ledger_entries (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES prepaid_accounts(id),
      entry_date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('recharge','facture','ajustement')),
      amount REAL NOT NULL,
      description TEXT,
      source TEXT NOT NULL DEFAULT 'manuel' CHECK(source IN ('qb','import','manuel')),
      qb_txn_type TEXT,
      qb_txn_id TEXT,
      excluded INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_prepaid_ledger_qb_txn ON prepaid_ledger_entries(account_id, qb_txn_type, qb_txn_id) WHERE qb_txn_id IS NOT NULL AND deleted_at IS NULL`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_prepaid_ledger_account ON prepaid_ledger_entries(account_id, entry_date, deleted_at)`) } catch {}
  // Détection auto des recharges Twilio dans le rapprochement bancaire (compte
  // Venn USD) — voir services/prepaid.js:detectTwilioBankRecharges. Une
  // transaction bancaire ne doit jamais générer deux fois la même recharge, et
  // une entrée supprimée à la main (faux positif) ne doit jamais revenir.
  try { db.exec(`ALTER TABLE prepaid_ledger_entries ADD COLUMN bank_transaction_id TEXT`) } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_prepaid_ledger_bank_txn ON prepaid_ledger_entries(bank_transaction_id) WHERE bank_transaction_id IS NOT NULL`) } catch {}
  // Facture (consommation) extraite automatiquement du relevé mensuel joint aux
  // transactions QB — voir services/prepaidStatementAttach.js. Une seule entrée
  // par document (le relevé « facture d'usage », pas le « reçu de paiement »).
  try { db.exec(`ALTER TABLE prepaid_ledger_entries ADD COLUMN sale_receipt_id TEXT`) } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_prepaid_ledger_sale_receipt ON prepaid_ledger_entries(sale_receipt_id) WHERE sale_receipt_id IS NOT NULL AND deleted_at IS NULL`) } catch {}

  // Volet 2 — cédule de continuité des frais payés d'avance (compte #13000,
  // remplace les fichiers FPA_Continuité annuels). Chaque item est amorti
  // mensuellement ; l'écriture Dr dépense / Cr 13000 du mois est préparée par
  // l'ERP puis publiée dans QB après approbation (jamais auto).
  db.exec(`
    CREATE TABLE IF NOT EXISTS prepaid_expenses (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      description TEXT,
      payment_date TEXT,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'CAD',
      method TEXT NOT NULL DEFAULT 'prorata_jours' CHECK(method IN ('prorata_jours','mensuel_fixe','manuel','aucun')),
      monthly_amount REAL,
      amort_start TEXT,
      amort_end TEXT,
      expense_acctnum TEXT,
      fpa_acctnum TEXT DEFAULT '13000',
      active INTEGER DEFAULT 1,
      notes TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  // Une ligne par mois amorti. Les mois calculés (prorata_jours) ne sont
  // matérialisés qu'à la publication ou en cas d'override manuel ; les mois
  // historiques importés (déjà comptabilisés à la main dans QB) portent
  // pushed_at sans qb_je_id.
  db.exec(`
    CREATE TABLE IF NOT EXISTS prepaid_amortizations (
      id TEXT PRIMARY KEY,
      expense_id TEXT NOT NULL REFERENCES prepaid_expenses(id),
      month TEXT NOT NULL,
      amount REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'auto' CHECK(source IN ('auto','manuel','import')),
      qb_je_id TEXT,
      pushed_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_prepaid_amort_month ON prepaid_amortizations(expense_id, month) WHERE deleted_at IS NULL`) } catch {}

  // Montant mensuel constant (méthode 'mensuel_fixe') : la comptable inscrit le
  // même montant chaque mois dans FPA_Continuité et laisse le dernier mois
  // absorber le résidu, plutôt que de proratiser sur les jours réels du mois.
  try { db.exec(`ALTER TABLE prepaid_expenses ADD COLUMN monthly_amount REAL`) } catch {}
  // Le CHECK d'origine ne connaissait pas 'mensuel_fixe' — reconstruction de la
  // table (SQLite ne sait pas modifier une contrainte en place), une seule fois.
  const prepaidDef = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='prepaid_expenses'").get()
  if (prepaidDef && !prepaidDef.sql.includes('mensuel_fixe')) {
    try {
      const newSql = prepaidDef.sql
        .replace(`CHECK(method IN ('prorata_jours','manuel','aucun'))`, `CHECK(method IN ('prorata_jours','mensuel_fixe','manuel','aucun'))`)
        .replace(/CREATE TABLE "?prepaid_expenses"?/, 'CREATE TABLE prepaid_expenses_new')
      db.exec('PRAGMA foreign_keys = OFF')
      db.exec(`
        ${newSql};
        INSERT INTO prepaid_expenses_new SELECT * FROM prepaid_expenses;
        DROP TABLE prepaid_expenses;
        ALTER TABLE prepaid_expenses_new RENAME TO prepaid_expenses;
      `)
      db.exec('PRAGMA foreign_keys = ON')
    } catch (e) {
      db.exec('PRAGMA foreign_keys = ON')
      console.error('⚠️  Migration prepaid_expenses (mensuel_fixe) échouée :', e.message)
    }
  }

  // Lu / non lu sur les reçus (page Extraction de données) — à la Gmail : ligne en
  // gras tant que read_at est NULL, marqué lu à l'ouverture. Le backfill marque lus
  // les reçus existants au moment de la migration (une seule fois : il vit dans le
  // même try que l'ALTER, qui échoue dès que la colonne existe).
  try {
    db.exec(`ALTER TABLE sale_receipts ADD COLUMN read_at TEXT`)
    db.exec(`UPDATE sale_receipts SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE read_at IS NULL`)
  } catch {}

  // ── Dettes à long terme ────────────────────────────────────────────────────
  // Une dette (prêt BDC, DEC, Ville de Québec…) porte sa cédule de remboursement
  // (une ligne par versement : capital + intérêts). La comptabilisation d'un
  // versement publie une JE dans QB : Dr dette (capital) · Dr intérêts · Cr banque.
  // Les versements historiques déjà comptabilisés à la main portent pushed_at
  // sans qb_je_id (même convention que prepaid_amortizations).
  db.exec(`
    CREATE TABLE IF NOT EXISTS lt_debts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      lender TEXT,
      loan_number TEXT,
      currency TEXT DEFAULT 'CAD',
      principal REAL,
      qb_debt_acctnum TEXT,
      qb_interest_acctnum TEXT,
      qb_bank_acctnum TEXT,
      active INTEGER DEFAULT 1,
      notes TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS lt_debt_payments (
      id TEXT PRIMARY KEY,
      debt_id TEXT NOT NULL REFERENCES lt_debts(id),
      seq INTEGER,
      payment_date TEXT NOT NULL,
      principal REAL NOT NULL DEFAULT 0,
      interest REAL NOT NULL DEFAULT 0,
      balance_after REAL,
      source TEXT NOT NULL DEFAULT 'manuel' CHECK(source IN ('import','manuel')),
      qb_txn_id TEXT,
      qb_txn_type TEXT,
      pushed_at TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  // qb_je_id → qb_txn_id : la comptabilisation crée désormais une Dépense QB
  // (Purchase) plutôt qu'une JE ; qb_txn_type ('purchase', NULL = JE legacy)
  // distingue les deux pour les liens QB.
  // Paramètres d'amortissement : ce qu'il faut pour régénérer la cédule (taux
  // annuel en %, cadence, montant du versement régulier) et pour alimenter la
  // récurrente de trésorerie. Renseignés par le générateur de cédule.
  try { db.exec(`ALTER TABLE lt_debts ADD COLUMN annual_rate REAL`) } catch {}
  try { db.exec(`ALTER TABLE lt_debts ADD COLUMN payment_frequency TEXT`) } catch {}
  try { db.exec(`ALTER TABLE lt_debts ADD COLUMN payment_amount REAL`) } catch {}
  try { db.exec(`ALTER TABLE lt_debt_payments RENAME COLUMN qb_je_id TO qb_txn_id`) } catch {}
  try { db.exec(`ALTER TABLE lt_debt_payments ADD COLUMN qb_txn_type TEXT`) } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_lt_debt_payment_date ON lt_debt_payments(debt_id, payment_date) WHERE deleted_at IS NULL`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_lt_debt_payments_debt ON lt_debt_payments(debt_id, payment_date, deleted_at)`) } catch {}

  // ── Douanes — relevé CARM (GCRA) de l'ASFC ─────────────────────────────────
  // Une ligne par transaction du relevé téléchargé du portail CARM (droits,
  // TPS à l'importation, paiements, intérêts…). montant signé : positif = dû
  // à l'ASFC, négatif = paiement/crédit. sale_receipt_id = reçu correspondant
  // dans l'extracteur (c'est lui qui porte le push QuickBooks). import_key =
  // clé naturelle de dédup — ré-importer le même relevé n'insère rien.
  db.exec(`
    CREATE TABLE IF NOT EXISTS carm_transactions (
      id TEXT PRIMARY KEY,
      transaction_date TEXT NOT NULL,
      due_date TEXT,
      transaction_type TEXT,
      transaction_number TEXT,
      description TEXT,
      amount REAL NOT NULL,
      balance REAL,
      currency TEXT DEFAULT 'CAD',
      sale_receipt_id TEXT REFERENCES sale_receipts(id),
      match_source TEXT,
      import_key TEXT,
      source TEXT NOT NULL DEFAULT 'import' CHECK(source IN ('import','manuel')),
      notes TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_carm_import_key ON carm_transactions(import_key) WHERE import_key IS NOT NULL`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_carm_txn_date ON carm_transactions(transaction_date, deleted_at)`) } catch {}
  // Nature comptable de la ligne, déduite du code de transaction ASFC
  // (B3 → évaluation, C1 → correction, IN → intérêts, LP/LD → paiement) et
  // corrigeable à la main. Elle décide de l'écriture : une évaluation se
  // ventile en droits (dépense) + TPS à l'importation (CTI récupérable),
  // un paiement ne touche que le bilan, des intérêts sont une charge
  // financière sans taxe. duty_amount / gst_amount portent cette ventilation
  // quand elle est connue (le relevé détaillé du portail la donne ligne par
  // ligne ; sinon elle se saisit dans la fiche).
  try { db.exec(`ALTER TABLE carm_transactions ADD COLUMN category TEXT`) } catch {}
  try { db.exec(`ALTER TABLE carm_transactions ADD COLUMN duty_amount REAL`) } catch {}
  try { db.exec(`ALTER TABLE carm_transactions ADD COLUMN gst_amount REAL`) } catch {}

  // Comptabilisation automatique (moteur ASFC → QuickBooks).
  //   party  : « fournisseur » du relevé — dit QUI paie (Orisha, FedEx, UPS, Axxess…)
  //   detail : description détaillée du portail — dit CE QUE c'est (TPS, droits, surtaxe…)
  // De ces deux colonnes découlent kind / payer / ventilation droits-TPS, posées
  // automatiquement à l'import (split_source='auto') et jamais réécrites une fois
  // que l'utilisateur a corrigé à la main (split_source='manuel').
  // Modèle comptable : le compte ASFC EST le solde du fournisseur ASFC dans le
  // compte 21000 (Comptes fournisseurs) — charges en factures fournisseur, nos
  // paiements en dépense imputée à 21000. Les lignes payées par un courtier ne
  // sont jamais poussées : la dépense et la TPS arrivent par sa facture.
  try { db.exec(`ALTER TABLE carm_transactions ADD COLUMN party TEXT`) } catch {}
  try { db.exec(`ALTER TABLE carm_transactions ADD COLUMN detail TEXT`) } catch {}
  try { db.exec(`ALTER TABLE carm_transactions ADD COLUMN kind TEXT`) } catch {}
  try { db.exec(`ALTER TABLE carm_transactions ADD COLUMN payer TEXT`) } catch {}
  try { db.exec(`ALTER TABLE carm_transactions ADD COLUMN broker TEXT`) } catch {}
  try { db.exec(`ALTER TABLE carm_transactions ADD COLUMN split_source TEXT`) } catch {}
  try { db.exec(`ALTER TABLE carm_transactions ADD COLUMN split_rule TEXT`) } catch {}
  try { db.exec(`ALTER TABLE carm_transactions ADD COLUMN offset_txn_id TEXT REFERENCES carm_transactions(id)`) } catch {}
  try { db.exec(`ALTER TABLE carm_transactions ADD COLUMN posting_state TEXT`) } catch {}
  try { db.exec(`ALTER TABLE carm_transactions ADD COLUMN skip_reason TEXT`) } catch {}
  try { db.exec(`ALTER TABLE carm_transactions ADD COLUMN posting_error TEXT`) } catch {}
  try { db.exec(`ALTER TABLE carm_transactions ADD COLUMN posting_group TEXT`) } catch {}
  try { db.exec(`ALTER TABLE carm_transactions ADD COLUMN qb_txn_id TEXT`) } catch {}
  try { db.exec(`ALTER TABLE carm_transactions ADD COLUMN qb_txn_type TEXT`) } catch {}
  try { db.exec(`ALTER TABLE carm_transactions ADD COLUMN qb_pushed_at TEXT`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_carm_posting_state ON carm_transactions(posting_state, deleted_at)`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_carm_posting_group ON carm_transactions(posting_group)`) } catch {}

  // Lettrage paiement → charges (FIFO), pour EXPLIQUER le relevé : quelles charges
  // un versement règle, combien reste en crédit au portail. Aucune écriture n'en
  // dépend — la double-entrée (dépense vers 21000 / factures depuis 21000) suffit.
  db.exec(`
    CREATE TABLE IF NOT EXISTS carm_allocations (
      id TEXT PRIMARY KEY,
      payment_txn_id TEXT NOT NULL REFERENCES carm_transactions(id),
      charge_txn_id TEXT NOT NULL REFERENCES carm_transactions(id),
      amount REAL NOT NULL,
      method TEXT NOT NULL DEFAULT 'fifo' CHECK(method IN ('fifo','manuel')),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_carm_alloc_pair ON carm_allocations(payment_txn_id, charge_txn_id) WHERE deleted_at IS NULL`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_carm_alloc_charge ON carm_allocations(charge_txn_id, deleted_at)`) } catch {}

  // ── Écritures de fin de mois (provisions) ──────────────────────────────────
  // Remplace les fichiers Drive « Provisions_mensuelles_CTB » et
  // « R&D_Suivi_Feuilles de temps ». Deux provisions récurrentes :
  //   • crédit d'impôt R&D (RS&DE) : heures R&D du mois × taux × majoration,
  //     projeté sur 12 mois, × taux de réclamation, ramené sur 1 mois ;
  //   • subvention salariale (Biotalent, LB) : salaire brut du mois × 60 %,
  //     plafonné à la contribution maximale sur la fenêtre d'admissibilité.
  // Même convention que les FPA : l'ERP calcule et prépare la JE, la
  // publication dans QuickBooks se fait après approbation, jamais en auto.

  // Heures R&D par employé et par mois. Alimentées par l'import mensuel du
  // fichier Drive feuille_de_temps_{mois}_{année}.xlsx (un onglet par employé,
  // colonne « Heures RSDE »), corrigeables à la main. Les sous-traitants
  // (contractor = 1, ex. Antoine Ratheau) sont suivis mais exclus du calcul de
  // la provision — ils ne sont pas des employés d'Orisha.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rd_month_hours (
      id TEXT PRIMARY KEY,
      month TEXT NOT NULL,
      employee_name TEXT NOT NULL,
      employee_id TEXT REFERENCES employees(id),
      hours REAL NOT NULL DEFAULT 0,
      contractor INTEGER DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'import' CHECK(source IN ('import','manuel','erp','seed')),
      drive_file_id TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  // `hours` = valeur retenue (l'addition des lignes datées, recalculée par
  // l'ERP, ou une correction manuelle). Les deux colonnes suivantes gardent ce
  // qu'on a lu dans la feuille de temps pour rendre les écarts visibles :
  // `day_hours` = l'addition des lignes au dernier import, `file_total_hours` =
  // la ligne « total » du fichier (formule pas toujours juste).
  try { db.exec(`ALTER TABLE rd_month_hours ADD COLUMN day_hours REAL`) } catch {}
  try { db.exec(`ALTER TABLE rd_month_hours ADD COLUMN file_total_hours REAL`) } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rd_hours_month_emp ON rd_month_hours(month, employee_name) WHERE deleted_at IS NULL`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_rd_hours_month ON rd_month_hours(month, deleted_at)`) } catch {}

  // Déboursés mensuels en pièces (procédure Pièces_Déboursés_<mois>).
  // Une ligne par mois : les trois composantes du calcul, le détail des
  // opérations figé au moment du calcul (lines_json — ce qui a été mis dans le
  // fichier Drive), et la trace du dépôt Drive puis de l'envoi Slack.
  // `override_debut` / `override_fin` laissent le comptable corriger un montant
  // sans toucher au calcul : c'est lui qui signe le chiffre envoyé.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pieces_disbursements (
      month TEXT PRIMARY KEY,
      achats REAL,
      a_payer_debut REAL,
      a_payer_fin REAL,
      override_debut REAL,
      override_fin REAL,
      lines_json TEXT,
      drive_file_id TEXT,
      drive_url TEXT,
      drive_name TEXT,
      generated_at TEXT,
      slack_sent_at TEXT,
      slack_sent_by TEXT REFERENCES users(id),
      slack_text TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)

  // Définition d'une provision. `config` (JSON) porte les paramètres de la
  // grille de calcul — ce sont les cellules bleues des fichiers Excel, rendues
  // éditables dans l'interface plutôt que gelées dans du code.
  db.exec(`
    CREATE TABLE IF NOT EXISTS month_end_provisions (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('rd_credit','wage_subsidy')),
      description TEXT,
      config TEXT,
      debit_acctnum TEXT,
      credit_acctnum TEXT,
      memo TEXT,
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)

  // Une ligne par provision et par mois. Comme prepaid_amortizations : les mois
  // calculés ne sont matérialisés qu'à la publication, à l'override manuel ou à
  // la saisie d'un intrant ; les mois historiques déjà comptabilisés à la main
  // portent pushed_at sans qb_je_id. `inputs` (JSON) garde les intrants du mois
  // (ex. PARI reçu) et `computed` la trace du calcul au moment de la publication.
  db.exec(`
    CREATE TABLE IF NOT EXISTS month_end_provision_months (
      id TEXT PRIMARY KEY,
      provision_id TEXT NOT NULL REFERENCES month_end_provisions(id),
      month TEXT NOT NULL,
      amount REAL,
      override_amount REAL,
      inputs TEXT,
      computed TEXT,
      source TEXT NOT NULL DEFAULT 'auto' CHECK(source IN ('auto','manuel','import')),
      qb_je_id TEXT,
      pushed_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_month_end_prov_month ON month_end_provision_months(provision_id, month) WHERE deleted_at IS NULL`) } catch {}

  // Rapprochement encaissement de la subvention salariale (Biotalent, Louis-
  // Bernard) : la provision mensuelle est une estimation, le montant réel versé
  // peut différer. `wage_subsidy_receipts` suit ce qui a été réellement reçu
  // (indépendant du calendrier des mois provisionnés) ; `wage_subsidy_adjustments`
  // journalise chaque régularisation Dr/Cr 12400 ↔ 49000 déjà publiée, pour ne
  // jamais régulariser deux fois le même écart. Voir services/wageSubsidyReceipts.js.
  db.exec(`
    CREATE TABLE IF NOT EXISTS wage_subsidy_receipts (
      id TEXT PRIMARY KEY,
      provision_id TEXT NOT NULL REFERENCES month_end_provisions(id),
      received_date TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_wage_subsidy_receipts_prov ON wage_subsidy_receipts(provision_id, deleted_at)`) } catch {}
  // Détection automatique depuis le rapprochement bancaire (services/bankReconciliation.js
  // matche `config.bank_match_label` de la provision contre bank_transactions.description) :
  // `source` distingue une saisie manuelle d'une ligne trouvée dans le relevé, et
  // `bank_transaction_id` empêche de détecter deux fois la même transaction — y compris
  // si l'utilisateur supprime la ligne détectée (faux positif), d'où l'absence de filtre
  // deleted_at sur la contrainte : une transaction rejetée ne revient jamais.
  try { db.exec(`ALTER TABLE wage_subsidy_receipts ADD COLUMN source TEXT NOT NULL DEFAULT 'manuel' CHECK(source IN ('manuel','banque'))`) } catch {}
  try { db.exec(`ALTER TABLE wage_subsidy_receipts ADD COLUMN bank_transaction_id TEXT REFERENCES bank_transactions(id)`) } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wage_subsidy_receipts_bank_txn ON wage_subsidy_receipts(bank_transaction_id)`) } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS wage_subsidy_adjustments (
      id TEXT PRIMARY KEY,
      provision_id TEXT NOT NULL REFERENCES month_end_provisions(id),
      amount REAL NOT NULL,
      memo TEXT,
      qb_je_id TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_wage_subsidy_adj_prov ON wage_subsidy_adjustments(provision_id, deleted_at)`) } catch {}

  // Anomalies transactionnelles : doublons probables, montants hors norme, devise
  // incohérente — détectées à l'extraction des reçus et par scan périodique.
  // fingerprint = clé stable de l'anomalie (dédup entre scans) ; une anomalie
  // 'dismissed' n'est jamais recréée pour le même fingerprint.
  db.exec(`
    CREATE TABLE IF NOT EXISTS transaction_anomalies (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('high','medium','low')),
      message TEXT NOT NULL,
      details TEXT,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','dismissed','resolved')),
      dismissed_by TEXT REFERENCES users(id),
      dismissed_reason TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_anomalies_fp ON transaction_anomalies(fingerprint)`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_txn_anomalies_entity ON transaction_anomalies(entity_type, entity_id, status)`) } catch {}

  // ── Travaux (page /travaux) ────────────────────────────────────────────────
  // Quatre listes distinctes, volontairement séparées :
  //   work_prompts      — la file de prompts de l'utilisateur, exécutée une à la
  //                       fois par l'agent (remplace le Google Doc de prompts).
  //   work_suggestions  — les recommandations générées par l'agent lui-même ;
  //                       jamais mélangées à la file humaine, promues sur demande.
  //   work_ideas        — le carnet d'idées de l'utilisateur : rien ne s'exécute
  //                       depuis là, une idée se garde et se relit.
  //   recurring_tasks   — les travaux récurrents du fichier Travaux_OS_ML (Drive),
  //                       cochés par période dans recurring_task_completions.
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_prompts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      -- 'queued' = en attente de son tour ; 'running' = tâche agent en cours ;
      -- 'done'/'blocked' recopient le sort de la tâche agent ; 'paused' = mise de
      -- côté par l'utilisateur (jamais ramassée par l'ordonnanceur).
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued','running','done','blocked','paused','cancelled')),
      position REAL NOT NULL DEFAULT 0,
      -- Enchaîne dans la MÊME session Claude que l'item précédent (--resume) au
      -- lieu de repartir d'un contexte neuf : pour les prompts qui poursuivent le
      -- travail du précédent. Le défaut (0) = contexte remis à zéro.
      same_context INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'implement' CHECK(mode IN ('implement','question')),
      preset TEXT NOT NULL DEFAULT 'deep',
      agent_task_id TEXT,
      -- Session Claude de l'exécution, pour que l'item suivant puisse la reprendre.
      session_id TEXT,
      suggestion_id TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      started_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_work_prompts_status ON work_prompts(status, position)`) } catch {}
  // Titre géré par l'app (déduit du prompt puis du fil de discussion) plutôt que
  // saisi à la main. Passe à 0 dès que l'utilisateur écrit son propre titre — un
  // titre choisi n'est JAMAIS réécrit. Défaut 0 : les items d'avant la
  // fonctionnalité gardent le leur, seul un item créé sans titre devient dynamique.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN title_auto INTEGER NOT NULL DEFAULT 0`) } catch {}
  // Préréglage (Rapide/Standard/Approfondi) choisi par l'app plutôt que par
  // l'utilisateur : `preset` garde toujours une clé concrète (c'est elle que lit
  // l'ordonnanceur), ce flag dit qu'elle a été jugée automatiquement — et qu'une
  // reclassification peut la réécrire. Même contrat que title_auto : passe à 0
  // dès que l'utilisateur choisit lui-même, et plus rien n'y touche.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN preset_auto INTEGER NOT NULL DEFAULT 0`) } catch {}
  // Question posée par l'agent à la fin d'une exécution, en JSON : { question, options[] }.
  // Une tâche détachée n'a pas de terminal — elle ne peut pas demander « laquelle des
  // deux ? » et devinait. Elle écrit désormais sa question ici, la carte l'affiche avec
  // ses choix, et un clic répond via le fil (ce qui relance la tâche). NULL = rien à
  // répondre. Colonne plutôt qu'un statut : le CHECK ci-dessus ne se modifie pas sans
  // reconstruire la table, et « terminé + question en attente » est un état réel.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN pending_question TEXT`) } catch {}
  // « Arrête après celle-ci » : une fois cet item terminé, l'ordonnanceur se met en
  // pause au lieu d'enchaîner. Sert à borner la consommation de jetons Claude sans
  // avoir à surveiller la file (ex. la nuit, garder du quota pour l'équipe du matin).
  // 0 = enchaîne normalement.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN stop_after INTEGER NOT NULL DEFAULT 0`) } catch {}
  // Deux files distinctes sur la même table : 'finance' (Espace finance → Travaux)
  // et 'agent' (section Agent → Travaux de l'agent). Chaque page ne montre que la
  // sienne ; l'exécuteur, lui, est partagé (une seule implémentation à la fois,
  // toutes files confondues).
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN space TEXT NOT NULL DEFAULT 'finance'`) } catch {}
  // Relance « avec le fil » : le prochain départ de cet item est une SUITE de
  // conversation (réponse de l'utilisateur après une exécution) — le brief est le
  // fil complet et la session Claude précédente est reprise. Posé quand on répond
  // à un item terminé (tout de suite, ou remis à la fin de la file), consommé à la
  // fin de l'exécution. 0 = départ normal sur le prompt d'origine.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN follow_up INTEGER NOT NULL DEFAULT 0`) } catch {}
  // Marqueur « lu » façon boîte mail : posé quand l'utilisateur OUVRE une conversation
  // terminée (done/blocked/cancelled). NULL tant que le résultat n'a pas été consulté —
  // la carte « Conversations » s'affiche alors en gras pour qu'une tâche terminée non
  // relue ne se perde jamais dans la liste. Une relance (follow_up / reprise) le remet à
  // NULL : la nouvelle réponse de l'agent redevient « à lire ».
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN seen_at TEXT`) } catch {}

  // Fil de discussion d'un item de la file : chaque tâche a SA conversation, qui
  // survit aux exécutions successives (une relance crée une nouvelle tâche agent,
  // pas un nouveau fil). C'est ce qui permet de répondre à une demande de précision
  // depuis l'ERP, et de garder la trace même quand la session Claude a été purgée —
  // le fil est alors réinjecté en résumé dans le prompt de la relance.
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_prompt_messages (
      id TEXT PRIMARY KEY,
      prompt_id TEXT NOT NULL REFERENCES work_prompts(id),
      role TEXT NOT NULL CHECK(role IN ('user','agent')),
      text TEXT NOT NULL,
      -- Tâche agent qui a produit le message (côté agent) ou qu'il a déclenchée
      -- (côté humain) : permet de relier un tour de conversation à son exécution.
      agent_task_id TEXT,
      author TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_work_prompt_msgs ON work_prompt_messages(prompt_id, created_at)`) } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS work_suggestions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      rationale TEXT,
      prompt TEXT NOT NULL,
      area TEXT,
      -- 'chantier'    = un travail à faire dans l'ERP tel qu'il est ;
      -- 'integration' = un logiciel / une API externe à brancher (ce que ça
      --                 débloquerait). Deux moteurs distincts, une seule liste.
      kind TEXT NOT NULL DEFAULT 'chantier',
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','accepted','dismissed')),
      -- Empreinte de déduplication : une même recommandation ne revient pas à
      -- chaque passage du moteur, même après avoir été rejetée.
      fingerprint TEXT NOT NULL,
      work_prompt_id TEXT,
      dismissed_reason TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`ALTER TABLE work_suggestions ADD COLUMN kind TEXT NOT NULL DEFAULT 'chantier'`) } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_work_suggestions_fp ON work_suggestions(fingerprint)`) } catch {}

  // Fil de discussion d'une suggestion : avant de la mettre dans sa file (ou de la
  // rejeter), on peut demander à Claude d'en dire plus — pourquoi maintenant, ce que
  // ça change concrètement, ce que coûte l'outil externe d'une intégration. La
  // discussion n'exécute RIEN : elle vit à côté de la suggestion, pas dans la file.
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_suggestion_messages (
      id TEXT PRIMARY KEY,
      suggestion_id TEXT NOT NULL REFERENCES work_suggestions(id),
      role TEXT NOT NULL CHECK(role IN ('user','agent')),
      text TEXT NOT NULL,
      author TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_work_suggestion_msgs ON work_suggestion_messages(suggestion_id, created_at)`) } catch {}

  // Idées (onglet « Idées ») : le carnet de l'utilisateur. Rien ne s'exécute
  // jamais depuis cette liste — une idée est là pour être gardée et relue, pas
  // pour être faite. Elle ne rejoint la file que par une promotion explicite,
  // et y arrive « de côté » (voir promoteIdea dans workIdeas.js).
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_ideas (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      -- Développement libre de l'idée (le « pourquoi », les pistes…).
      notes TEXT,
      -- Thème libre saisi par l'utilisateur, purement pour regrouper l'œil.
      tag TEXT,
      -- Ordre du carnet, réordonnable à la main comme la file.
      position REAL NOT NULL DEFAULT 0,
      -- Item de file créé par une promotion, pour ne pas promouvoir deux fois.
      work_prompt_id TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_work_ideas_pos ON work_ideas(position)`) } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS recurring_tasks (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      -- 'adhoc' = à faire une seule fois (pas de période) ; les autres cadences
      -- génèrent une occurrence par période et se cochent période par période.
      -- 'bihebdo' = deux fois par semaine (mardi et samedi) : deux occurrences
      -- par semaine, cochées séparément.
      cadence TEXT NOT NULL DEFAULT 'hebdo'
        CHECK(cadence IN ('hebdo','bihebdo','mensuel','trimestriel','annuel','adhoc')),
      owner TEXT NOT NULL DEFAULT 'AL',
      -- Indice de calendrier libre affiché sur la ligne (« mardi », « le 25 »…).
      day_hint TEXT,
      notes TEXT,
      due_date TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      position REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manuel',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_recurring_tasks_owner ON recurring_tasks(owner, cadence, position)`) } catch {}
  // Jour du mois où le travail est dû (1-31), pour les cadences mensuelles :
  // « Payer Visa » le 25 doit crier avant le 25, pas se contenter d'exister.
  // day_hint reste l'indice libre affiché ; due_day est la version calculable.
  try { db.exec(`ALTER TABLE recurring_tasks ADD COLUMN due_day INTEGER`) } catch {}
  // La cadence 'bihebdo' est arrivée après la création de la table : sur une DB
  // existante, le CHECK refuse encore la valeur, et SQLite ne sait pas modifier
  // une contrainte en place. On reconstruit donc la table (procédure officielle
  // SQLite), UNE SEULE FOIS — le garde-fou est le texte du CHECK lui-même, donc
  // une DB déjà reconstruite (ou toute neuve) passe à côté sans rien faire.
  try {
    const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='recurring_tasks'`).get()?.sql || ''
    if (ddl && !ddl.includes("'bihebdo'")) {
      db.pragma('foreign_keys = OFF')
      try {
        db.transaction(() => {
          db.exec(`
            CREATE TABLE recurring_tasks_new (
              id TEXT PRIMARY KEY,
              label TEXT NOT NULL,
              cadence TEXT NOT NULL DEFAULT 'hebdo'
                CHECK(cadence IN ('hebdo','bihebdo','mensuel','trimestriel','annuel','adhoc')),
              owner TEXT NOT NULL DEFAULT 'AL',
              day_hint TEXT,
              notes TEXT,
              due_date TEXT,
              active INTEGER NOT NULL DEFAULT 1,
              position REAL NOT NULL DEFAULT 0,
              source TEXT NOT NULL DEFAULT 'manuel',
              created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              deleted_at TEXT,
              due_day INTEGER
            )
          `)
          db.exec(`
            INSERT INTO recurring_tasks_new
              (id, label, cadence, owner, day_hint, notes, due_date, active, position, source, created_at, updated_at, deleted_at, due_day)
            SELECT id, label, cadence, owner, day_hint, notes, due_date, active, position, source, created_at, updated_at, deleted_at, due_day
            FROM recurring_tasks
          `)
          db.exec(`DROP TABLE recurring_tasks`)
          db.exec(`ALTER TABLE recurring_tasks_new RENAME TO recurring_tasks`)
          db.exec(`CREATE INDEX IF NOT EXISTS idx_recurring_tasks_owner ON recurring_tasks(owner, cadence, position)`)
        })()
        console.log('✅ recurring_tasks : cadence « bihebdo » autorisée')
      } finally { db.pragma('foreign_keys = ON') }
    }
  } catch (e) { console.error('⚠️  recurring_tasks (cadence bihebdo) :', e.message) }

  db.exec(`
    CREATE TABLE IF NOT EXISTS recurring_task_completions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES recurring_tasks(id),
      -- Clé de période : '2026-W32' (hebdo), '2026-08' (mensuel), '2026-Q3'
      -- (trimestriel), '2026' (annuel), 'adhoc' (tâche unique).
      period_key TEXT NOT NULL,
      done_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      done_by TEXT REFERENCES users(id),
      note TEXT
    )
  `)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rt_completion_period ON recurring_task_completions(task_id, period_key)`) } catch {}

  // ── Budget marketing (Émilie) ──────────────────────────────────────────────
  // Remplace la procédure manuelle « Suivi - Budget marketing (Émilie) » :
  // les dépenses des comptes QB marketing (75910-75930) sont détectées via le
  // rapport GeneralLedger, l'utilisateur tranche leur pertinence (nouveaux
  // clients Canada anglais / USA), et un message Slack hebdo part à Émilie.
  // amount = montant maison (CAD) ; amount_foreign/currency pour l'affichage
  // des comptes en devise. import_key = clé naturelle de dédup GL.
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketing_expenses (
      id TEXT PRIMARY KEY,
      import_key TEXT,
      qb_txn_id TEXT,
      qb_txn_type TEXT,
      txn_date TEXT NOT NULL,
      acctnum TEXT NOT NULL,
      account_name TEXT,
      vendor TEXT,
      memo TEXT,
      doc_num TEXT,
      amount REAL NOT NULL,
      amount_foreign REAL,
      currency TEXT DEFAULT 'CAD',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','relevant','not_relevant')),
      rule_id TEXT,
      decided_at TEXT,
      decided_by TEXT REFERENCES users(id),
      notified_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_exp_import_key ON marketing_expenses(import_key) WHERE import_key IS NOT NULL`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_mkt_exp_status ON marketing_expenses(status, txn_date, deleted_at)`) } catch {}

  // Règles « jamais pertinente » : un fournisseur (clé normalisée) dont les
  // dépenses récurrentes ne concernent jamais le budget d'Émilie est exclu
  // automatiquement à l'ingestion. acctnum NULL = tous les comptes marketing.
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketing_expense_rules (
      id TEXT PRIMARY KEY,
      vendor_key TEXT NOT NULL,
      vendor_label TEXT NOT NULL,
      acctnum TEXT,
      note TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)

  // Budget vs Réel — remplace le fichier Drive « Annual Marketing budget »,
  // trop fragile pour une écriture programmatique. Une ligne = un montant
  // budgété pour un compte QB marketing et un mois ; le réel est calculé
  // depuis marketing_expenses (status='relevant').
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketing_budget_lines (
      id TEXT PRIMARY KEY,
      acctnum TEXT NOT NULL,
      month TEXT NOT NULL,
      budget REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_budget_cell ON marketing_budget_lines(acctnum, month) WHERE deleted_at IS NULL`) } catch {}

  // ── Inventaire des documents Drive de la comptabilité ─────────────────────
  // Photographie (métadonnées SEULEMENT — rien n'est importé) des Sheets / Docs
  // accessibles au compte Google connecté, pour décider un par un lesquels
  // méritent d'être rapatriés dans l'ERP. `status` est recalculé à chaque scan
  // (déjà synchronisé / candidat / à ignorer) ; `decision` appartient à
  // l'utilisateur et n'est JAMAIS écrasée par un scan.
  db.exec(`
    CREATE TABLE IF NOT EXISTS drive_inventory_items (
      id TEXT PRIMARY KEY,
      drive_file_id TEXT NOT NULL,
      name TEXT,
      mime_type TEXT,
      kind TEXT,
      owner_email TEXT,
      owner_name TEXT,
      web_view_link TEXT,
      parent_folder_id TEXT,
      parent_folder_name TEXT,
      created_time TEXT,
      modified_time TEXT,
      last_modified_by TEXT,
      version INTEGER,
      size_bytes INTEGER,
      tabs TEXT,
      tabs_error TEXT,
      edits_per_month REAL,
      days_since_modified INTEGER,
      frequency TEXT,
      status TEXT,
      status_reason TEXT,
      sync_target TEXT,
      match_terms TEXT,
      source TEXT NOT NULL DEFAULT 'scan',
      scanned_account TEXT,
      decision TEXT,
      decision_note TEXT,
      decided_at TEXT,
      decided_by TEXT REFERENCES users(id),
      first_seen_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_seen_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_drive_inv_file ON drive_inventory_items(drive_file_id) WHERE deleted_at IS NULL`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_drive_inv_status ON drive_inventory_items(status, deleted_at)`) } catch {}

  // Onglets — la vraie unité de décision. Un classeur « déjà synchronisé » au
  // niveau du fichier peut n'avoir qu'un ou deux onglets repris par l'ERP (cas
  // de CTB - Suivi : 12 onglets, 2 touchés) ; c'est donc l'ONGLET qui porte le
  // statut, la pertinence et la décision. `nature` distingue un tableau de
  // données (importable) d'une procédure rédigée ou d'une calculatrice.
  db.exec(`
    CREATE TABLE IF NOT EXISTS drive_inventory_tabs (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES drive_inventory_items(id),
      tab_name TEXT NOT NULL,
      tab_index INTEGER,
      rows_count INTEGER,
      cols_count INTEGER,
      header_json TEXT,
      sample_json TEXT,
      nature TEXT,
      status TEXT,
      status_reason TEXT,
      sync_target TEXT,
      relevance INTEGER,
      target_module TEXT,
      suggestion TEXT,
      verdict TEXT,
      analysis_source TEXT,
      analysis_at TEXT,
      decision TEXT,
      decision_note TEXT,
      decided_at TEXT,
      decided_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`ALTER TABLE drive_inventory_tabs ADD COLUMN sections_json TEXT`) } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_drive_tab_unique ON drive_inventory_tabs(item_id, tab_name) WHERE deleted_at IS NULL`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_drive_tab_item ON drive_inventory_tabs(item_id, deleted_at)`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_drive_tab_verdict ON drive_inventory_tabs(verdict, relevance)`) } catch {}

  // État du dernier scan (une seule ligne, id=1) — affiché en tête de page.
  db.exec(`
    CREATE TABLE IF NOT EXISTS drive_inventory_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_scan_at TEXT,
      last_status TEXT,
      last_error TEXT,
      last_account TEXT,
      files_seen INTEGER,
      duration_ms INTEGER
    )
  `)
  // Analyse de pertinence : passage long (lecture du contenu déjà extrait +
  // jugement du modèle), lancé à la demande et suivi en arrière-plan.
  for (const col of [
    'last_analysis_at TEXT', 'analysis_status TEXT', 'analysis_error TEXT',
    'analysis_done INTEGER', 'analysis_total INTEGER', 'analysis_source TEXT',
    'analysis_phase TEXT',
  ]) {
    try { db.exec(`ALTER TABLE drive_inventory_state ADD COLUMN ${col}`) } catch {}
  }

  // ── Prospects Instagram ───────────────────────────────────────────────────
  // Les gens qui commentent nos publications Instagram (en particulier le mot
  // « coach ») sont captés par ManyChat, qui appelle POST /api/instagram/manychat.
  // L'ERP est la SOURCE DE VÉRITÉ : il dédoublonne, décide s'il faut envoyer le
  // DM (`should_dm` dans la réponse — ManyChat ne déclenche qu'une fois par
  // personne ET par publication, il ne peut donc pas dédoublonner seul), et
  // met la liste en miroir dans Airtable où Philippe édite le suivi.
  //
  // dedup_key : 'igsid:<id>' quand l'IGSID est fourni (stable même si la
  // personne renomme son compte), sinon 'user:<username minuscule>'. Une ligne
  // 'user:' est promue en 'igsid:' dès qu'un événement apporte l'IGSID.
  db.exec(`
    CREATE TABLE IF NOT EXISTS instagram_prospects (
      id TEXT PRIMARY KEY,
      dedup_key TEXT NOT NULL,
      ig_username TEXT,
      ig_user_id TEXT,
      manychat_subscriber_id TEXT,
      full_name TEXT,
      profile_url TEXT,
      first_comment_text TEXT,
      first_comment_at TEXT,
      first_post_url TEXT,
      keyword TEXT,
      has_keyword INTEGER NOT NULL DEFAULT 0,
      last_comment_text TEXT,
      last_comment_at TEXT,
      last_post_url TEXT,
      comment_count INTEGER NOT NULL DEFAULT 0,
      dm_sent INTEGER NOT NULL DEFAULT 0,
      dm_sent_at TEXT,
      replied INTEGER NOT NULL DEFAULT 0,
      replied_at TEXT,
      first_reply_text TEXT,
      reply_count INTEGER NOT NULL DEFAULT 0,
      follow_up_status TEXT NOT NULL DEFAULT 'À contacter',
      notes TEXT,
      week_key TEXT,
      notified_at TEXT,
      notified_week TEXT,
      airtable_id TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ig_prospect_dedup ON instagram_prospects(dedup_key) WHERE deleted_at IS NULL`) } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ig_prospect_airtable ON instagram_prospects(airtable_id) WHERE airtable_id IS NOT NULL`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_ig_prospect_notify ON instagram_prospects(notified_at, first_comment_at)`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_ig_prospect_igsid ON instagram_prospects(ig_user_id) WHERE ig_user_id IS NOT NULL`) } catch {}

  // Ajouts (additif/idempotent) :
  //  • contacted / contacted_at — la case que Philippe coche, dans l'ERP ou
  //    dans Airtable, pour ne pas recontacter quelqu'un. Distincte de dm_sent
  //    (automatique, ManyChat) : c'est la trace d'un contact HUMAIN.
  //  • source — 'manychat' (webhook) ou 'scrape' (lecture des commentaires).
  //  • comment_url — permalien de la publication commentée, pour retrouver le fil.
  try { db.exec(`ALTER TABLE instagram_prospects ADD COLUMN contacted INTEGER NOT NULL DEFAULT 0`) } catch {}
  try { db.exec(`ALTER TABLE instagram_prospects ADD COLUMN contacted_at TEXT`) } catch {}
  try { db.exec(`ALTER TABLE instagram_prospects ADD COLUMN contacted_by TEXT`) } catch {}
  try { db.exec(`ALTER TABLE instagram_prospects ADD COLUMN source TEXT`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_ig_prospect_week ON instagram_prospects(week_key) WHERE deleted_at IS NULL`) } catch {}

  // contacted_source distingue COMMENT on a su qu'une fiche est contactée :
  // 'manual' (case cochée dans l'ERP/Airtable), 'public_reply' (un compte
  // maison a déjà répondu publiquement au commentaire), 'dm_history' (un fil
  // de conversation existe déjà dans l'inbox Instagram). Sert uniquement à
  // afficher POURQUOI dans l'UI — ne change pas la logique de dédup.
  try { db.exec(`ALTER TABLE instagram_prospects ADD COLUMN contacted_source TEXT`) } catch {}

  // Historique des DM Instagram (@orisha_auto), utilisé pour détecter qu'un
  // prospect a déjà un fil de conversation — donc qu'il ne faut pas le
  // recontacter — sans appel API par prospect : un seul balayage paginé de
  // l'inbox (instagramDmHistory.js), puis une jointure locale sur ig_user_id.
  db.exec(`
    CREATE TABLE IF NOT EXISTS instagram_dm_threads (
      ig_user_id TEXT PRIMARY KEY,
      username TEXT,
      thread_id TEXT,
      last_activity_at TEXT,
      first_seen_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)

  // Journal brut des appels ManyChat. Porte l'idempotence (event_key unique :
  // un rejeu ne regonfle pas les compteurs), l'historique « a commenté 4 fois »
  // et le diagnostic quand un flow ManyChat est mal configuré.
  db.exec(`
    CREATE TABLE IF NOT EXISTS instagram_prospect_events (
      id TEXT PRIMARY KEY,
      prospect_id TEXT REFERENCES instagram_prospects(id),
      event_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('comment','dm_sent','reply')),
      payload TEXT,
      occurred_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ig_event_key ON instagram_prospect_events(event_key)`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_ig_event_prospect ON instagram_prospect_events(prospect_id, kind)`) } catch {}

  // Config Airtable du module. table_id volontairement NULL : la table
  // « Prospects Instagram » doit être créée à la main (le jeton OAuth n'a que
  // le scope schema.bases:read). Un faux tbl… ferait boucler le write-back en
  // 404 ; table_id absent ⇒ writeBackRecord skip proprement.
  try {
    db.prepare(`
      INSERT OR IGNORE INTO airtable_module_config (module, base_id, field_map)
      VALUES ('instagram', 'appB4Fehk9jYd4s4B', ?)
    `).run(JSON.stringify(INSTAGRAM_FIELD_MAP))
  } catch {}

  // Le field_map est complété de façon ADDITIVE : la ligne existe déjà chez
  // l'utilisateur, l'INSERT ci-dessus ne fait donc plus rien, et un champ ajouté
  // au code (« Contacté ») resterait invisible d'Airtable. On n'ajoute que les
  // clés absentes — un nom de champ modifié à la main reste prioritaire.
  try {
    const row = db.prepare("SELECT field_map FROM airtable_module_config WHERE module='instagram'").get()
    const current = JSON.parse(row?.field_map || '{}')
    let added = 0
    for (const [key, atField] of Object.entries(INSTAGRAM_FIELD_MAP)) {
      if (!(key in current)) { current[key] = atField; added++ }
    }
    if (added) {
      db.prepare("UPDATE airtable_module_config SET field_map=? WHERE module='instagram'").run(JSON.stringify(current))
    }
  } catch {}

  // Sens de synchro par champ. SANS ce seed, fieldMapDirection renvoie 'both'
  // par défaut et une édition Airtable pourrait écraser comment_count ou
  // dm_sent — donc faire re-contacter quelqu'un. INSERT OR IGNORE : un réglage
  // fait à la main dans « Gérer les champs » reste prioritaire.
  try {
    const dir = db.prepare(`INSERT OR IGNORE INTO airtable_field_directions (module, field_key, direction) VALUES ('instagram', ?, ?)`)
    for (const key of Object.keys(INSTAGRAM_FIELD_MAP)) {
      dir.run(key, INSTAGRAM_PULLABLE_KEYS.has(key) ? 'both' : 'push')
    }
  } catch {}


  // ── Collecte automatique des factures sur les portails fournisseurs ────────
  // Certains fournisseurs (Amazon, Wix) n'envoient aucune facture par courriel
  // et n'exposent pas d'API : la facture ne vit que derrière le login de leur
  // portail. Un compte = un jeu d'identifiants chiffrés + une session Playwright
  // persistée (storage_state) pour éviter de re-passer la 2FA à chaque tournée.
  db.exec(`
    CREATE TABLE IF NOT EXISTS scraper_accounts (
      id TEXT PRIMARY KEY,
      vendor TEXT NOT NULL,
      label TEXT,
      username TEXT,
      password_enc TEXT,
      totp_secret_enc TEXT,
      storage_state_enc TEXT,
      storage_state_at TEXT,
      enabled INTEGER DEFAULT 1,
      lookback_days INTEGER DEFAULT 60,
      schedule_cron TEXT,
      last_run_at TEXT,
      last_status TEXT,
      last_error TEXT,
      last_imported INTEGER DEFAULT 0,
      -- Défi OTP en cours : le scraper se met en pause et sonde otp_code.
      otp_code TEXT,
      otp_requested_at TEXT,
      otp_submitted_at TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_scraper_accounts_vendor ON scraper_accounts(vendor) WHERE deleted_at IS NULL`) } catch {}

  // Historique des tournées. `log` = trace lisible (une ligne par étape) pour
  // diagnostiquer un sélecteur cassé sans relancer à l'aveugle ; `artifacts` =
  // captures d'écran/HTML écrites sous uploads/scrapers/<run_id>/.
  db.exec(`
    CREATE TABLE IF NOT EXISTS scraper_runs (
      id TEXT PRIMARY KEY,
      account_id TEXT REFERENCES scraper_accounts(id),
      vendor TEXT,
      trigger TEXT,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('running','needs_otp','success','error','cancelled')),
      started_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      finished_at TEXT,
      duration_ms INTEGER,
      found INTEGER DEFAULT 0,
      imported INTEGER DEFAULT 0,
      skipped INTEGER DEFAULT 0,
      error TEXT,
      log TEXT DEFAULT '[]',
      artifacts TEXT DEFAULT '[]',
      created_by TEXT REFERENCES users(id)
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_scraper_runs_account ON scraper_runs(account_id, started_at DESC)`) } catch {}

  // Un document = une facture vue sur le portail. La clé (vendor, external_id)
  // porte la dédup entre tournées : on ne re-télécharge jamais une facture déjà
  // vue, même si l'utilisateur a supprimé le reçu correspondant.
  db.exec(`
    CREATE TABLE IF NOT EXISTS scraper_documents (
      id TEXT PRIMARY KEY,
      account_id TEXT REFERENCES scraper_accounts(id),
      vendor TEXT NOT NULL,
      external_id TEXT NOT NULL,
      doc_date TEXT,
      amount REAL,
      currency TEXT,
      source_url TEXT,
      filename TEXT,
      content_sha256 TEXT,
      sale_receipt_id TEXT REFERENCES sale_receipts(id),
      run_id TEXT REFERENCES scraper_runs(id),
      status TEXT DEFAULT 'imported',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_scraper_docs_external ON scraper_documents(vendor, external_id)`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_scraper_docs_receipt ON scraper_documents(sale_receipt_id) WHERE sale_receipt_id IS NOT NULL`) } catch {}


  // Motifs propres au RELEVÉ BANCAIRE (« AMZN », « SQ *LE CAFE »…), volontairement
  // séparés de `aliases` : ces derniers servent à reconnaître un fournisseur sur un
  // DOCUMENT, et y glisser « AMZN » ferait résoudre de travers les factures extraites.
  // Lus par services/scrapers/vendorFromBankLabel.js pour l'opération inverse —
  // du libellé bancaire vers le profil.
  try { db.exec(`ALTER TABLE vendor_profiles ADD COLUMN bank_label_patterns TEXT DEFAULT '[]'`) } catch {}

  // Rattache un compte de collecte au fournisseur dont il ramène les factures :
  // c'est ce lien qui permet de partir d'une ligne bancaire et de savoir quel
  // portail interroger. `collect_mode` : 'ciblee' = piloté par les transactions
  // non comptabilisées ; 'fenetre' = tout ce que le portail expose (repli manuel).
  try { db.exec(`ALTER TABLE scraper_accounts ADD COLUMN vendor_profile_id TEXT REFERENCES vendor_profiles(id)`) } catch {}
  try { db.exec(`ALTER TABLE scraper_accounts ADD COLUMN collect_mode TEXT DEFAULT 'ciblee'`) } catch {}

  // Date de la commande IMPRIMÉE sur la facture (« Date de la commande / Order Date »),
  // distincte de receipt_date (date de LA FACTURE). Fournisseurs qui la subdivisent en
  // plusieurs livraisons partielles (Digikey…) : cette date se compare directement à
  // purchases.order_date pour départager deux commandes de la même pièce — signal bien
  // plus net que la proximité approximative avec la date de facture (cf. purchaseLiaMatch.js).
  try { db.exec(`ALTER TABLE sale_receipts ADD COLUMN order_date TEXT`) } catch {}

  // Une ligne = « cette transaction bancaire attend sa facture ». Sert à trois
  // choses : ne pas re-balayer chaque nuit les mêmes centaines de lignes, rendre
  // l'échec visible (pourquoi rien n'a été trouvé), et espacer les nouvelles
  // tentatives — un fournisseur publie parfois sa facture plusieurs jours après
  // avoir débité.
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoice_needs (
      id TEXT PRIMARY KEY,
      bank_txn_id TEXT NOT NULL REFERENCES bank_transactions(id),
      scraper_account_id TEXT REFERENCES scraper_accounts(id),
      vendor_profile_id TEXT REFERENCES vendor_profiles(id),
      amount REAL,
      currency TEXT,
      txn_date TEXT,
      status TEXT NOT NULL DEFAULT 'en_attente'
        CHECK(status IN ('en_attente','trouvee','introuvable','ambigue','devise_differente','sans_collecteur')),
      sale_receipt_id TEXT REFERENCES sale_receipts(id),
      attempts INTEGER DEFAULT 0,
      last_attempt_at TEXT,
      note TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_needs_txn ON invoice_needs(bank_txn_id)`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_invoice_needs_account ON invoice_needs(scraper_account_id, status)`) } catch {}

  // Motifs de relevé pour les fournisseurs déjà collectés. INSERT-like : on ne
  // touche pas un profil que l'utilisateur a édité (motifs déjà présents).
  // « AMZN » est indispensable — la moitié des débits Amazon arrivent sous
  // « AMZN MKTP CA*… », que le nom canonique « Amazon.ca » ne reconnaît pas.
  try {
    const seedPatterns = db.prepare(`
      UPDATE vendor_profiles SET bank_label_patterns = ?
      WHERE name = ? AND deleted_at IS NULL
        AND (bank_label_patterns IS NULL OR bank_label_patterns IN ('', '[]'))
    `)
    seedPatterns.run(JSON.stringify(['AMZN', 'AMAZON']), 'Amazon.ca')
    seedPatterns.run(JSON.stringify(['WIX']), 'Wix.com')
    // « BELL MOBILITY » au relevé, « Bell Mobilité » au répertoire : l'alias
    // couvre déjà le cas, le motif le rend explicite et insensible aux variantes.
    seedPatterns.run(JSON.stringify(['BELL MOBILITY', 'BELL MOBILITE']), 'Bell Mobilité')
    // Rattachement par défaut du collecteur à son fournisseur : sans ce lien la
    // collecte ciblée ne sait pas quelles transactions concernent ce portail.
    // Posé une seule fois — l'utilisateur peut le changer dans la fiche du compte.
    const bindCollector = db.prepare(`
      UPDATE scraper_accounts SET vendor_profile_id =
        (SELECT id FROM vendor_profiles WHERE name = ? AND deleted_at IS NULL)
      WHERE vendor = ? AND vendor_profile_id IS NULL AND deleted_at IS NULL
    `)
    bindCollector.run('Amazon.ca', 'amazon')
    bindCollector.run('Wix.com', 'wix')
    bindCollector.run('Bell Mobilité', 'bell')
  } catch {}


  // Paiement mensuel des cartes de crédit Visa (CAD et USD).
  //
  // Ces cartes se paient vers le 25 et leur solde n'est disponible nulle part
  // automatiquement : il se saisit à la main. Il manquait donc un état « à
  // payer, pas encore émis » pour autre chose qu'une facture fournisseur —
  // `treasury_payments` signifie « paiement émis » (la ligne y pèse aussitôt
  // sur la projection du solde) et les occurrences de `recurring_outflows` ne
  // sont jamais rendues comme des lignes payables dans la cédule.
  //
  // Une ligne = un mois × une carte. UNIQUE(period, card_account) porte
  // l'idempotence : la génération tourne à chaque affichage de la cédule.
  db.exec(`
    CREATE TABLE IF NOT EXISTS card_payment_dues (
      id TEXT PRIMARY KEY,
      period TEXT NOT NULL,
      card_account TEXT NOT NULL,
      pay_account TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CAD',
      label TEXT,
      due_date TEXT NOT NULL,
      amount REAL,
      payment_date TEXT,
      treasury_payment_id TEXT REFERENCES treasury_payments(id),
      dismissed_at TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_card_dues_period ON card_payment_dues(period, card_account) WHERE deleted_at IS NULL`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_card_dues_open ON card_payment_dues(due_date) WHERE treasury_payment_id IS NULL AND deleted_at IS NULL`) } catch {}

  // Suivi de PLAFOND d'une carte de crédit — complémentaire à `card_payment_dues`
  // (« as-tu payé la carte ce mois-ci ? »). La question ici est l'inverse :
  // « la carte a-t-elle encore de la place ? ». La Mastercard BNC sert à payer
  // une partie des fournisseurs et son paiement est PRÉ-PROGRAMMÉ le 4 : si le
  // solde dépasse le plafond de confort avant cette date, la carte devient
  // inutilisable et il faut payer un extra à la main.
  //
  // Une ligne = une carte suivie. `qb_acctnum` est le NUMÉRO de compte QB (pas
  // son Id, qui change d'un realm à l'autre) — résolu par resolveAccountByAcctNum.
  db.exec(`
    CREATE TABLE IF NOT EXISTS card_ceilings (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      qb_acctnum TEXT,
      bank_account_id TEXT REFERENCES bank_accounts(id),
      credit_limit REAL,
      ceiling REAL,
      draft_day INTEGER,
      currency TEXT NOT NULL DEFAULT 'CAD',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_card_ceilings_name ON card_ceilings(name) WHERE deleted_at IS NULL`) } catch {}

  // Anti-doublon des alertes de plafond : une seule alerte par carte, par mois
  // et par type ('lead' = J-N avant le prélèvement, 'breach' = plafond franchi
  // hors fenêtre). L'index UNIQUE porte l'idempotence — pas la relecture des
  // journaux d'automation, illisible dès qu'il y a plus d'une carte.
  db.exec(`
    CREATE TABLE IF NOT EXISTS card_ceiling_alerts (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES card_ceilings(id),
      period TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('lead','breach')),
      projected REAL,
      recommended REAL,
      sent_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_card_ceiling_alerts ON card_ceiling_alerts(card_id, period, kind) WHERE deleted_at IS NULL`) } catch {}

  // Sondages de satisfaction envoyés par SMS (Telnyx) depuis la fiche d'un
  // billet. Une ligne = un billet : le renvoi réutilise le MÊME jeton, sinon le
  // premier SMS pointerait vers un lien mort. D'où UNIQUE(ticket_id).
  //
  // Le jeton est le SEUL rempart de la page publique /s/:token (aucune auth) :
  // 14 caractères base62 ≈ 83 bits, jamais séquentiel, jamais devinable.
  //
  // `rating` NULL = envoyé, pas encore répondu. La réponse reste modifiable
  // jusqu'à expiration ; `response_count` distingue la première réponse d'un
  // changement d'avis (Slack envoie alors un message différent).
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_surveys (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id),
      contact_id TEXT REFERENCES contacts(id),
      token TEXT NOT NULL,
      language TEXT NOT NULL CHECK(language IN ('French','English')),
      phone TEXT NOT NULL,
      expires_at TEXT NOT NULL,

      send_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(send_status IN ('pending','sent','delivered','failed')),
      send_error TEXT,
      telnyx_message_id TEXT,
      sent_at TEXT,
      sent_by TEXT REFERENCES users(id),
      delivered_at TEXT,
      send_count INTEGER NOT NULL DEFAULT 0,

      rating INTEGER CHECK(rating BETWEEN 1 AND 5),
      accepts_call INTEGER,
      comment TEXT,
      responded_at TEXT,
      response_count INTEGER NOT NULL DEFAULT 0,

      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_surveys_token ON ticket_surveys(token)`) } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_surveys_ticket ON ticket_surveys(ticket_id) WHERE deleted_at IS NULL`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_ticket_surveys_msgid ON ticket_surveys(telnyx_message_id)`) } catch {}

  console.log('Database schema initialized');
}

// Mapping colonne ERP → nom du champ Airtable. Les clés SONT les noms de
// colonnes de instagram_prospects, d'où l'absence de keyToColumn côté
// write-back. Les champs listés dans INSTAGRAM_PULLABLE_KEYS appartiennent à
// Philippe (il les édite dans Airtable) ; tous les autres sont poussés par le
// système et ne remontent jamais.
export const INSTAGRAM_FIELD_MAP = {
  ig_username: "Nom d'usager",
  full_name: 'Nom',
  profile_url: 'Profil',
  ig_user_id: 'IGSID',
  manychat_subscriber_id: 'ID ManyChat',
  keyword: 'Mot-clé',
  comment_count: 'Nb de commentaires',
  first_comment_text: 'Premier commentaire',
  first_comment_at: 'Premier commentaire le',
  last_comment_text: 'Dernier commentaire',
  last_comment_at: 'Dernier commentaire le',
  last_post_url: 'Publication',
  dm_sent: 'DM envoyé',
  dm_sent_at: 'DM envoyé le',
  replied: 'A répondu',
  replied_at: 'Répondu le',
  first_reply_text: 'Réponse',
  week_key: 'Semaine',
  notified_at: 'Annoncé le',
  follow_up_status: 'Suivi',
  notes: 'Notes',
  contacted: 'Contacté',
  contacted_at: 'Contacté le',
}

// `contacted` remonte d'Airtable : Philippe peut cocher des deux côtés.
export const INSTAGRAM_PULLABLE_KEYS = new Set(['follow_up_status', 'notes', 'contacted'])


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

