import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

// Overrides d'affichage des champs natifs d'une table (renommage / changement
// de type). Purement cosmétique côté client : aucune colonne SQL n'est
// modifiée, les syncs continuent d'écrire dans les colonnes d'origine. Voir
// FieldOverrideModal.jsx (client) pour l'avertissement affiché quand le champ
// est alimenté par une sync.
const router = Router()
router.use(requireAuth)

// `erp_table` est une clé de vue DataTable (ex. 'factures', 'company_orders'),
// pas forcément une table SQL — on valide juste le format.
const TABLE_RE = /^[a-z0-9_]{1,64}$/
const FIELD_RE = /^[a-zA-Z0-9_]{1,80}$/
// Types d'affichage supportés par applyFieldOverrides côté client.
const ALLOWED_TYPES = new Set(['text', 'number', 'currency', 'date', 'boolean', 'url', 'phone'])

function validateParams(req, res) {
  const { table, fieldId } = req.params
  if (!TABLE_RE.test(table)) { res.status(400).json({ error: 'Table invalide' }); return null }
  if (fieldId !== undefined && !FIELD_RE.test(fieldId)) { res.status(400).json({ error: 'Champ invalide' }); return null }
  return { table, fieldId }
}

// Liste des overrides actifs d'une table.
router.get('/:table', (req, res) => {
  const p = validateParams(req, res)
  if (!p) return
  const rows = db.prepare(
    `SELECT field_id, label, type, decimals, country_code FROM field_overrides
     WHERE erp_table = ? AND deleted_at IS NULL`
  ).all(p.table)
  res.json({ data: rows })
})

// Upsert d'un override. Body : { label?, type?, decimals? } — au moins label
// ou type requis (null = pas d'override sur cet aspect).
router.put('/:table/:fieldId', (req, res) => {
  const p = validateParams(req, res)
  if (!p) return
  const { label, type, decimals, country_code } = req.body || {}
  let cleanLabel = null
  if (label != null) {
    if (typeof label !== 'string' || !label.trim() || label.trim().length > 120) {
      return res.status(400).json({ error: 'Libellé invalide (1 à 120 caractères)' })
    }
    cleanLabel = label.trim()
  }
  if (type != null && !ALLOWED_TYPES.has(type)) {
    return res.status(400).json({ error: `Type invalide (${[...ALLOWED_TYPES].join(', ')})` })
  }
  let cleanDecimals = null
  if (decimals != null) {
    const d = Number(decimals)
    if (!Number.isInteger(d) || d < 0 || d > 5) return res.status(400).json({ error: 'Décimales invalides (0 à 5)' })
    cleanDecimals = d
  }
  // Préférence d'indicatif de pays pour les champs téléphone : 'show' | 'hide'.
  let cleanCountryCode = null
  if (country_code != null) {
    if (country_code !== 'show' && country_code !== 'hide') {
      return res.status(400).json({ error: "Indicatif invalide ('show' ou 'hide')" })
    }
    cleanCountryCode = country_code
  }
  if (cleanLabel == null && type == null && cleanCountryCode == null) {
    return res.status(400).json({ error: 'Rien à enregistrer : libellé, type ou indicatif requis' })
  }
  db.prepare(
    `INSERT INTO field_overrides (erp_table, field_id, label, type, decimals, country_code, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(erp_table, field_id) DO UPDATE SET
       label = excluded.label,
       type = excluded.type,
       decimals = excluded.decimals,
       country_code = excluded.country_code,
       updated_at = excluded.updated_at,
       deleted_at = NULL`
  ).run(p.table, p.fieldId, cleanLabel, type ?? null, cleanDecimals, cleanCountryCode)
  res.json({ data: { field_id: p.fieldId, label: cleanLabel, type: type ?? null, decimals: cleanDecimals, country_code: cleanCountryCode } })
})

// Réinitialise un champ à ses valeurs d'origine (soft delete de l'override).
router.delete('/:table/:fieldId', (req, res) => {
  const p = validateParams(req, res)
  if (!p) return
  db.prepare(
    `UPDATE field_overrides SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE erp_table = ? AND field_id = ? AND deleted_at IS NULL`
  ).run(p.table, p.fieldId)
  res.json({ ok: true })
})

export default router
