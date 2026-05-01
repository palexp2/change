import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// Tables sur lesquelles on autorise les champs custom. Étendre au besoin.
const ALLOWED_TABLES = new Set(['projects'])

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

// GET /api/custom-fields/:erpTable — liste les champs custom actifs pour une table.
router.get('/:erpTable', (req, res) => {
  const { erpTable } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée pour les champs custom' })
  const rows = db.prepare(
    `SELECT id, name, column_name, type, decimals, sort_order
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

// PUT /api/custom-fields/:id — modifie nom et/ou décimales (pas le type, pas le column_name).
router.put('/:id', (req, res) => {
  const existing = db.prepare(`SELECT * FROM custom_fields WHERE id=?`).get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Champ introuvable' })
  if (existing.deleted_at) return res.status(400).json({ error: 'Champ supprimé — restaurer d\'abord depuis la corbeille' })

  const updates = []
  const values = []
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
  if (updates.length === 0) return res.json(existing)
  updates.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
  values.push(req.params.id)
  db.prepare(`UPDATE custom_fields SET ${updates.join(', ')} WHERE id=?`).run(...values)
  const updated = db.prepare(`SELECT id, name, column_name, type, decimals, sort_order FROM custom_fields WHERE id=?`).get(req.params.id)
  res.json(updated)
})

// DELETE /api/custom-fields/:id — soft delete.
router.delete('/:id', (req, res) => {
  const existing = db.prepare(`SELECT id FROM custom_fields WHERE id=?`).get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Champ introuvable' })
  db.prepare(`UPDATE custom_fields SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(req.params.id)
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
