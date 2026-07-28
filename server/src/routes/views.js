import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db/database.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'

const router = Router()

const ALLOWED_TABLES = new Set([
  'companies', 'contacts', 'projects', 'products',
  'orders', 'order_items', 'tickets', 'purchases', 'serial_numbers', 'interactions', 'shipments',
  'abonnements', 'abonnement_events', 'retours', 'factures', 'assemblages',
  'achats_fournisseurs', 'vendor_subscriptions', 'tasks',
  'employees', 'paies', 'paie_items', 'bom_items', 'hour_bank',
  'company_serials', 'sale_receipts',
  'automations', 'catalog', 'discovery_forms', 'journal_entries',
  'public_files', 'qualification_calls', 'soumissions', 'stock_movements',
  'product_movements', 'sync_log',
  'stripe_invoice_items', 'stripe_payouts', 'users', 'payments',
  // Vues dérivées (pas de table DB) — règles comptables des numéros de série.
  'serial_transitions', 'serial_accounting_rules', 'serial_missing_valuations',
])

function validateTable(req, res) {
  if (!ALLOWED_TABLES.has(req.params.table)) {
    res.status(400).json({ error: 'Table inconnue' })
    return false
  }
  return true
}

// group_by / group_order : stockés en TEXT. Format legacy = single field
// (ex. 'category'). Format multi-niveau = JSON array (ex. '["month","category"]').
// On essaie de parser comme JSON-array, sinon on garde la chaîne brute pour
// rester compatible avec les vues existantes.
function parseMaybeArray(val) {
  if (val == null || val === '') return null
  try {
    const parsed = JSON.parse(val)
    if (Array.isArray(parsed)) return parsed
  } catch {}
  return val
}

function parsePill(p) {
  return {
    ...p,
    filters: JSON.parse(p.filters || '[]'),
    visible_columns: JSON.parse(p.visible_columns || '[]'),
    sort: JSON.parse(p.sort || '[]'),
    collapsed_groups: JSON.parse(p.collapsed_groups || '[]'),
    column_widths: JSON.parse(p.column_widths || '{}'),
    color_rules: JSON.parse(p.color_rules || '[]'),
    group_by: parseMaybeArray(p.group_by),
    group_order: parseMaybeArray(p.group_order),
    locked: p.locked === 1,
  }
}

// GET /api/views/:table
router.get('/:table', requireAuth, (req, res) => {
  if (!validateTable(req, res)) return
  const { table } = req.params

  const config = db.prepare(
    'SELECT visible_columns, default_sort, all_view_sort_order, column_widths, bulk_delete_enabled, footer_aggregations FROM table_view_configs WHERE table_name=?'
  ).get(table)

  const pills = db.prepare(
    'SELECT id, label, color, filters, visible_columns, sort, group_by, group_order, collapsed_groups, column_widths, color_rules, sort_order, locked FROM table_view_pills WHERE table_name=? ORDER BY sort_order, created_at'
  ).all(table)

  // Colonnes dynamiques (champs custom kind='data', qu'ils portent une colonne
  // cf_* auto-générée ou une colonne native adoptée depuis Airtable —
  // ex-système `airtable_field_defs`, fusionné dans custom_fields).
  const rawFields = db.prepare(
    "SELECT id, name, column_name, type, options, sort_order FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL AND kind='data' ORDER BY sort_order"
  ).all(table)
  const dynamicFields = rawFields.map(f => ({
    id: f.column_name,
    label: f.name,
    field: f.column_name,
    type: f.type,
    options: JSON.parse(f.options || '{}'),
    sort_order: f.sort_order,
    dynamic: true,
    // Métadonnées pour l'édition de la colonne (PATCH/DELETE depuis le clic-droit du DataTable).
    def_id: f.id,
  }))

  res.json({
    config: config
      ? { visible_columns: JSON.parse(config.visible_columns), default_sort: JSON.parse(config.default_sort), all_view_sort_order: config.all_view_sort_order ?? -1, column_widths: JSON.parse(config.column_widths || '{}'), bulk_delete_enabled: config.bulk_delete_enabled === 1, footer_aggregations: JSON.parse(config.footer_aggregations || '{}') }
      : { visible_columns: [], default_sort: [], all_view_sort_order: -1, column_widths: {}, bulk_delete_enabled: false, footer_aggregations: {} },
    pills: pills.map(parsePill),
    dynamicFields,
  })
})

// PATCH /api/views/:table/bulk-delete-enabled
router.patch('/:table/bulk-delete-enabled', requireAdmin, (req, res) => {
  if (!validateTable(req, res)) return
  const { table } = req.params
  const enabled = req.body.enabled ? 1 : 0

  const existing = db.prepare('SELECT id FROM table_view_configs WHERE table_name=?').get(table)
  if (existing) {
    db.prepare("UPDATE table_view_configs SET bulk_delete_enabled=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE table_name=?")
      .run(enabled, table)
  } else {
    db.prepare('INSERT INTO table_view_configs (id, table_name, visible_columns, default_sort, bulk_delete_enabled) VALUES (?,?,?,?,?)')
      .run(uuidv4(), table, '[]', '[]', enabled)
  }
  res.json({ ok: true, bulk_delete_enabled: enabled === 1 })
})

// PUT /api/views/:table
router.put('/:table', requireAdmin, (req, res) => {
  if (!validateTable(req, res)) return
  const { table } = req.params
  const { visible_columns, default_sort } = req.body

  if (!Array.isArray(visible_columns) || !Array.isArray(default_sort)) {
    return res.status(400).json({ error: 'visible_columns et default_sort doivent être des tableaux' })
  }

  const existing = db.prepare(
    'SELECT id FROM table_view_configs WHERE table_name=?'
  ).get(table)

  if (existing) {
    db.prepare(
      "UPDATE table_view_configs SET visible_columns=?, default_sort=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE table_name=?"
    ).run(JSON.stringify(visible_columns), JSON.stringify(default_sort), table)
  } else {
    db.prepare(
      'INSERT INTO table_view_configs (id, table_name, visible_columns, default_sort) VALUES (?,?,?,?)'
    ).run(uuidv4(), table, JSON.stringify(visible_columns), JSON.stringify(default_sort))
  }

  res.json({ ok: true })
})

// PATCH /api/views/:table/column-widths
router.patch('/:table/column-widths', requireAuth, (req, res) => {
  if (!validateTable(req, res)) return
  const { table } = req.params
  const { column_widths } = req.body
  if (!column_widths || typeof column_widths !== 'object') return res.status(400).json({ error: 'column_widths requis' })

  const existing = db.prepare('SELECT id FROM table_view_configs WHERE table_name=?').get(table)
  if (existing) {
    db.prepare("UPDATE table_view_configs SET column_widths=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE table_name=?")
      .run(JSON.stringify(column_widths), table)
  } else {
    db.prepare('INSERT INTO table_view_configs (id, table_name, visible_columns, default_sort, column_widths) VALUES (?,?,?,?,?)')
      .run(uuidv4(), table, '[]', '[]', JSON.stringify(column_widths))
  }
  res.json({ ok: true })
})

// PATCH /api/views/:table/footer-aggregations
// Persiste la barre de totaux en pied de DataTable (agrégation par colonne).
// requireAuth comme column-widths : c'est une préférence d'affichage par table,
// modifiable par tout utilisateur authentifié.
router.patch('/:table/footer-aggregations', requireAuth, (req, res) => {
  if (!validateTable(req, res)) return
  const { table } = req.params
  const { footer_aggregations } = req.body
  if (!footer_aggregations || typeof footer_aggregations !== 'object') return res.status(400).json({ error: 'footer_aggregations requis' })

  const existing = db.prepare('SELECT id FROM table_view_configs WHERE table_name=?').get(table)
  if (existing) {
    db.prepare("UPDATE table_view_configs SET footer_aggregations=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE table_name=?")
      .run(JSON.stringify(footer_aggregations), table)
  } else {
    db.prepare('INSERT INTO table_view_configs (id, table_name, visible_columns, default_sort, footer_aggregations) VALUES (?,?,?,?,?)')
      .run(uuidv4(), table, '[]', '[]', JSON.stringify(footer_aggregations))
  }
  res.json({ ok: true })
})

// POST /api/views/:table/pills
router.post('/:table/pills', requireAdmin, (req, res) => {
  if (!validateTable(req, res)) return
  const { table } = req.params
  const { label, color = 'gray', filters = [], sort_order = 0, visible_columns = [], sort = [], group_by = null } = req.body

  if (!label) return res.status(400).json({ error: 'label requis' })
  if (!Array.isArray(filters)) return res.status(400).json({ error: 'filters doit être un tableau' })

  const id = uuidv4()
  db.prepare(
    'INSERT INTO table_view_pills (id, table_name, label, color, filters, visible_columns, sort, group_by, sort_order) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(id, table, label, color, JSON.stringify(filters), JSON.stringify(visible_columns), JSON.stringify(sort), group_by, sort_order)

  const pill = db.prepare('SELECT * FROM table_view_pills WHERE id=?').get(id)
  res.status(201).json(parsePill(pill))
})

// PATCH /api/views/:table/pills/reorder
router.patch('/:table/pills/reorder', requireAdmin, (req, res) => {
  if (!validateTable(req, res)) return
  const { table } = req.params
  const { order } = req.body
  if (!Array.isArray(order)) return res.status(400).json({ error: 'Un tableau est requis' })

  const update = db.prepare(
    'UPDATE table_view_pills SET sort_order=? WHERE id=? AND table_name=?'
  )
  const updateAll = db.transaction(() => {
    for (const { id, sort_order } of order) update.run(sort_order, id, table)
  })
  updateAll()

  res.json({ ok: true })
})

// PUT /api/views/:table/pills/:id
router.put('/:table/pills/:id', requireAuth, (req, res) => {
  if (!validateTable(req, res)) return
  const { table, id } = req.params

  const pill = db.prepare(
    'SELECT id, locked FROM table_view_pills WHERE id=? AND table_name=?'
  ).get(id, table)
  if (!pill) return res.status(404).json({ error: 'Vue introuvable' })

  // Vue verrouillée (lecture seule) : aucune édition possible — ni autosave
  // (filtres/tris/colonnes/groupage), ni renommage. Un admin doit d'abord la
  // déverrouiller via PATCH /pills/:id/locked.
  if (pill.locked === 1) {
    return res.status(423).json({ error: 'Vue verrouillée — déverrouillez-la pour la modifier.' })
  }

  const body = req.body
  const updates = []
  const values = []

  if (body.label !== undefined)           { updates.push('label = ?');           values.push(body.label) }
  if (body.color !== undefined)           { updates.push('color = ?');           values.push(body.color) }
  if (body.filters !== undefined)         { updates.push('filters = ?');         values.push(JSON.stringify(body.filters)) }
  if (body.visible_columns !== undefined) { updates.push('visible_columns = ?'); values.push(JSON.stringify(body.visible_columns)) }
  if (body.sort !== undefined)            { updates.push('sort = ?');            values.push(JSON.stringify(body.sort)) }
  if ('group_by' in body) {
    // Accepte string (legacy single-level) ou array (multi-niveau). Sérialise
    // les arrays en JSON pour le stockage ; les strings restent telles quelles
    // pour préserver les vues existantes.
    const v = body.group_by
    updates.push('group_by = ?')
    values.push(Array.isArray(v) ? JSON.stringify(v) : v)
  }
  if ('group_order' in body) {
    const v = body.group_order
    updates.push('group_order = ?')
    values.push(Array.isArray(v) ? JSON.stringify(v) : v)
  }
  if (body.collapsed_groups !== undefined){ updates.push('collapsed_groups = ?'); values.push(JSON.stringify(body.collapsed_groups)) }
  if (body.color_rules !== undefined) {
    if (!Array.isArray(body.color_rules)) return res.status(400).json({ error: 'color_rules doit être un tableau' })
    updates.push('color_rules = ?'); values.push(JSON.stringify(body.color_rules))
  }
  if (body.sort_order !== undefined)      { updates.push('sort_order = ?');      values.push(body.sort_order) }

  if (updates.length === 0) return res.status(400).json({ error: 'Aucun champ à modifier' })

  db.prepare(`UPDATE table_view_pills SET ${updates.join(', ')} WHERE id=?`).run(...values, id)

  const updated = db.prepare('SELECT * FROM table_view_pills WHERE id=?').get(id)
  res.json(parsePill(updated))
})

// PATCH /api/views/:table/pills/:id/locked
// Verrouille/déverrouille une vue (admin only). Une vue verrouillée devient
// lecture seule : ses filtres/tris/colonnes ne peuvent plus dériver et elle
// ne peut pas être supprimée tant qu'elle n'est pas déverrouillée.
router.patch('/:table/pills/:id/locked', requireAdmin, (req, res) => {
  if (!validateTable(req, res)) return
  const { table, id } = req.params

  const pill = db.prepare(
    'SELECT id FROM table_view_pills WHERE id=? AND table_name=?'
  ).get(id, table)
  if (!pill) return res.status(404).json({ error: 'Vue introuvable' })

  const locked = req.body.locked ? 1 : 0
  db.prepare('UPDATE table_view_pills SET locked=? WHERE id=?').run(locked, id)

  const updated = db.prepare('SELECT * FROM table_view_pills WHERE id=?').get(id)
  res.json(parsePill(updated))
})

// PATCH /api/views/:table/pills/:id/column-widths
// Persiste les largeurs de colonnes AU NIVEAU DE LA VUE (et non de la table).
// requireAuth comme l'ancienne route table-level : c'est une préférence
// d'affichage, modifiable par tout utilisateur authentifié. Une vue verrouillée
// reste figée (layout inclus) — cohérent avec PUT /pills/:id.
router.patch('/:table/pills/:id/column-widths', requireAuth, (req, res) => {
  if (!validateTable(req, res)) return
  const { table, id } = req.params
  const { column_widths } = req.body
  if (!column_widths || typeof column_widths !== 'object') return res.status(400).json({ error: 'column_widths requis' })

  const pill = db.prepare(
    'SELECT id, locked FROM table_view_pills WHERE id=? AND table_name=?'
  ).get(id, table)
  if (!pill) return res.status(404).json({ error: 'Vue introuvable' })
  if (pill.locked === 1) return res.status(423).json({ error: 'Vue verrouillée — déverrouillez-la pour la modifier.' })

  db.prepare('UPDATE table_view_pills SET column_widths=? WHERE id=?').run(JSON.stringify(column_widths), id)
  res.json({ ok: true })
})

// DELETE /api/views/:table/pills/:id
router.delete('/:table/pills/:id', requireAdmin, (req, res) => {
  if (!validateTable(req, res)) return
  const { table, id } = req.params

  const pill = db.prepare(
    'SELECT id, locked FROM table_view_pills WHERE id=? AND table_name=?'
  ).get(id, table)
  if (!pill) return res.status(404).json({ error: 'Vue introuvable' })

  // Vue verrouillée : protégée contre la suppression accidentelle.
  if (pill.locked === 1) {
    return res.status(423).json({ error: 'Vue verrouillée — déverrouillez-la pour la supprimer.' })
  }

  // Garde-fou : on doit garder au moins une vue par table, sinon l'utilisateur
  // se retrouve sans onglet (la vue virtuelle « Tous » a été retirée).
  const remaining = db.prepare('SELECT COUNT(*) as c FROM table_view_pills WHERE table_name=?').get(table).c
  if (remaining <= 1) return res.status(400).json({ error: 'Impossible de supprimer la dernière vue' })

  db.prepare('DELETE FROM table_view_pills WHERE id=?').run(id)
  res.json({ ok: true })
})

// ── Detail page field layout ─────────────────────────────────────────────────

// GET /api/views/detail/:entityType
router.get('/detail/:entityType', requireAuth, (req, res) => {
  const config = db.prepare(
    'SELECT field_order FROM detail_field_configs WHERE entity_type=?'
  ).get(req.params.entityType)
  res.json({ field_order: config ? JSON.parse(config.field_order) : null })
})

// PUT /api/views/detail/:entityType
router.put('/detail/:entityType', requireAdmin, (req, res) => {
  const { field_order } = req.body
  if (!Array.isArray(field_order)) return res.status(400).json({ error: 'field_order array required' })

  const existing = db.prepare(
    'SELECT id FROM detail_field_configs WHERE entity_type=?'
  ).get(req.params.entityType)

  if (existing) {
    db.prepare('UPDATE detail_field_configs SET field_order=?, updated_at=datetime(\'now\') WHERE id=?')
      .run(JSON.stringify(field_order), existing.id)
  } else {
    db.prepare('INSERT INTO detail_field_configs (id, entity_type, field_order) VALUES (?,?,?)')
      .run(uuidv4(), req.params.entityType, JSON.stringify(field_order))
  }
  res.json({ ok: true })
})

export default router
