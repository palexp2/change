import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { requireAdmin } from '../middleware/auth.js'
import { getFrozenColumns } from '../services/airtableFrozenColumns.js'

const router = Router()

// Tables sur lesquelles on autorise l'édition de colonnes Airtable.
// Aligne sur ALLOWED_TABLES de routes/views.js — toute table avec des
// airtable_field_defs doit pouvoir y figurer.
const ALLOWED_TABLES = new Set([
  'companies', 'contacts', 'projects', 'products',
  'orders', 'order_items', 'tickets', 'purchases', 'serial_numbers', 'interactions', 'shipments',
  'abonnements', 'retours', 'returns', 'return_items', 'adresses', 'soumissions',
  'factures', 'assemblages', 'achats_fournisseurs', 'tasks',
  'employees', 'paies', 'paie_items', 'bom_items',
  'company_serials',
])

const VALID_FIELD_TYPES = new Set([
  'text', 'long_text', 'number', 'date',
  'single_select', 'multi_select', 'checkbox', 'link',
])

// Colonnes système — jamais supprimables même via cette route.
const SYSTEM_COLUMNS = new Set([
  'id', 'airtable_id', 'created_at', 'updated_at', 'deleted_at',
  'rowid', 'oid', '_rowid_',
])

// PATCH /api/airtable-fields/:id — modifie field_type (et optionnellement options).
// La donnée stockée n'est pas convertie : SQLite typage faible, le field_type
// gouverne uniquement le rendu UI (DataTable, filtres, group_by).
router.patch('/:id', requireAdmin, (req, res) => {
  const def = db.prepare('SELECT * FROM airtable_field_defs WHERE id=?').get(req.params.id)
  if (!def) return res.status(404).json({ error: 'Champ introuvable' })

  const body = req.body || {}
  const updates = []
  const values = []

  if ('field_type' in body) {
    if (!VALID_FIELD_TYPES.has(body.field_type)) {
      return res.status(400).json({ error: `field_type doit être l'un de : ${[...VALID_FIELD_TYPES].join(', ')}` })
    }
    updates.push('field_type=?')
    values.push(body.field_type)
  }

  if ('options' in body) {
    if (body.options !== null && (typeof body.options !== 'object' || Array.isArray(body.options))) {
      return res.status(400).json({ error: 'options doit être un objet' })
    }
    updates.push('options=?')
    values.push(JSON.stringify(body.options || {}))
  }

  if ('display_label' in body) {
    // Renommage utilisateur — on ne touche jamais au column_name SQLite
    // (cassations garanties), juste le label affiché par DataTable, filtres,
    // group_by, fiche détail (via views.js qui prend display_label en priorité).
    const trimmed = body.display_label == null ? null : String(body.display_label).trim()
    updates.push('display_label=?')
    values.push(trimmed || null)
  }

  if (!updates.length) return res.status(400).json({ error: 'Aucun champ à modifier' })

  updates.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
  values.push(req.params.id)
  db.prepare(`UPDATE airtable_field_defs SET ${updates.join(', ')} WHERE id=?`).run(...values)

  const updated = db.prepare(
    'SELECT id, erp_table, column_name, airtable_field_name, display_label, field_type, options FROM airtable_field_defs WHERE id=?'
  ).get(req.params.id)
  res.json({ ...updated, options: JSON.parse(updated.options || '{}') })
})

// DELETE /api/airtable-fields/:id — supprime la colonne SQLite + la def.
// Garde-fous : pas de colonne système, pas de colonne frozen.
router.delete('/:id', requireAdmin, (req, res) => {
  const def = db.prepare('SELECT * FROM airtable_field_defs WHERE id=?').get(req.params.id)
  if (!def) return res.status(404).json({ error: 'Champ introuvable' })

  if (!ALLOWED_TABLES.has(def.erp_table)) {
    return res.status(400).json({ error: 'Table non supportée' })
  }
  if (SYSTEM_COLUMNS.has(def.column_name)) {
    return res.status(400).json({ error: 'Colonne système — non supprimable' })
  }
  if (def.column_name === '__pending__') {
    // Placeholder qui n'a jamais matérialisé de colonne — supprime juste la def.
    db.prepare('DELETE FROM airtable_field_defs WHERE id=?').run(req.params.id)
    return res.json({ ok: true })
  }
  if (getFrozenColumns(def.erp_table).has(def.column_name)) {
    return res.status(400).json({ error: 'Colonne gelée (frozen) — non supprimable' })
  }

  // Vérifie que la colonne existe avant de tenter le DROP — si déjà absente
  // on supprime juste la def sans erreur.
  const liveCols = new Set(db.prepare(`PRAGMA table_info(${def.erp_table})`).all().map(c => c.name))
  const tx = db.transaction(() => {
    if (liveCols.has(def.column_name)) {
      db.exec(`ALTER TABLE ${def.erp_table} DROP COLUMN ${def.column_name}`)
    }
    db.prepare('DELETE FROM airtable_field_defs WHERE id=?').run(req.params.id)
  })
  try {
    tx()
  } catch (e) {
    return res.status(500).json({ error: `Échec suppression : ${e.message}` })
  }

  console.log(`🗑️  Colonne ${def.erp_table}.${def.column_name} supprimée`)
  res.json({ ok: true })
})

// PUT /api/airtable-fields/by-column/:erpTable/:colName
// Upsert d'une def par (erp_table, column_name) — utile pour la page de
// gestion des champs où l'utilisateur agit sur une colonne ERP même si
// aucune def n'existait au préalable (ex. colonnes orphelines historiques
// créées avant qu'on retire l'auto-création).
//
// Body : { display_label?, field_type?, options? } — toute combinaison.
router.put('/by-column/:erpTable/:colName', requireAdmin, (req, res) => {
  const { erpTable, colName } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée' })
  if (SYSTEM_COLUMNS.has(colName)) return res.status(400).json({ error: 'Colonne système — non éditable' })

  // Vérifie que la colonne existe vraiment
  let liveCols
  try { liveCols = db.prepare(`PRAGMA table_info(${erpTable})`).all().map(c => c.name) }
  catch { return res.status(400).json({ error: `Table inconnue : ${erpTable}` }) }
  if (!liveCols.includes(colName)) return res.status(400).json({ error: `Colonne "${colName}" introuvable` })

  const body = req.body || {}
  if (body.field_type && !VALID_FIELD_TYPES.has(body.field_type)) {
    return res.status(400).json({ error: `field_type doit être l'un de : ${[...VALID_FIELD_TYPES].join(', ')}` })
  }

  const existing = db.prepare(
    'SELECT * FROM airtable_field_defs WHERE erp_table=? AND column_name=?'
  ).get(erpTable, colName)

  if (existing) {
    const updates = []
    const values = []
    if ('display_label' in body) {
      const trimmed = body.display_label == null ? null : String(body.display_label).trim()
      updates.push('display_label=?'); values.push(trimmed || null)
    }
    if (body.field_type) {
      updates.push('field_type=?'); values.push(body.field_type)
    }
    if ('options' in body) {
      if (body.options !== null && (typeof body.options !== 'object' || Array.isArray(body.options))) {
        return res.status(400).json({ error: 'options doit être un objet' })
      }
      updates.push('options=?'); values.push(JSON.stringify(body.options || {}))
    }
    if (!updates.length) return res.json({ id: existing.id, ok: true, created: false })
    updates.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
    values.push(existing.id)
    db.prepare(`UPDATE airtable_field_defs SET ${updates.join(', ')} WHERE id=?`).run(...values)
    return res.json({ id: existing.id, ok: true, created: false })
  }

  // Création — pas de mapping Airtable, juste une def "shell" pour porter
  // les métadonnées de la colonne. airtable_field_id préfixé `orphan_` pour
  // distinguer des natives (`native_`) et des vraies mappées (`rec_…`).
  const id = uuid()
  const ftype = body.field_type || 'text'
  const display = body.display_label == null ? null : String(body.display_label).trim() || null
  db.prepare(`
    INSERT INTO airtable_field_defs (id, module, erp_table, airtable_field_id, airtable_field_name, display_label, column_name, field_type, options, sort_order, import_disabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
  `).run(id, erpTable, erpTable, `orphan_${colName}`, display || colName, display, colName, ftype, JSON.stringify(body.options || {}))
  res.json({ id, ok: true, created: true })
})

export default router
