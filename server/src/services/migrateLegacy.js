import db from '../db/database.js'
import { newId } from '../utils/ids.js'

// Field definitions for each legacy table
const TABLE_DEFS = {
  companies: {
    frName: 'Entreprises',
    slug: 'entreprises',
    icon: 'Building2',
    color: '#6366f1',
    fields: [
      { name: 'Nom',        key: 'name',            type: 'text',     isPrimary: true,  required: true },
      { name: 'Type',       key: 'type',            type: 'select',   options: { choices: ['Client','Prospect','Partenaire','Fournisseur'] } },
      { name: 'Phase',      key: 'lifecycle_phase', type: 'select',   options: { choices: ['Lead','MQL','SQL','Opportunité','Client actif','Client inactif'] } },
      { name: 'Téléphone',  key: 'phone',           type: 'phone' },
      { name: 'Courriel',   key: 'email',           type: 'email' },
      { name: 'Site web',   key: 'website',         type: 'url' },
      { name: 'Adresse',    key: 'address',         type: 'text' },
      { name: 'Ville',      key: 'city',            type: 'text' },
      { name: 'Province',   key: 'province',        type: 'text' },
      { name: 'Pays',       key: 'country',         type: 'text' },
      { name: 'Notes',      key: 'notes',           type: 'text' },
    ],
    getRecords: (tenantId) => db.prepare('SELECT * FROM companies WHERE tenant_id = ?').all(tenantId),
    mapRecord: (row) => ({
      name: row.name, type: row.type, lifecycle_phase: row.lifecycle_phase,
      phone: row.phone, email: row.email, website: row.website,
      address: row.address, city: row.city, province: row.province,
      country: row.country, notes: row.notes,
    }),
  },

  contacts: {
    frName: 'Contacts',
    slug: 'contacts',
    icon: 'Users',
    color: '#8b5cf6',
    fields: [
      { name: 'Prénom',     key: 'first_name', type: 'text',   isPrimary: true, required: true },
      { name: 'Nom',        key: 'last_name',  type: 'text',   required: true },
      { name: 'Courriel',   key: 'email',      type: 'email' },
      { name: 'Téléphone',  key: 'phone',      type: 'phone' },
      { name: 'Mobile',     key: 'mobile',     type: 'phone' },
      { name: 'Langue',     key: 'language',   type: 'select', options: { choices: ['French','English'] } },
      { name: 'Notes',      key: 'notes',      type: 'text' },
    ],
    getRecords: (tenantId) => db.prepare('SELECT * FROM contacts WHERE tenant_id = ?').all(tenantId),
    mapRecord: (row) => ({
      first_name: row.first_name, last_name: row.last_name, email: row.email,
      phone: row.phone, mobile: row.mobile, language: row.language, notes: row.notes,
    }),
  },

  projects: {
    frName: 'Projets',
    slug: 'projets',
    icon: 'TrendingUp',
    color: '#10b981',
    fields: [
      { name: 'Nom',          key: 'name',           type: 'text',     isPrimary: true, required: true },
      { name: 'Type',         key: 'type',           type: 'select',   options: { choices: ['Nouveau client','Expansion','Ajouts mineurs','Pièces de rechange'] } },
      { name: 'Statut',       key: 'status',         type: 'select',   options: { choices: ['Ouvert','Gagné','Perdu'] } },
      { name: 'Probabilité',  key: 'probability',    type: 'number' },
      { name: 'Valeur CAD',   key: 'value_cad',      type: 'currency' },
      { name: 'Mensuel CAD',  key: 'monthly_cad',    type: 'currency' },
      { name: 'Nb serres',    key: 'nb_greenhouses', type: 'number' },
      { name: 'Fermeture',    key: 'close_date',     type: 'date' },
      { name: 'Notes',        key: 'notes',          type: 'text' },
    ],
    getRecords: (tenantId) => db.prepare('SELECT * FROM projects WHERE tenant_id = ?').all(tenantId),
    mapRecord: (row) => ({
      name: row.name, type: row.type, status: row.status, probability: row.probability,
      value_cad: row.value_cad, monthly_cad: row.monthly_cad,
      nb_greenhouses: row.nb_greenhouses, close_date: row.close_date, notes: row.notes,
    }),
  },

  orders: {
    frName: 'Commandes',
    slug: 'commandes',
    icon: 'ShoppingCart',
    color: '#f59e0b',
    fields: [
      { name: 'Numéro',    key: 'order_number', type: 'number', isPrimary: true },
      { name: 'Statut',    key: 'status',       type: 'select', options: { choices: ['Commande vide','Gel d\'envois','En attente','Items à fabriquer ou à acheter','Tous les items sont disponibles','Tout est dans la boite','Partiellement envoyé','Envoyé aujourd\'hui','Envoyé','ERREUR SYSTÈME'] } },
      { name: 'Priorité',  key: 'priority',     type: 'text' },
      { name: 'Notes',     key: 'notes',        type: 'text' },
    ],
    getRecords: (tenantId) => db.prepare('SELECT * FROM orders WHERE tenant_id = ?').all(tenantId),
    mapRecord: (row) => ({
      order_number: row.order_number, status: row.status,
      priority: row.priority, notes: row.notes,
    }),
  },

  products: {
    frName: 'Inventaire',
    slug: 'inventaire',
    icon: 'Package',
    color: '#06b6d4',
    fields: [
      { name: 'Nom',             key: 'name_fr',          type: 'text',     isPrimary: true, required: true },
      { name: 'SKU',             key: 'sku',              type: 'text' },
      { name: 'Type',            key: 'type',             type: 'text' },
      { name: 'Coût unitaire',   key: 'unit_cost',        type: 'currency' },
      { name: 'Prix CAD',        key: 'price_cad',        type: 'currency' },
      { name: 'Stock',           key: 'stock_qty',        type: 'number' },
      { name: 'Stock minimum',   key: 'min_stock',        type: 'number' },
      { name: 'Fournisseur',     key: 'supplier',         type: 'text' },
      { name: 'Approvisionnement', key: 'procurement_type', type: 'select', options: { choices: ['Acheté','Fabriqué','Drop ship'] } },
      { name: 'Actif',           key: 'active',           type: 'checkbox' },
      { name: 'Notes',           key: 'notes',            type: 'text' },
    ],
    getRecords: (tenantId) => db.prepare('SELECT * FROM products WHERE tenant_id = ?').all(tenantId),
    mapRecord: (row) => ({
      name_fr: row.name_fr, sku: row.sku, type: row.type, unit_cost: row.unit_cost,
      price_cad: row.price_cad, stock_qty: row.stock_qty, min_stock: row.min_stock,
      supplier: row.supplier, procurement_type: row.procurement_type,
      active: row.active === 1, notes: row.notes,
    }),
  },

  tickets: {
    frName: 'Support',
    slug: 'support',
    icon: 'LifeBuoy',
    color: '#ef4444',
    fields: [
      { name: 'Titre',        key: 'title',            type: 'text',   isPrimary: true, required: true },
      { name: 'Type',         key: 'type',             type: 'select', options: { choices: ['Aide software','Defect software','Aide hardware','Defect hardware','Erreur de commande','Formation','Installation'] } },
      { name: 'Statut',       key: 'status',           type: 'select', options: { choices: ['Ouvert','En attente client','En attente nous','Fermé'] } },
      { name: 'Durée (min)',  key: 'duration_minutes', type: 'number' },
      { name: 'Description',  key: 'description',      type: 'text' },
      { name: 'Notes',        key: 'notes',            type: 'text' },
    ],
    getRecords: (tenantId) => db.prepare('SELECT * FROM tickets WHERE tenant_id = ?').all(tenantId),
    mapRecord: (row) => ({
      title: row.title, type: row.type, status: row.status,
      duration_minutes: row.duration_minutes, description: row.description, notes: row.notes,
    }),
  },

  purchases: {
    frName: 'Achats',
    slug: 'achats',
    icon: 'ShoppingBag',
    color: '#84cc16',
    fields: [
      { name: 'Nom',     key: 'name',   type: 'text',  isPrimary: true },
      { name: 'Notes',   key: 'notes',  type: 'text' },
    ],
    getRecords: (tenantId) => {
      try { return db.prepare('SELECT * FROM purchases WHERE tenant_id = ?').all(tenantId) } catch { return [] }
    },
    mapRecord: (row) => ({ name: row.name || row.id, notes: row.notes }),
  },

  shipments: {
    frName: 'Envois',
    slug: 'envois',
    icon: 'Send',
    color: '#64748b',
    fields: [
      { name: 'N° suivi',      key: 'tracking_number', type: 'text', isPrimary: true },
      { name: 'Transporteur',  key: 'carrier',         type: 'text' },
      { name: 'Statut',        key: 'status',          type: 'select', options: { choices: ['À envoyer','Envoyé'] } },
      { name: 'Notes',         key: 'notes',           type: 'text' },
    ],
    getRecords: (tenantId) => db.prepare('SELECT * FROM shipments WHERE tenant_id = ?').all(tenantId),
    mapRecord: (row) => ({
      tracking_number: row.tracking_number, carrier: row.carrier,
      status: row.status, notes: row.notes,
    }),
  },

  returns: {
    frName: 'Retours',
    slug: 'retours',
    icon: 'Undo2',
    color: '#f97316',
    fields: [
      { name: 'Statut',    key: 'status',         type: 'select', isPrimary: true, options: { choices: ['Ouvert','Reçu','Analysé','Fermé'] } },
      { name: 'Problème',  key: 'problem_status', type: 'select', options: { choices: ['À régler','Règlé'] } },
      { name: 'Notes',     key: 'notes',          type: 'text' },
    ],
    getRecords: (tenantId) => db.prepare('SELECT * FROM returns WHERE tenant_id = ?').all(tenantId),
    mapRecord: (row) => ({ status: row.status, problem_status: row.problem_status, notes: row.notes }),
  },

  interactions: {
    frName: 'Interactions',
    slug: 'interactions',
    icon: 'MessageSquare',
    color: '#a855f7',
    fields: [
      { name: 'Type',      key: 'type',      type: 'select', isPrimary: true, options: { choices: ['call','sms','email','meeting','note'] } },
      { name: 'Direction', key: 'direction', type: 'select', options: { choices: ['in','out'] } },
      { name: 'Date',      key: 'timestamp', type: 'date' },
    ],
    getRecords: (tenantId) => db.prepare('SELECT * FROM interactions WHERE tenant_id = ?').all(tenantId),
    mapRecord: (row) => ({ type: row.type, direction: row.direction, timestamp: row.timestamp }),
  },
}

export function migrateLegacyTables(tenantId) {
  const results = {}

  for (const [tableKey, def] of Object.entries(TABLE_DEFS)) {
    try {
      results[tableKey] = migrateTable(tenantId, tableKey, def)
    } catch (err) {
      results[tableKey] = { error: err.message }
    }
  }

  return results
}

function migrateTable(tenantId, tableKey, def) {
  const stubId = `tbl_legacy_${tenantId}_${tableKey}`

  // 1. Ensure stub exists and has slug/name set
  let table = db.prepare('SELECT * FROM base_tables WHERE id = ? AND tenant_id = ?').get(stubId, tenantId)
  if (!table) {
    // Create stub if missing
    db.prepare(`
      INSERT OR IGNORE INTO base_tables (id, tenant_id, name, slug, icon, color, description, sort_order, autonumber_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, 99, 0)
    `).run(stubId, tenantId, def.frName, def.slug, def.icon, def.color, def.frName)
    table = db.prepare('SELECT * FROM base_tables WHERE id = ?').get(stubId)
  } else if (!table.slug) {
    db.prepare(`
      UPDATE base_tables SET name = ?, slug = ?, icon = ?, color = ? WHERE id = ?
    `).run(def.frName, def.slug, def.icon, def.color, stubId)
  }

  // 2. Create fields if none exist
  const existingFields = db.prepare(
    'SELECT * FROM base_fields WHERE table_id = ? AND deleted_at IS NULL ORDER BY sort_order'
  ).all(stubId)

  let fieldIds = existingFields.map(f => f.id)

  if (existingFields.length === 0) {
    fieldIds = []
    def.fields.forEach((f, i) => {
      const fid = newId('field')
      db.prepare(`
        INSERT INTO base_fields (id, tenant_id, table_id, name, key, type, options, is_primary, required, sort_order, width)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fid, tenantId, stubId, f.name, f.key, f.type,
        JSON.stringify(f.options || {}),
        f.isPrimary ? 1 : 0,
        f.required ? 1 : 0,
        i,
        f.type === 'text' ? 200 : 120
      )
      fieldIds.push(fid)
    })
  }

  // 3. Create default grid view if none exists
  const existingView = db.prepare(
    'SELECT id FROM base_views WHERE table_id = ? AND deleted_at IS NULL LIMIT 1'
  ).get(stubId)

  if (!existingView) {
    const vid = newId('view')
    db.prepare(`
      INSERT INTO base_views (id, tenant_id, table_id, name, type, config, sort_order, is_default)
      VALUES (?, ?, ?, 'Tous', 'grid', ?, 0, 1)
    `).run(vid, tenantId, stubId, JSON.stringify({
      visible_fields: fieldIds,
      field_order: fieldIds,
      filters: [],
      sorts: [],
      frozen_fields_count: 0,
    }))
  }

  // 4. Copy records (skip already migrated)
  const existingRecordCount = db.prepare(
    'SELECT COUNT(*) as c FROM base_records WHERE table_id = ?'
  ).get(stubId).c

  if (existingRecordCount > 0) {
    return { skipped: true, message: `Déjà migré (${existingRecordCount} enregistrements)` }
  }

  const oldRecords = def.getRecords(tenantId)
  let inserted = 0

  const insertRecord = db.prepare(`
    INSERT INTO base_records (id, tenant_id, table_id, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const run = db.transaction(() => {
    for (const row of oldRecords) {
      const data = def.mapRecord(row)
      // Store legacy_id in data for traceability; use fresh ID to avoid collisions
      data._legacy_id = row.id
      insertRecord.run(
        newId('record'), tenantId, stubId,
        JSON.stringify(data),
        row.created_at || new Date().toISOString(),
        row.updated_at || row.created_at || new Date().toISOString()
      )
      inserted++
    }
  })
  run()

  return { inserted, fieldsCreated: existingFields.length === 0 ? def.fields.length : 0 }
}
