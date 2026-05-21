import { Router } from 'express'
import { randomUUID } from 'crypto'
import multer from 'multer'
import { join, extname } from 'path'
import { existsSync, mkdirSync, unlinkSync } from 'fs'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { pushSaleReceiptToQB } from '../services/quickbooks.js'
import { qbEntityUrl } from '../connectors/quickbooks.js'
import { emitEntity } from '../services/realtimeEmitters.js'
import { runExtractionAndUpdate } from '../services/saleReceiptExtraction.js'

// Construit l'URL QB d'un reçu poussé. Les rangées antérieures au toggle
// Purchase/Bill n'ont pas de quickbooks_type ; on les traite comme 'purchase'.
function buildQbUrl(row) {
  if (!row.quickbooks_id) return null
  const entity = row.quickbooks_type === 'bill' ? 'bill' : 'expense'
  return qbEntityUrl(entity, row.quickbooks_id)
}

function serializeRow(row) {
  return {
    ...row,
    items: JSON.parse(row.items || '[]'),
    quickbooks_url: buildQbUrl(row),
  }
}

function fetchSaleReceiptRow(id) {
  const row = db.prepare('SELECT * FROM sale_receipts WHERE id=? AND deleted_at IS NULL').get(id)
  if (!row) return null
  return serializeRow(row)
}

const router = Router()
router.use(requireAuth)

const uploadsDir = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'receipts')
if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true })

const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf']

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
})
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase()
    if (ALLOWED_EXT.includes(ext)) cb(null, true)
    else cb(new Error('Type de fichier non supporté. Formats acceptés: JPG, PNG, GIF, WEBP, PDF'))
  },
})

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const { page = 1, limit = 100 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  const total = db.prepare('SELECT COUNT(*) as c FROM sale_receipts WHERE deleted_at IS NULL').get().c
  const rows = db.prepare(`
    SELECT * FROM sale_receipts
    WHERE deleted_at IS NULL
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(limitVal, offset)

  const parsed = rows.map(serializeRow)
  res.json({ data: parsed, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM sale_receipts WHERE id=? AND deleted_at IS NULL')
    .get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(serializeRow(row))
})

router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' })

  const ext = extname(req.file.originalname).toLowerCase()
  const id = randomUUID()

  // Insert with pending status
  db.prepare(`
    INSERT INTO sale_receipts (id, filename, original_name, file_type, status, created_by)
    VALUES (?, ?, ?, ?, 'processing', ?)
  `).run(id, req.file.filename, req.file.originalname, ext, req.user.id)

  const created = fetchSaleReceiptRow(id)
  if (created) emitEntity('sale_receipt', 'created', id, created, req.user?.id)

  // Return immediately, process async
  res.status(201).json({ id, status: 'processing' })

  const filePath = join(uploadsDir, req.file.filename)
  runExtractionAndUpdate({ saleReceiptId: id, filePath, fileExt: ext, userId: req.user?.id })
})

router.get('/:id/file', (req, res) => {
  const row = db.prepare('SELECT filename, file_type FROM sale_receipts WHERE id=? AND deleted_at IS NULL')
    .get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })

  const filePath = join(uploadsDir, row.filename)
  if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found' })

  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' }
  res.set('Content-Type', mime[row.file_type] || 'application/octet-stream')
  res.sendFile(filePath)
})

router.post('/:id/push-to-qb', async (req, res) => {
  try {
    const { type, expenseAccountId, paymentAccountId, vendorId, newVendorName, dueDate } = req.body
    const qbId = await pushSaleReceiptToQB(req.params.id, { type, expenseAccountId, paymentAccountId, vendorId, newVendorName, dueDate })
    const updated = fetchSaleReceiptRow(req.params.id)
    if (updated) emitEntity('sale_receipt', 'updated', req.params.id, updated, req.user?.id)
    res.json({ ok: true, quickbooks_id: qbId })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Délie le pointeur QB d'un reçu (sans toucher à QB) — utile après suppression
// manuelle de la transaction dans QB pour permettre un re-push.
router.delete('/:id/quickbooks-link', (req, res) => {
  const r = db.prepare(`
    UPDATE sale_receipts
    SET quickbooks_id=NULL, quickbooks_type=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id=?
  `).run(req.params.id)
  if (!r.changes) return res.status(404).json({ error: 'Not found' })
  const updated = fetchSaleReceiptRow(req.params.id)
  if (updated) emitEntity('sale_receipt', 'updated', req.params.id, updated, req.user?.id)
  res.json({ ok: true })
})

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT filename, gmail_message_id FROM sale_receipts WHERE id=? AND deleted_at IS NULL')
    .get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })

  // Le fichier est toujours purgé du disque — on ne garde que le stub en DB
  const filePath = join(uploadsDir, row.filename)
  try { if (existsSync(filePath)) unlinkSync(filePath) } catch {}

  // Si la pièce vient d'un email (gmail_message_id), soft-delete pour que
  // syncInvoiceLabel ne la réimporte pas à chaque tour ; sinon, hard-delete.
  if (row.gmail_message_id) {
    db.prepare("UPDATE sale_receipts SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?")
      .run(req.params.id)
  } else {
    db.prepare('DELETE FROM sale_receipts WHERE id=?').run(req.params.id)
  }
  emitEntity('sale_receipt', 'deleted', req.params.id, { id: req.params.id }, req.user?.id)
  res.json({ ok: true })
})

export default router
