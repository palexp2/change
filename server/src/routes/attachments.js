import { Router } from 'express'
import { newRecordId } from '../utils/recordId.js'
import { randomUUID } from 'crypto'
import { makeUpload } from '../utils/upload.js'
import path from 'path'
import fs from 'fs'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { normalizeUploadName } from '../utils/uploadFileName.js'
import { uploadsPath } from '../config/uploads.js'

// Pièces jointes polymorphes : un fichier (PDF, photo, doc…) attaché à
// n'importe quel enregistrement de l'app. L'entité cible est identifiée par
// (entity_type, entity_id). Les fichiers vivent sous uploads/attachments/
// <entity_type>/<entity_id>/<uuid>_<nom>. Les chemins en DB sont relatifs à
// la racine uploads/ (cf. convention CLAUDE.md).

const router = Router()
router.use(requireAuth)

const UPLOADS_ROOT = uploadsPath()
const ATTACH_DIR = path.join(UPLOADS_ROOT, 'attachments')

// Whitelist des types d'entité autorisés → table SQL utilisée pour vérifier
// que l'enregistrement existe avant d'y rattacher un fichier. Empêche de créer
// des pièces jointes orphelines pointant vers n'importe quel type arbitraire.
const ENTITY_TABLES = {
  companies: 'companies',
  contacts: 'contacts',
  orders: 'orders',
  tickets: 'tickets',
  projects: 'projects',
  products: 'products',
  achats_fournisseurs: 'achats_fournisseurs',
  sale_receipts: 'sale_receipts',
  shipments: 'shipments',
  serial_numbers: 'serial_numbers',
  returns: 'returns',
  work_ideas: 'work_ideas',
}

function sanitizeFileName(name) {
  return String(name || 'file').replace(/[/\\?%*:|"<>]/g, '_').slice(0, 200) || 'file'
}

// Valide (entity_type, entity_id) : type connu + enregistrement existant.
// Retourne un message d'erreur (string) ou null si valide.
function validateEntity(entityType, entityId) {
  const table = ENTITY_TABLES[entityType]
  if (!table) return `Type d'entité non supporté: ${entityType}`
  if (!entityId) return 'entity_id manquant'
  const row = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(entityId)
  if (!row) return 'Enregistrement introuvable'
  return null
}

const ALLOWED_EXT = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.pdf',
  '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.zip',
]

const upload = makeUpload({
  destination: (req, file, cb) => {
    const { entityType, entityId } = req.params
    const dir = path.join(ATTACH_DIR, entityType, entityId)
    try {
      fs.mkdirSync(dir, { recursive: true })
      cb(null, dir)
    } catch (e) {
      cb(e)
    }
  },
  filename: (req, file) => `${randomUUID()}_${sanitizeFileName(file.originalname)}`,
  fileSize: 25 * 1024 * 1024,
  allowedExt: ALLOWED_EXT,
  rejectMessage: ext => `Type de fichier non supporté: ${ext || 'inconnu'}`,
})

function serialize(row) {
  return {
    id: row.id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    file_name: row.file_name,
    content_type: row.content_type,
    file_size: row.file_size,
    uploaded_by: row.uploaded_by,
    uploaded_by_name: row.uploaded_by_name || null,
    created_at: row.created_at,
  }
}

// GET /:entityType/:entityId — lister les pièces jointes d'un enregistrement
router.get('/:entityType/:entityId', (req, res) => {
  const { entityType, entityId } = req.params
  if (!ENTITY_TABLES[entityType]) return res.status(400).json({ error: 'Type d\'entité non supporté' })
  const rows = db.prepare(`
    SELECT a.*, u.name AS uploaded_by_name
    FROM attachments a
    LEFT JOIN users u ON u.id = a.uploaded_by
    WHERE a.entity_type = ? AND a.entity_id = ? AND a.deleted_at IS NULL
    ORDER BY a.created_at DESC
  `).all(entityType, entityId)
  res.json(rows.map(serialize))
})

// POST /:entityType/:entityId — uploader un ou plusieurs fichiers
router.post('/:entityType/:entityId', (req, res) => {
  const { entityType, entityId } = req.params
  const err = validateEntity(entityType, entityId)
  if (err) return res.status(400).json({ error: err })

  upload.array('file', 20)(req, res, (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message })
    const files = req.files || []
    if (!files.length) return res.status(400).json({ error: 'Aucun fichier reçu' })

    const insert = db.prepare(`
      INSERT INTO attachments (id, entity_type, entity_id, file_name, content_type, file_size, file_path, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const created = []
    const tx = db.transaction(() => {
      for (const f of files) {
        const id = newRecordId()
        const relPath = path.relative(UPLOADS_ROOT, f.path)
        insert.run(id, entityType, entityId, normalizeUploadName(f.originalname), f.mimetype, f.size, relPath, req.user?.id || null)
        created.push(id)
      }
    })
    tx()

    const rows = db.prepare(`
      SELECT a.*, u.name AS uploaded_by_name
      FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.id IN (${created.map(() => '?').join(',')})
      ORDER BY a.created_at DESC
    `).all(...created)
    res.status(201).json(rows.map(serialize))
  })
})

// GET /:entityType/:entityId/:attId/download — télécharger un fichier
router.get('/:entityType/:entityId/:attId/download', (req, res) => {
  const { entityType, entityId, attId } = req.params
  const row = db.prepare(`
    SELECT * FROM attachments WHERE id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL
  `).get(attId, entityType, entityId)
  if (!row) return res.status(404).json({ error: 'Pièce jointe introuvable' })
  const absPath = path.resolve(UPLOADS_ROOT, row.file_path)
  if (!absPath.startsWith(UPLOADS_ROOT)) return res.status(400).json({ error: 'Chemin invalide' })
  if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'Fichier introuvable' })
  if (row.content_type) res.type(row.content_type)
  res.download(absPath, row.file_name || 'piece-jointe')
})

// DELETE /:entityType/:entityId/:attId — soft delete + suppression du fichier
router.delete('/:entityType/:entityId/:attId', (req, res) => {
  const { entityType, entityId, attId } = req.params
  const row = db.prepare(`
    SELECT * FROM attachments WHERE id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL
  `).get(attId, entityType, entityId)
  if (!row) return res.status(404).json({ error: 'Pièce jointe introuvable' })

  db.prepare(`UPDATE attachments SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(attId)

  if (row.file_path) {
    const absPath = path.resolve(UPLOADS_ROOT, row.file_path)
    if (absPath.startsWith(UPLOADS_ROOT) && fs.existsSync(absPath)) {
      try { fs.unlinkSync(absPath) } catch {}
    }
  }
  res.json({ ok: true })
})

export default router
