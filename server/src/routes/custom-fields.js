import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { regenerateView, validateFormulaExpr, validateLookup, getLookupMeta } from '../services/customFieldsView.js'

const router = Router()
router.use(requireAuth)

// Tables sur lesquelles on autorise les champs custom. Étendre au besoin.
const ALLOWED_TABLES = new Set(['projects', 'factures'])

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'field'
}

function ensureUniqueColumnName(erpTable, base) {
  const existing = new Set(db.pragma(`table_info(${erpTable})`).map(c => c.name))
  // Préfixe `cf_` pour bien isoler des colonnes natives / Airtable.
  let name = `cf_${base}`
  if (!existing.has(name)) return name
  for (let i = 2; i < 100; i++) {
    const candidate = `cf_${base}_${i}`
    if (!existing.has(candidate)) return candidate
  }
  throw new Error('Impossible de générer un nom de colonne unique')
}

// Variante pour les champs virtuels (formula/lookup) : pas de colonne physique
// à créer, mais doit éviter collision avec les colonnes de la table source ET
// avec les autres champs custom actifs (qui partagent le même namespace dans
// la vue).
function ensureUniqueVirtualColumnName(erpTable, base) {
  const physical = new Set(db.pragma(`table_info(${erpTable})`).map(c => c.name))
  const virtual = new Set(
    db.prepare(`SELECT column_name FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL`)
      .all(erpTable).map(r => r.column_name)
  )
  const taken = new Set([...physical, ...virtual])
  const candidate0 = `cf_${base}`
  if (!taken.has(candidate0)) return candidate0
  for (let i = 2; i < 100; i++) {
    const c = `cf_${base}_${i}`
    if (!taken.has(c)) return c
  }
  throw new Error('Impossible de générer un nom de colonne unique')
}

// GET /api/custom-fields/_meta/:erpTable — méta pour l'UI de création :
// colonnes FK + tables/colonnes autorisées en lookup. Utilisé par les
// dropdowns de la modale de création.
router.get('/_meta/:erpTable', (req, res) => {
  const { erpTable } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée' })
  try { res.json(getLookupMeta(erpTable)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})

// GET /api/custom-fields/:erpTable — liste les champs custom actifs pour une table.
router.get('/:erpTable', (req, res) => {
  const { erpTable } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée pour les champs custom' })
  const rows = db.prepare(
    `SELECT id, name, column_name, type, decimals, sort_order,
            kind, formula_expr, lookup_fk, lookup_target_table, lookup_target_column, result_type
     FROM custom_fields
     WHERE erp_table=? AND deleted_at IS NULL
     ORDER BY sort_order, created_at`
  ).all(erpTable)
  res.json({ data: rows })
})

// POST /api/custom-fields/:erpTable — crée un nouveau champ custom.
// Body : { name, type ('text'|'number'), decimals (0..5, requis si type='number') }
router.post('/:erpTable', (req, res) => {
  const { erpTable } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée' })
  const name = String(req.body?.name || '').trim()
  const type = req.body?.type
  if (!name) return res.status(400).json({ error: 'Nom requis' })
  if (!['text', 'number'].includes(type)) return res.status(400).json({ error: 'Type doit être "text" ou "number"' })
  let decimals = null
  if (type === 'number') {
    decimals = parseInt(req.body?.decimals)
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 5) {
      return res.status(400).json({ error: 'Décimales doit être entre 0 et 5' })
    }
  }

  const slug = slugify(name)
  const columnName = ensureUniqueColumnName(erpTable, slug)
  // SQLite : pas de type strict, on stocke text → TEXT, number → REAL.
  const sqlType = type === 'number' ? 'REAL' : 'TEXT'

  const id = uuid()
  const lastSortRow = db.prepare(
    `SELECT MAX(sort_order) AS m FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL`
  ).get(erpTable)
  const sortOrder = (lastSortRow?.m ?? -1) + 1

  const tx = db.transaction(() => {
    db.exec(`ALTER TABLE ${erpTable} ADD COLUMN ${columnName} ${sqlType}`)
    db.prepare(`
      INSERT INTO custom_fields (id, erp_table, name, column_name, type, decimals, sort_order)
      VALUES (?,?,?,?,?,?,?)
    `).run(id, erpTable, name, columnName, type, decimals, sortOrder)
  })
  tx()

  const created = db.prepare(`SELECT id, name, column_name, type, decimals, sort_order FROM custom_fields WHERE id=?`).get(id)
  res.status(201).json(created)
})

// POST /api/custom-fields/:erpTable/formula — crée un champ calculé
// (expression SQLite, exposée uniquement via la VUE <table>_v).
// Body : { name, formula_expr, result_type ('text'|'number'|'date') }
router.post('/:erpTable/formula', (req, res) => {
  const { erpTable } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée' })
  const name = String(req.body?.name || '').trim()
  const formulaExpr = String(req.body?.formula_expr || '').trim()
  const resultType = req.body?.result_type
  if (!name) return res.status(400).json({ error: 'Nom requis' })
  if (!['text', 'number', 'date'].includes(resultType)) {
    return res.status(400).json({ error: "result_type doit être 'text', 'number' ou 'date'" })
  }
  try { validateFormulaExpr(formulaExpr) } catch (e) { return res.status(400).json({ error: e.message }) }

  const slug = slugify(name)
  // Pour les champs virtuels (kind formula/lookup), pas de colonne physique :
  // on doit juste éviter une collision avec les noms de colonnes de la table
  // ou un autre custom_field actif.
  const columnName = ensureUniqueVirtualColumnName(erpTable, slug)

  const id = uuid()
  const lastSortRow = db.prepare(
    `SELECT MAX(sort_order) AS m FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL`
  ).get(erpTable)
  const sortOrder = (lastSortRow?.m ?? -1) + 1

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind, formula_expr, result_type, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(id, erpTable, name, columnName, resultType === 'number' ? 'number' : 'text', 'formula', formulaExpr, resultType, sortOrder)
    regenerateView(erpTable)
  })
  try { tx() } catch (e) { return res.status(400).json({ error: e.message }) }

  const created = db.prepare(`
    SELECT id, name, column_name, type, kind, formula_expr, result_type, sort_order
    FROM custom_fields WHERE id=?
  `).get(id)
  res.status(201).json(created)
})

// POST /api/custom-fields/:erpTable/lookup — crée un champ lookup
// (LEFT JOIN dans la VUE).
// Body : { name, lookup_fk, lookup_target_table, lookup_target_column, result_type }
router.post('/:erpTable/lookup', (req, res) => {
  const { erpTable } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée' })
  const name = String(req.body?.name || '').trim()
  const lookup = {
    lookup_fk: req.body?.lookup_fk,
    lookup_target_table: req.body?.lookup_target_table,
    lookup_target_column: req.body?.lookup_target_column,
  }
  const resultType = req.body?.result_type
  if (!name) return res.status(400).json({ error: 'Nom requis' })
  if (!['text', 'number', 'date'].includes(resultType)) {
    return res.status(400).json({ error: "result_type doit être 'text', 'number' ou 'date'" })
  }
  try { validateLookup(lookup, erpTable) } catch (e) { return res.status(400).json({ error: e.message }) }

  const slug = slugify(name)
  const columnName = ensureUniqueVirtualColumnName(erpTable, slug)

  const id = uuid()
  const lastSortRow = db.prepare(
    `SELECT MAX(sort_order) AS m FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL`
  ).get(erpTable)
  const sortOrder = (lastSortRow?.m ?? -1) + 1

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind,
        lookup_fk, lookup_target_table, lookup_target_column, result_type, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, erpTable, name, columnName, resultType === 'number' ? 'number' : 'text', 'lookup',
           lookup.lookup_fk, lookup.lookup_target_table, lookup.lookup_target_column, resultType, sortOrder)
    regenerateView(erpTable)
  })
  try { tx() } catch (e) { return res.status(400).json({ error: e.message }) }

  const created = db.prepare(`
    SELECT id, name, column_name, type, kind, lookup_fk, lookup_target_table,
           lookup_target_column, result_type, sort_order
    FROM custom_fields WHERE id=?
  `).get(id)
  res.status(201).json(created)
})

// PUT /api/custom-fields/:id — modifie nom, décimales, et (selon le kind)
// l'expression formule ou la config lookup. Le `column_name`, le `type`, et
// le `kind` ne peuvent pas changer.
router.put('/:id', (req, res) => {
  const existing = db.prepare(`SELECT * FROM custom_fields WHERE id=?`).get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Champ introuvable' })
  if (existing.deleted_at) return res.status(400).json({ error: 'Champ supprimé — restaurer d\'abord depuis la corbeille' })

  const updates = []
  const values = []
  let viewDirty = false

  if ('name' in (req.body || {})) {
    const n = String(req.body.name || '').trim()
    if (!n) return res.status(400).json({ error: 'Nom requis' })
    updates.push('name=?'); values.push(n)
  }
  if ('decimals' in (req.body || {})) {
    if (existing.type !== 'number') return res.status(400).json({ error: 'Décimales applicable seulement aux champs nombre' })
    const d = parseInt(req.body.decimals)
    if (!Number.isInteger(d) || d < 0 || d > 5) return res.status(400).json({ error: 'Décimales doit être entre 0 et 5' })
    updates.push('decimals=?'); values.push(d)
  }
  if ('formula_expr' in (req.body || {})) {
    if (existing.kind !== 'formula') return res.status(400).json({ error: 'formula_expr applicable seulement aux champs formule' })
    const expr = String(req.body.formula_expr || '').trim()
    try { validateFormulaExpr(expr) } catch (e) { return res.status(400).json({ error: e.message }) }
    updates.push('formula_expr=?'); values.push(expr)
    viewDirty = true
  }
  if ('lookup_target_column' in (req.body || {}) || 'lookup_target_table' in (req.body || {}) || 'lookup_fk' in (req.body || {})) {
    if (existing.kind !== 'lookup') return res.status(400).json({ error: 'Champs lookup uniquement' })
    const merged = {
      lookup_fk: req.body.lookup_fk ?? existing.lookup_fk,
      lookup_target_table: req.body.lookup_target_table ?? existing.lookup_target_table,
      lookup_target_column: req.body.lookup_target_column ?? existing.lookup_target_column,
    }
    try { validateLookup(merged, existing.erp_table) } catch (e) { return res.status(400).json({ error: e.message }) }
    updates.push('lookup_fk=?', 'lookup_target_table=?', 'lookup_target_column=?')
    values.push(merged.lookup_fk, merged.lookup_target_table, merged.lookup_target_column)
    viewDirty = true
  }

  if (updates.length === 0) return res.json(existing)
  updates.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
  values.push(req.params.id)

  const tx = db.transaction(() => {
    db.prepare(`UPDATE custom_fields SET ${updates.join(', ')} WHERE id=?`).run(...values)
    if (viewDirty) regenerateView(existing.erp_table)
  })
  try { tx() } catch (e) { return res.status(400).json({ error: e.message }) }

  const updated = db.prepare(`
    SELECT id, name, column_name, type, decimals, kind, formula_expr,
           lookup_fk, lookup_target_table, lookup_target_column, result_type, sort_order
    FROM custom_fields WHERE id=?
  `).get(req.params.id)
  res.json(updated)
})

// DELETE /api/custom-fields/:id — soft delete.
router.delete('/:id', (req, res) => {
  const existing = db.prepare(`SELECT id, erp_table, kind FROM custom_fields WHERE id=?`).get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Champ introuvable' })
  const tx = db.transaction(() => {
    db.prepare(`UPDATE custom_fields SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(req.params.id)
    // Pour les champs virtuels, on doit régénérer la vue pour les retirer.
    // Pour kind='data', la colonne physique reste mais n'est plus listée par
    // le GET — la corbeille admin peut la restaurer telle quelle.
    if (existing.kind === 'formula' || existing.kind === 'lookup') {
      regenerateView(existing.erp_table)
    }
  })
  tx()
  res.json({ ok: true })
})

// GET /api/custom-fields/all/columns/:erpTable — utilitaire interne :
// retourne juste les noms de colonnes actives (pour whitelist update côté
// routes/projects par ex). Non exposé au client.
export function getActiveCustomColumns(erpTable) {
  return db.prepare(
    `SELECT column_name, type, decimals FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL`
  ).all(erpTable)
}

export default router
