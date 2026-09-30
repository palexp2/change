import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { tracked } from '../services/syncState.js'
import { logSync } from '../services/syncLog.js'
import { routeSync, ENGINE_ONLY_SYNCS } from '../services/airtableMirrorEngine.js'
import { getAccessToken, airtablePost, airtablePatch, airtableDelete } from '../connectors/airtable.js'
import { emit } from '../services/realtime.js'
import { newRecordId } from '../utils/recordId.js'
import { makeUpload } from '../utils/upload.js'
import { uploadsPath, ensureUploadsDir } from '../config/uploads.js'
import fs from 'fs'
import path from 'path'

// Achats de fournitures (bureau, entretien, emballage) — miroir des tables
// Airtable « Fournitures » et « Achats fournitures » (cf. migration 086).
const router = Router()

// Liste : le catalogue, chaque fourniture avec le résumé de ses achats (le
// détail des achats vit dans sa fiche).
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT f.*,
           COUNT(a.id) AS achats_count,
           MAX(a.purchased_at) AS last_purchased_at,
           ROUND(SUM(COALESCE(a.qty, 0) * COALESCE(a.unit_price, 0)), 2) AS total_spent
    FROM fournitures f
    LEFT JOIN achats_fournitures a ON a.fourniture_id = f.id
    GROUP BY f.id
    ORDER BY f.name COLLATE NOCASE
  `).all()
  res.json({ data: rows, total: rows.length })
})

// Nouvel achat : même principe que la fourniture ci-dessous — il naît dans
// Airtable (lié à la fourniture par son airtable_id), puis la ligne ERP est
// posée avec l'airtable_id que le sync suivant retrouvera.
router.post('/achats', requireAuth, async (req, res) => {
  const body = req.body || {}
  const f = body.fourniture_id
    ? db.prepare('SELECT id, airtable_id FROM fournitures WHERE id = ?').get(String(body.fourniture_id))
    : null
  if (!f) return res.status(400).json({ error: 'Fourniture requise' })
  if (!f.airtable_id) return res.status(400).json({ error: 'Fourniture absente d\'Airtable' })
  const purchasedAt = String(body.purchased_at || '').trim() || new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(purchasedAt)) return res.status(400).json({ error: 'Date invalide' })
  const num = v => (v == null || v === '' ? null : Number(v))
  const qty = num(body.qty) ?? 1
  const unitPrice = num(body.unit_price)
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Quantité invalide' })
  if (unitPrice != null && (!Number.isFinite(unitPrice) || unitPrice < 0)) return res.status(400).json({ error: 'Prix invalide' })

  const cfg = db.prepare("SELECT base_id, table_id, field_map FROM airtable_module_config WHERE module='achats_fournitures'").get()
  let fieldMap = {}
  try { fieldMap = JSON.parse(cfg?.field_map || '{}') } catch { /* config illisible → 502 ci-dessous */ }
  if (!cfg?.base_id || !cfg?.table_id || !fieldMap.fourniture) {
    return res.status(502).json({ error: 'Configuration Airtable des achats absente' })
  }
  const fields = { [fieldMap.fourniture]: [f.airtable_id] }
  if (fieldMap.purchased_at) fields[fieldMap.purchased_at] = purchasedAt
  if (fieldMap.qty) fields[fieldMap.qty] = qty
  if (fieldMap.unit_price && unitPrice != null) fields[fieldMap.unit_price] = unitPrice

  const t0 = Date.now()
  try {
    const token = await getAccessToken()
    const created = await airtablePost(`/${cfg.base_id}/${cfg.table_id}`, token, { fields, typecast: true })
    if (!created?.id) throw new Error('réponse Airtable sans id')
    const id = newRecordId()
    db.prepare('INSERT INTO achats_fournitures (id, airtable_id, fourniture_id, purchased_at, qty, unit_price) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, created.id, f.id, purchasedAt, qty, unitPrice)
    logSync('achats_fournitures', 'erp-create', { status: 'success', modified: 1, durationMs: Date.now() - t0 })
    res.status(201).json(db.prepare('SELECT * FROM achats_fournitures WHERE id = ?').get(id))
  } catch (e) {
    logSync('achats_fournitures', 'erp-create', { status: 'error', error: e.message, durationMs: Date.now() - t0 })
    res.status(502).json({ error: e.message })
  }
})

// Nouvelle fourniture : Airtable reste la source du miroir, donc elle y naît
// d'abord ; la ligne ERP est posée tout de suite avec son airtable_id, que le
// sync suivant retrouve (upsert par airtable_id) au lieu de la dupliquer.
const CREATE_COLUMNS = ['name', 'supplier', 'reference_price', 'unit', 'web_url', 'notes']

router.post('/', requireAuth, async (req, res) => {
  const body = req.body || {}
  const row = {}
  for (const col of CREATE_COLUMNS) {
    const v = body[col]
    if (v == null || v === '') continue
    row[col] = col === 'reference_price' ? Number(v) : String(v).trim()
  }
  if (!row.name) return res.status(400).json({ error: 'Nom requis' })
  if (row.reference_price != null && !Number.isFinite(row.reference_price)) {
    return res.status(400).json({ error: 'Prix de référence invalide' })
  }

  const cfg = db.prepare("SELECT base_id, table_id, field_map FROM airtable_module_config WHERE module='fournitures'").get()
  let fieldMap = {}
  try { fieldMap = JSON.parse(cfg?.field_map || '{}') } catch { /* config illisible → 502 ci-dessous */ }
  if (!cfg?.base_id || !cfg?.table_id || !fieldMap.name) {
    return res.status(502).json({ error: 'Configuration Airtable des fournitures absente' })
  }
  const fields = {}
  for (const [col, v] of Object.entries(row)) if (fieldMap[col]) fields[fieldMap[col]] = v

  const t0 = Date.now()
  try {
    const token = await getAccessToken()
    const created = await airtablePost(`/${cfg.base_id}/${cfg.table_id}`, token, { fields, typecast: true })
    if (!created?.id) throw new Error('réponse Airtable sans id')
    const id = newRecordId()
    const cols = Object.keys(row)
    db.prepare(`INSERT INTO fournitures (id, airtable_id, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`)
      .run(id, created.id, ...cols.map(c => row[c]))
    logSync('fournitures', 'erp-create', { status: 'success', modified: 1, durationMs: Date.now() - t0 })
    res.status(201).json(db.prepare('SELECT * FROM fournitures WHERE id = ?').get(id))
  } catch (e) {
    logSync('fournitures', 'erp-create', { status: 'error', error: e.message, durationMs: Date.now() - t0 })
    res.status(502).json({ error: e.message })
  }
})

// Modification sur place (autosave de la fiche). Airtable reste la source du
// miroir : on l'y écrit d'abord, sinon le sync suivant ramènerait l'ancienne
// valeur. `cols` : colonne ERP → normaliseur (renvoie undefined si invalide).
const text = v => String(v ?? '').trim() || null
const amount = v => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}
const day = v => { const s = String(v ?? '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined }
const positive = v => { const n = Number(v); return v !== '' && v != null && Number.isFinite(n) && n > 0 ? n : undefined }

function patchMirrored({ module, table, cols, required = [], label }) {
  return async (req, res) => {
    const row = db.prepare(`SELECT id, airtable_id FROM ${table} WHERE id = ?`).get(req.params.id)
    if (!row) return res.status(404).json({ error: `${label} introuvable` })
    const body = req.body || {}
    const patch = {}
    for (const [col, norm] of Object.entries(cols)) {
      if (!(col in body)) continue
      const v = norm(body[col])
      if (v === undefined || (v == null && required.includes(col))) return res.status(400).json({ error: `Valeur invalide : ${col}` })
      patch[col] = v
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Aucun champ modifiable' })

    const t0 = Date.now()
    try {
      if (row.airtable_id) {
        const cfg = db.prepare('SELECT base_id, table_id, field_map FROM airtable_module_config WHERE module = ?').get(module)
        let fieldMap = {}
        try { fieldMap = JSON.parse(cfg?.field_map || '{}') } catch { /* config illisible → erreur ci-dessous */ }
        const missing = Object.keys(patch).filter(c => !fieldMap[c])
        if (!cfg?.base_id || !cfg?.table_id || missing.length) throw new Error(`Configuration Airtable absente (${module})`)
        const fields = {}
        for (const [c, v] of Object.entries(patch)) fields[fieldMap[c]] = v
        const token = await getAccessToken()
        await airtablePatch(`/${cfg.base_id}/${cfg.table_id}/${row.airtable_id}`, token, { fields, typecast: true })
      }
      const sets = Object.keys(patch).map(c => `${c} = ?`).join(', ')
      db.prepare(`UPDATE ${table} SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
        .run(...Object.values(patch), row.id)
      logSync(module, 'erp-update', { status: 'success', modified: 1, durationMs: Date.now() - t0 })
      res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(row.id))
    } catch (e) {
      logSync(module, 'erp-update', { status: 'error', error: e.message, durationMs: Date.now() - t0 })
      res.status(502).json({ error: e.message })
    }
  }
}

router.patch('/achats/:id', requireAuth, patchMirrored({
  module: 'achats_fournitures', table: 'achats_fournitures', label: 'Achat',
  cols: { purchased_at: day, qty: positive, unit_price: amount },
  required: ['purchased_at'],
}))

router.patch('/:id', requireAuth, patchMirrored({
  module: 'fournitures', table: 'fournitures', label: 'Fourniture',
  cols: { name: text, supplier: text, reference_price: amount, unit: text, web_url: text, notes: text },
  required: ['name'],
}))

// Image de la fiche. Même copie locale que celle du miroir (dossier des images
// produits) ; le préfixe `local-` la protège de la synchro suivante, qui sinon
// la remplacerait par la pièce jointe Airtable (cf. piecesPrepareImages).
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']
const imageUpload = makeUpload({
  destination: (req, file, cb) => { try { cb(null, ensureUploadsDir('products')) } catch (e) { cb(e) } },
  filename: (req, file) => `local-fourniture-${req.params.id}${path.extname(file.originalname).toLowerCase()}`,
  fileSize: 10 * 1024 * 1024,
  allowedExt: IMAGE_EXT,
  rejectMessage: ext => `Image non supportée : ${ext || 'sans extension'}`,
}).single('file')

// Seuls les dépôts manuels sont à nous : une copie du miroir reste sur disque.
function unlinkLocalImage(imageUrl) {
  const name = String(imageUrl || '').split('/').pop()
  if (!name.startsWith('local-')) return
  try { fs.unlinkSync(path.join(uploadsPath('products'), name)) } catch { /* déjà parti */ }
}

function setImage(id, imageUrl) {
  db.prepare("UPDATE fournitures SET image_url = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(imageUrl, id)
  return db.prepare('SELECT * FROM fournitures WHERE id = ?').get(id)
}

router.post('/:id/image', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, image_url FROM fournitures WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Fourniture introuvable' })
  imageUpload(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message })
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier' })
    const imageUrl = `/erp/api/product-images/${req.file.filename}`
    if (row.image_url && row.image_url !== imageUrl) unlinkLocalImage(row.image_url)
    res.json(setImage(row.id, imageUrl))
  })
})

// Retrait : la pièce jointe Airtable est vidée aussi, sinon le sync suivant la
// ramènerait.
router.delete('/:id/image', requireAuth, async (req, res) => {
  const row = db.prepare('SELECT id, airtable_id, image_url FROM fournitures WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Fourniture introuvable' })
  const t0 = Date.now()
  try {
    if (row.airtable_id) {
      const cfg = db.prepare("SELECT base_id, table_id, field_map FROM airtable_module_config WHERE module='fournitures'").get()
      let fieldMap = {}
      try { fieldMap = JSON.parse(cfg?.field_map || '{}') } catch { /* config illisible → rien à vider */ }
      if (cfg?.base_id && cfg?.table_id && fieldMap.image) {
        const token = await getAccessToken()
        await airtablePatch(`/${cfg.base_id}/${cfg.table_id}/${row.airtable_id}`, token, { fields: { [fieldMap.image]: [] } })
        logSync('fournitures', 'erp-update', { status: 'success', modified: 1, durationMs: Date.now() - t0 })
      }
    }
    unlinkLocalImage(row.image_url)
    res.json(setImage(row.id, null))
  } catch (e) {
    logSync('fournitures', 'erp-update', { status: 'error', error: e.message, durationMs: Date.now() - t0 })
    res.status(502).json({ error: e.message })
  }
})

// Suppression : d'abord dans Airtable (sinon le sync suivant la ramènerait),
// puis ici. Ses achats restent, sans fourniture (comme dans Airtable).
router.delete('/:id', requireAuth, async (req, res) => {
  const row = db.prepare('SELECT id, airtable_id FROM fournitures WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Fourniture introuvable' })
  const t0 = Date.now()
  try {
    if (row.airtable_id) {
      const cfg = db.prepare("SELECT base_id, table_id FROM airtable_module_config WHERE module='fournitures'").get()
      if (!cfg?.base_id || !cfg?.table_id) throw new Error('Configuration Airtable des fournitures absente')
      const token = await getAccessToken()
      await airtableDelete(`/${cfg.base_id}/${cfg.table_id}`, token, [row.airtable_id])
    }
    db.prepare('DELETE FROM fournitures WHERE id = ?').run(row.id)
    logSync('fournitures', 'erp-delete', { status: 'success', modified: 1, durationMs: Date.now() - t0 })
    emit('fournitures:list', { type: 'fournitures:deleted', payload: { id: row.id } })
    res.json({ ok: true })
  } catch (e) {
    logSync('fournitures', 'erp-delete', { status: 'error', error: e.message, durationMs: Date.now() - t0 })
    res.status(502).json({ error: e.message })
  }
})

// Fiche d'une fourniture : le catalogue + tous ses achats, plus récent d'abord.
router.get('/:id', requireAuth, (req, res) => {
  const f = db.prepare('SELECT * FROM fournitures WHERE id = ?').get(req.params.id)
  if (!f) return res.status(404).json({ error: 'Fourniture introuvable' })
  const achats = db.prepare(`
    SELECT *,
           ROUND(COALESCE(qty, 0) * COALESCE(unit_price, 0), 2) AS total
    FROM achats_fournitures
    WHERE fourniture_id = ?
    ORDER BY purchased_at DESC, created_at DESC
  `).all(f.id)
  res.json({ ...f, achats })
})

// Relit les deux tables dans Airtable, fournitures d'abord (les achats les
// lient). Attend la fin : la page recharge sa liste juste après.
router.post('/sync', requireAuth, async (req, res) => {
  const t0 = Date.now()
  try {
    for (const [module, fn] of Object.entries(ENGINE_ONLY_SYNCS)) {
      await tracked(module, () => routeSync(module, null, fn))
      logSync(module, 'manual', { status: 'success', durationMs: Date.now() - t0 })
    }
    res.json({ ok: true })
  } catch (e) {
    logSync('achats_fournitures', 'manual', { status: 'error', error: e.message, durationMs: Date.now() - t0 })
    res.status(502).json({ error: e.message })
  }
})

export default router
