import { Router } from 'express'
import { randomUUID } from 'crypto'
import path from 'path'
import fs from 'fs'
import db from '../db/database.js'
import { buildPartialUpdate } from '../utils/partialUpdate.js'
import { requireAuth } from '../middleware/auth.js'
import { qbGet, qbAttachmentDownloadUrl } from '../connectors/quickbooks.js'

const router = Router()
router.use(requireAuth)

const UPLOADS_ROOT = path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads')
const QB_ATTACH_DIR = path.join(UPLOADS_ROOT, 'qb-attachments')

function sanitizeFileName(name) {
  return String(name || 'file').replace(/[/\\?%*:|"<>]/g, '_').slice(0, 200) || 'file'
}

router.get('/', (req, res) => {
  const { type, status, category, vendor_id, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  let where = ''
  const params = []
  const add = (cond, val) => { where += (where ? ' AND' : ' WHERE') + ' ' + cond; params.push(val) }
  if (type) add('a.type = ?', type)
  if (status) add('a.status = ?', status)
  if (category) add('a.category = ?', category)
  if (vendor_id) add('a.vendor_id = ?', vendor_id)

  const total = db.prepare(`SELECT COUNT(*) as c FROM achats_fournisseurs a ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT a.*, u.name as created_by_name
    FROM achats_fournisseurs a
    LEFT JOIN users u ON a.created_by = u.id
    ${where}
    ORDER BY a.date_achat DESC, a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/:id', (req, res) => {
  const row = db.prepare(`
    SELECT a.*, u.name as created_by_name
    FROM achats_fournisseurs a
    LEFT JOIN users u ON a.created_by = u.id
    WHERE a.id = ?
  `).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const {
    type, date_achat, due_date, vendor, vendor_id,
    vendor_invoice_number, bill_number, reference, description, category, payment_method,
    amount_cad, tax_cad, total_cad, amount_paid_cad, status, notes, lines,
  } = req.body

  if (!type || !['bill','purchase'].includes(type)) return res.status(400).json({ error: 'type invalide' })
  if (!date_achat) return res.status(400).json({ error: 'date_achat requise' })
  if (type === 'bill' && !vendor) return res.status(400).json({ error: 'vendor requis pour une facture' })
  if (type === 'purchase' && !description) return res.status(400).json({ error: 'description requise pour une dépense' })

  const id = randomUUID()
  const tot = total_cad != null ? total_cad : ((amount_cad || 0) + (tax_cad || 0))
  const defaultStatus = type === 'bill' ? 'Reçue' : 'Brouillon'

  db.prepare(`
    INSERT INTO achats_fournisseurs
      (id, type, date_achat, due_date, vendor, vendor_id,
       vendor_invoice_number, bill_number, reference, description, category, payment_method,
       amount_cad, tax_cad, total_cad, amount_paid_cad, status, notes, lines, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, type, date_achat, due_date || null, vendor || null, vendor_id || null,
    vendor_invoice_number || null, bill_number || null, reference || null, description || null,
    category || null, payment_method || null,
    amount_cad || 0, tax_cad || 0, tot, amount_paid_cad || 0,
    status || defaultStatus, notes || null, lines || null, req.user.id
  )

  res.status(201).json(db.prepare('SELECT * FROM achats_fournisseurs WHERE id = ?').get(id))
})

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id, type FROM achats_fournisseurs WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })

  // If total_cad is absent but amount_cad / tax_cad are touched, recompute it
  const body = { ...req.body }
  if (!('total_cad' in body) && ('amount_cad' in body || 'tax_cad' in body)) {
    const existingRow = db.prepare('SELECT amount_cad, tax_cad FROM achats_fournisseurs WHERE id = ?').get(req.params.id)
    const amt = 'amount_cad' in body ? (Number(body.amount_cad) || 0) : (existingRow.amount_cad || 0)
    const tax = 'tax_cad' in body ? (Number(body.tax_cad) || 0) : (existingRow.tax_cad || 0)
    body.total_cad = amt + tax
  }

  const { setClause, values, error } = buildPartialUpdate(body, {
    allowed: ['date_achat', 'due_date', 'vendor', 'vendor_id',
      'vendor_invoice_number', 'bill_number', 'reference', 'description', 'category', 'payment_method',
      'amount_cad', 'tax_cad', 'total_cad', 'amount_paid_cad', 'status', 'notes', 'lines'],
    nonNullable: new Set(['date_achat', 'status']),
  })
  if (error) return res.status(400).json({ error })
  if (setClause) {
    db.prepare(`UPDATE achats_fournisseurs SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id)
  }

  res.json(db.prepare('SELECT * FROM achats_fournisseurs WHERE id = ?').get(req.params.id))
})

router.patch('/:id/status', (req, res) => {
  const existing = db.prepare('SELECT id FROM achats_fournisseurs WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare(`UPDATE achats_fournisseurs SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(req.body.status, req.params.id)
  res.json({ ok: true })
})

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM achats_fournisseurs WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare('DELETE FROM achats_fournisseurs WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// --- QB attachments ---

router.get('/:id/attachments', (req, res) => {
  const rows = db.prepare(`
    SELECT id, qb_id, file_name, content_type, file_size, note, fetched_at
    FROM qb_attachments WHERE achat_id = ?
    ORDER BY fetched_at DESC
  `).all(req.params.id)
  res.json(rows)
})

router.post('/:id/fetch-qb-attachments', async (req, res) => {
  const achat = db.prepare('SELECT id, type, quickbooks_id FROM achats_fournisseurs WHERE id = ?').get(req.params.id)
  if (!achat) return res.status(404).json({ error: 'Not found' })
  if (!achat.quickbooks_id) return res.status(400).json({ error: 'Cet achat n\'est pas lié à QuickBooks' })

  try {
    const entity = achat.type === 'bill' ? 'Bill' : 'Purchase'
    const query = `SELECT * FROM Attachable WHERE AttachableRef.EntityRef.Type = '${entity}' AND AttachableRef.EntityRef.Value = '${achat.quickbooks_id}'`
    const qResp = await qbGet(`/query?query=${encodeURIComponent(query)}`)
    const attachables = qResp?.QueryResponse?.Attachable || []

    const achatDir = path.join(QB_ATTACH_DIR, achat.id)
    fs.mkdirSync(achatDir, { recursive: true })

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO qb_attachments
        (id, achat_id, qb_id, file_name, content_type, file_size, file_path, note)
      VALUES (?,?,?,?,?,?,?,?)
    `)
    const existingStmt = db.prepare('SELECT 1 FROM qb_attachments WHERE achat_id = ? AND qb_id = ?')

    let added = 0
    let skipped = 0
    const errors = []

    for (const att of attachables) {
      const qbId = String(att.Id)
      if (existingStmt.get(achat.id, qbId)) { skipped++; continue }

      // Note-only attachable (sans fichier)
      if (!att.FileName && att.Note) {
        insertStmt.run(randomUUID(), achat.id, qbId, null, null, null, '', att.Note)
        added++
        continue
      }
      if (!att.FileName) { skipped++; continue }

      try {
        const url = await qbAttachmentDownloadUrl(qbId)
        const fileResp = await fetch(url)
        if (!fileResp.ok) throw new Error(`download ${fileResp.status}`)
        const buf = Buffer.from(await fileResp.arrayBuffer())

        const safeName = sanitizeFileName(att.FileName)
        const finalName = `${qbId}_${safeName}`
        const absPath = path.join(achatDir, finalName)
        fs.writeFileSync(absPath, buf)

        const relPath = path.posix.join('qb-attachments', achat.id, finalName)
        insertStmt.run(
          randomUUID(), achat.id, qbId,
          att.FileName, att.ContentType || null, buf.length,
          relPath, att.Note || null
        )
        added++
      } catch (e) {
        errors.push({ qb_id: qbId, file_name: att.FileName, error: e.message })
      }
    }

    res.json({ added, skipped, total: attachables.length, errors })
  } catch (e) {
    console.error('fetch-qb-attachments:', e)
    res.status(500).json({ error: e.message })
  }
})

router.get('/:id/attachments/:attId/download', (req, res) => {
  const row = db.prepare(`
    SELECT file_name, content_type, file_path FROM qb_attachments
    WHERE id = ? AND achat_id = ?
  `).get(req.params.attId, req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  if (!row.file_path) return res.status(400).json({ error: 'Note sans fichier' })

  const absPath = path.resolve(UPLOADS_ROOT, row.file_path)
  if (!absPath.startsWith(UPLOADS_ROOT)) return res.status(400).json({ error: 'Invalid path' })
  if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'Fichier introuvable' })

  if (row.content_type) res.type(row.content_type)
  res.download(absPath, row.file_name || 'file')
})

router.delete('/:id/attachments/:attId', (req, res) => {
  const row = db.prepare('SELECT file_path FROM qb_attachments WHERE id = ? AND achat_id = ?')
    .get(req.params.attId, req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })

  if (row.file_path) {
    const absPath = path.resolve(UPLOADS_ROOT, row.file_path)
    if (absPath.startsWith(UPLOADS_ROOT) && fs.existsSync(absPath)) {
      try { fs.unlinkSync(absPath) } catch {}
    }
  }
  db.prepare('DELETE FROM qb_attachments WHERE id = ?').run(req.params.attId)
  res.json({ ok: true })
})

export default router
