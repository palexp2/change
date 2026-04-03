import { Router } from 'express'
import { randomUUID } from 'crypto'
import multer from 'multer'
import { join, extname } from 'path'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs'
import { spawnSync } from 'child_process'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { pushSaleReceiptToQB } from '../services/quickbooks.js'

const router = Router()
router.use(requireAuth)

const uploadsDir = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'receipts')
if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true })

const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf']
const IMAGE_EXT   = ['.jpg', '.jpeg', '.png', '.gif', '.webp']

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

// ── OpenAI extraction ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Tu es un assistant spécialisé dans l'extraction de données de reçus et factures de vente.
Extrait toutes les informations disponibles et retourne un JSON valide avec exactement cette structure:
{
  "receipt_date": "YYYY-MM-DD ou null",
  "company": "nom de l'entreprise/magasin ou null",
  "address": "adresse complète ou null",
  "receipt_number": "numéro de reçu/facture ou null",
  "items": [{"description": "...", "quantity": 1, "unit_price": 0.00, "total": 0.00}],
  "subtotal": 0.00,
  "tps": 0.00,
  "tvq": 0.00,
  "other_taxes": 0.00,
  "total": 0.00,
  "payment_method": "méthode de paiement ou null",
  "currency": "CAD",
  "notes": "autres informations pertinentes ou null"
}
Retourne UNIQUEMENT le JSON, sans texte supplémentaire ni balises markdown.
Si une valeur est inconnue, utilise null pour les chaînes et 0 pour les nombres.`

async function extractWithOpenAI(filePath, fileExt) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY non configuré')

  let messages

  if (IMAGE_EXT.includes(fileExt)) {
    const fileBuffer = readFileSync(filePath)
    const base64 = fileBuffer.toString('base64')
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' }
    const mime = mimeMap[fileExt] || 'image/jpeg'

    messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Voici un reçu de vente. Extrait toutes les données disponibles.' },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } },
        ],
      },
    ]
  } else {
    // PDF → extract text with pdftotext
    const result = spawnSync('pdftotext', ['-layout', filePath, '-'], { encoding: 'utf8', timeout: 30000 })
    const pdfText = result.stdout?.trim() || ''
    if (!pdfText) throw new Error('Impossible d\'extraire le texte du PDF')

    messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Voici le contenu textuel d'un reçu de vente:\n\n${pdfText.slice(0, 8000)}` },
    ]
  }

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages, max_tokens: 2000, temperature: 0 }),
  })

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(err.error?.message || `OpenAI HTTP ${resp.status}`)
  }

  const data = await resp.json()
  const content = data.choices?.[0]?.message?.content?.trim() || ''

  // Strip markdown code fences if present
  const cleaned = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  return JSON.parse(cleaned)
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const { page = 1, limit = 100 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  const tid = req.user.tenant_id

  const total = db.prepare('SELECT COUNT(*) as c FROM sale_receipts WHERE tenant_id=?').get(tid).c
  const rows = db.prepare(`
    SELECT * FROM sale_receipts WHERE tenant_id=?
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(tid, limitVal, offset)

  const parsed = rows.map(r => ({ ...r, items: JSON.parse(r.items || '[]') }))
  res.json({ data: parsed, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM sale_receipts WHERE id=? AND tenant_id=?')
    .get(req.params.id, req.user.tenant_id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json({ ...row, items: JSON.parse(row.items || '[]') })
})

router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' })

  const ext = extname(req.file.originalname).toLowerCase()
  const id = randomUUID()
  const tid = req.user.tenant_id

  // Insert with pending status
  db.prepare(`
    INSERT INTO sale_receipts (id, tenant_id, filename, original_name, file_type, status, created_by)
    VALUES (?, ?, ?, ?, ?, 'processing', ?)
  `).run(id, tid, req.file.filename, req.file.originalname, ext, req.user.id)

  // Return immediately, process async
  res.status(201).json({ id, status: 'processing' })

  // Run extraction asynchronously
  const filePath = join(uploadsDir, req.file.filename)
  try {
    const extracted = await extractWithOpenAI(filePath, ext)

    db.prepare(`
      UPDATE sale_receipts SET
        status='done',
        receipt_date=?, company=?, address=?, receipt_number=?,
        subtotal=?, tps=?, tvq=?, other_taxes=?, total=?,
        payment_method=?, currency=?, items=?, raw_data=?,
        updated_at=datetime('now')
      WHERE id=?
    `).run(
      extracted.receipt_date || null,
      extracted.company || null,
      extracted.address || null,
      extracted.receipt_number || null,
      extracted.subtotal || 0,
      extracted.tps || 0,
      extracted.tvq || 0,
      extracted.other_taxes || 0,
      extracted.total || 0,
      extracted.payment_method || null,
      extracted.currency || 'CAD',
      JSON.stringify(extracted.items || []),
      JSON.stringify(extracted),
      id
    )
  } catch (err) {
    console.error('Receipt extraction error:', err.message)
    db.prepare(`UPDATE sale_receipts SET status='error', error_message=?, updated_at=datetime('now') WHERE id=?`)
      .run(err.message, id)
  }
})

router.get('/:id/file', (req, res) => {
  const row = db.prepare('SELECT filename, file_type FROM sale_receipts WHERE id=? AND tenant_id=?')
    .get(req.params.id, req.user.tenant_id)
  if (!row) return res.status(404).json({ error: 'Not found' })

  const filePath = join(uploadsDir, row.filename)
  if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found' })

  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' }
  res.set('Content-Type', mime[row.file_type] || 'application/octet-stream')
  res.sendFile(filePath)
})

router.post('/:id/push-to-qb', async (req, res) => {
  try {
    const { expenseAccountId, paymentAccountId, vendorId, newVendorName } = req.body
    const qbId = await pushSaleReceiptToQB(req.user.tenant_id, req.params.id, { expenseAccountId, paymentAccountId, vendorId, newVendorName })
    res.json({ ok: true, quickbooks_id: qbId })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT filename FROM sale_receipts WHERE id=? AND tenant_id=?')
    .get(req.params.id, req.user.tenant_id)
  if (!row) return res.status(404).json({ error: 'Not found' })

  // Delete file
  const filePath = join(uploadsDir, row.filename)
  try { if (existsSync(filePath)) unlinkSync(filePath) } catch {}

  db.prepare('DELETE FROM sale_receipts WHERE id=? AND tenant_id=?')
    .run(req.params.id, req.user.tenant_id)
  res.json({ ok: true })
})

export default router
