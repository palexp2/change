import { normalizeQuestionImage, QUESTION_IMAGES, QUESTION_IMAGE_UPLOAD_PREFIX } from '../../../client/src/lib/discoveryQuestionImages.js'
import { OUTPUT_ROLES } from '../services/discoveryEquipment.js'
import { JWT_ROLES, isJwtProduct } from '../../../client/src/lib/discoveryEquipmentCatalog.js'
// Calque de surcharges du formulaire de découverte technique (System builder).
//
// Le serveur ne connaît pas le catalogue des questions : il est décrit côté
// client (client/src/lib/discoveryFormSchema.js), qui fusionne ce calque avec
// ses valeurs par défaut. Ici on ne fait que stocker/valider un JSON de forme
// connue, pour que l'utilisateur puisse réécrire le formulaire sans passer par
// une modification de l'app.
//
// La page publique /d/:token reçoit ce même calque dans son payload
// (customer-post-payment.js, champ `form_schema`) — pas d'auth requise pour le
// lire, puisqu'il ne contient que les libellés affichés au client.

import { Router } from 'express'
import multer from 'multer'
import sharp from 'sharp'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ensureUploadsDir, uploadsPath } from '../config/uploads.js'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const SINGLETON_ID = 'default'
const MAX_BYTES = 256 * 1024

const router = Router()
// Les images sont publiques comme le formulaire ; leur dépôt exige une connexion.
router.get('/images/:filename', (req, res) => {
  const image = QUESTION_IMAGE_UPLOAD_PREFIX + req.params.filename
  if (!normalizeQuestionImage(image)) return res.sendStatus(404)
  res.sendFile(join(uploadsPath('discovery'), req.params.filename), { maxAge: '1y', immutable: true }, err => {
    if (err && !res.headersSent) res.sendStatus(err.statusCode || 404)
  })
})
router.use(requireAuth)

const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } }).single('file')
router.post('/images', (req, res) => {
  imageUpload(req, res, async error => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'L’image dépasse la limite de 10 Mo.' : 'Chargez une seule image à la fois.' })
    if (!req.file) return res.status(400).json({ error: 'Choisissez une image à charger.' })
    let buffer
    try {
      const image = sharp(req.file.buffer, { limitInputPixels: 40_000_000 })
      const metadata = await image.metadata()
      if (!['jpeg', 'png', 'webp', 'gif'].includes(metadata.format)) throw new Error('format')
      buffer = await image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer()
    } catch {
      return res.status(400).json({ error: 'Image illisible ou non prise en charge. Utilisez un fichier JPG, PNG, WebP ou GIF de moins de 40 mégapixels.' })
    }
    try {
      const filename = `${randomUUID()}.webp`
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(ensureUploadsDir('discovery'), filename), buffer)
      res.status(201).json({ image: QUESTION_IMAGE_UPLOAD_PREFIX + filename })
    } catch {
      res.status(500).json({ error: 'Impossible d’enregistrer l’image. Réessayez.' })
    }
  })
})

// Lecture publique (sans passer par le router protégé) : utilisée par la page
// client du formulaire via customer-post-payment.js.
export function loadSchemaOverrides() {
  try {
    const row = db.prepare('SELECT schema_json FROM discovery_form_schema WHERE id=?').get(SINGLETON_ID)
    if (!row?.schema_json) return null
    return JSON.parse(row.schema_json)
  } catch {
    return null
  }
}

function str(v) { return typeof v === 'string' ? v : null }

// Condition d'affichage d'une question ajoutée. Le serveur ne connaît pas le
// catalogue des champs pilotes (décrit côté client) : il ne garde que la forme.
const CONDITION_OPS = ['eq', 'ne', 'filled', 'empty', 'gt', 'lt']

function visibleIf(v) {
  if (!v || typeof v !== 'object') return null
  const rules = (Array.isArray(v.rules) ? v.rules : [])
    .filter(r => r && typeof r === 'object' && str(r.field)?.trim())
    .map(r => ({
      field: String(r.field).trim(),
      op: CONDITION_OPS.includes(r.op) ? r.op : 'eq',
      value: r.value == null ? '' : String(r.value),
    }))
  if (!rules.length) return null
  return { match: v.match === 'any' ? 'any' : 'all', rules }
}

// Normalisation défensive : on ne stocke que les formes attendues. Un calque
// mal formé venant d'un client ancien ne doit pas pouvoir casser le rendu du
// formulaire public (qui, lui, retombe sur ses defaults clé par clé).
function sanitize(input) {
  const src = input && typeof input === 'object' ? input : {}
  const out = { images: {}, texts: {}, choices: {}, brands: null, hidden: {}, custom: [], equipment: { products: {} } }

  for (const [, id] of QUESTION_IMAGES) {
    const image = normalizeQuestionImage(src.images?.[id])
    if (image) out.images[id] = image
  }

  for (const [k, v] of Object.entries(src.texts || {})) {
    if (typeof k === 'string' && typeof v === 'string' && v.trim() !== '') out.texts[k] = v
  }
  // Un choix retiré est gardé comme marqueur `{ value, removed }` (sans
  // libellé) : le client sait alors le soustraire de la liste d'origine tout en
  // laissant l'utilisateur le remettre. Le marqueur `fresh` du client, lui, ne
  // passe pas : la valeur d'un choix se fige au premier enregistrement.
  for (const [k, list] of Object.entries(src.choices || {})) {
    if (!Array.isArray(list)) continue
    const opts = list
      .filter(o => o && typeof o === 'object' && str(o.value) != null && String(o.value) !== '')
      .map(o => (o.removed
        ? { value: String(o.value), removed: true }
        : (str(o.label)
          ? { value: String(o.value), label: String(o.label), ...(str(o.help) ? { help: String(o.help) } : {}) }
          : null)))
      .filter(Boolean)
    if (opts.length) out.choices[k] = opts
  }
  if (Array.isArray(src.brands)) {
    const brands = src.brands
      .filter(b => b && str(b.brand) && b.brand.trim() !== '')
      .map(b => ({
        brand: String(b.brand).trim(),
        models: Array.isArray(b.models) ? b.models.map(m => String(m).trim()).filter(Boolean) : [],
      }))
    out.brands = brands.length ? brands : null
  }
  for (const [k, v] of Object.entries(src.hidden || {})) {
    if (v) out.hidden[k] = true
  }
  if (Array.isArray(src.custom)) {
    const seen = new Set()
    for (const q of src.custom) {
      if (!q || typeof q !== 'object') continue
      const id = str(q.id)?.trim()
      const label = str(q.label)?.trim()
      if (!id || !label || seen.has(id)) continue
      seen.add(id)
      out.custom.push({
        id,
        section: str(q.section) || 'end',
        type: str(q.type) || 'text',
        label,
        help: str(q.help) || '',
        required: !!q.required,
        options: Array.isArray(q.options)
          ? q.options.filter(o => o && str(o.label)).map(o => ({ value: String(o.value ?? o.label), label: String(o.label) }))
          : [],
        visibleIf: visibleIf(q.visibleIf),
        image: normalizeQuestionImage(q.image),
      })
    }
  }
  // Les produits restent des records ERP, jamais des SKU codés. On n'accepte
  // qu'un id par rôle : les capacités (4 slots/module, etc.) ne vivent pas ici.
  if (src.equipment?.products && typeof src.equipment.products === 'object') {
    for (const [role, id] of Object.entries(src.equipment.products)) {
      if (typeof role === 'string' && typeof id === 'string' && id.trim()) out.equipment.products[role] = id.trim()
    }
  }
  out.equipment.outputs = {}
  for (const role of OUTPUT_ROLES) {
    const value = src.equipment?.outputs?.[role]
    if (Number.isInteger(value) && value >= 0 && value <= 8) out.equipment.outputs[role] = value
  }
  return out
}

// GET /api/discovery-form-schema — le calque courant (jamais 404 : {} si vierge).
router.get('/', (req, res) => {
  const row = db.prepare('SELECT * FROM discovery_form_schema WHERE id=?').get(SINGLETON_ID)
  let schema = null
  if (row?.schema_json) { try { schema = JSON.parse(row.schema_json) } catch { schema = null } }
  res.json({
    schema: schema || { texts: {}, choices: {}, brands: null, hidden: {}, custom: [], equipment: { products: {} } },
    updated_at: row?.updated_at || null,
    updated_by: row?.updated_by || null,
  })
})

// PUT /api/discovery-form-schema — remplace le calque.
router.put('/', (req, res) => {
  const clean = sanitize(req.body?.schema ?? req.body)
  for (const role of JWT_ROLES) {
    const id = clean.equipment.products[role]
    if (!id) continue
    const product = db.prepare('SELECT type FROM products WHERE id=? AND deleted_at IS NULL').get(id)
    if (!isJwtProduct(product)) return res.status(400).json({ error: 'Les permissions doivent être associées à un produit de type JWT.' })
  }
  const json = JSON.stringify(clean)
  if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) {
    return res.status(413).json({ error: 'Formulaire trop volumineux' })
  }
  db.prepare(`
    INSERT INTO discovery_form_schema (id, schema_json, updated_at, updated_by)
    VALUES (?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
    ON CONFLICT(id) DO UPDATE SET
      schema_json=excluded.schema_json,
      updated_at=excluded.updated_at,
      updated_by=excluded.updated_by
  `).run(SINGLETON_ID, json, req.user?.name || null)
  const row = db.prepare('SELECT updated_at, updated_by FROM discovery_form_schema WHERE id = ?').get(SINGLETON_ID)
  res.json({ ok: true, schema: clean, updated_at: row?.updated_at || null, updated_by: row?.updated_by || null })
})

// DELETE /api/discovery-form-schema — retour aux textes d'origine.
router.delete('/', (req, res) => {
  db.prepare('DELETE FROM discovery_form_schema WHERE id=?').run(SINGLETON_ID)
  res.json({ ok: true })
})

export default router
