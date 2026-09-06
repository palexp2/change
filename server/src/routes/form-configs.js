// Configuration des formulaires d'ajout de record (« Nouvelle commande »,
// « Nouveau contact »…), par table.
//
// Le formulaire de chaque page déclare la liste complète des champs que sa route
// de création accepte, avec un défaut visible/obligatoire. Cette table ne stocke
// que les ÉCARTS choisis par l'utilisateur en mode édition du formulaire :
// { field, visible, required }. Rien n'est validé contre le schéma SQL ici — la
// clé `field` est un identifiant de champ côté formulaire, jamais interpolé dans
// une requête.
import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { formFieldCatalog } from '../services/formFieldCatalog.js'

const router = Router()

const TABLE_KEY_RE = /^[a-z][a-z0-9_]{0,48}$/
const FIELD_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

function validateTable(req, res) {
  if (!TABLE_KEY_RE.test(req.params.table || '')) {
    res.status(400).json({ error: 'Table inconnue' })
    return false
  }
  return true
}

// GET /api/form-configs/:table → { fields: [{ field, visible, required }] }
router.get('/:table', requireAuth, (req, res) => {
  if (!validateTable(req, res)) return
  const row = db.prepare('SELECT fields, updated_at FROM table_form_configs WHERE table_name=?').get(req.params.table)
  let fields = []
  if (row?.fields) {
    try { fields = JSON.parse(row.fields) } catch { fields = [] }
  }
  res.json({ fields: Array.isArray(fields) ? fields : [], updated_at: row?.updated_at || null })
})

// GET /api/form-configs/:table/fields → catalogue des champs du registre
// proposables au formulaire d'ajout (en plus de ceux déclarés par la page).
// Voir services/formFieldCatalog.js pour les exclusions (calculés, lookups,
// liens, pièces jointes…) et le drapeau `writable`.
router.get('/:table/fields', requireAuth, (req, res) => {
  if (!validateTable(req, res)) return
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(req.params.table)
  if (!exists) return res.json({ fields: [] })
  res.json({ fields: formFieldCatalog(req.params.table) })
})

// PUT /api/form-configs/:table — remplace la configuration complète.
router.put('/:table', requireAdmin, (req, res) => {
  if (!validateTable(req, res)) return
  const input = req.body?.fields
  if (!Array.isArray(input)) return res.status(400).json({ error: 'fields doit être un tableau' })
  if (input.length > 200) return res.status(400).json({ error: 'Trop de champs' })

  const seen = new Set()
  const fields = []
  for (const f of input) {
    const key = typeof f?.field === 'string' ? f.field.trim() : ''
    if (!FIELD_KEY_RE.test(key)) return res.status(400).json({ error: `Champ invalide : ${key || '(vide)'}` })
    if (seen.has(key)) return res.status(400).json({ error: `Champ en double : ${key}` })
    seen.add(key)
    fields.push({ field: key, visible: f.visible !== false, required: f.required === true })
  }

  db.prepare(`
    INSERT INTO table_form_configs (table_name, fields, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(table_name) DO UPDATE SET fields=excluded.fields, updated_at=excluded.updated_at
  `).run(req.params.table, JSON.stringify(fields))

  res.json({ fields })
})

export default router
