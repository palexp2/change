import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { randomUUID } from 'crypto'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import PDFDocument from 'pdfkit'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = Router()
router.use(requireAuth)

// ── Helpers ───────────────────────────────────────────────────────────────────

function uploadsDir() {
  const base = path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads')
  const dir = path.join(base, 'documents')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function fmtPrice(n, currency = 'CAD') {
  if (n == null) return currency === 'USD' ? '$0.00' : '0,00 $'
  return new Intl.NumberFormat(currency === 'USD' ? 'en-US' : 'fr-CA', { style: 'currency', currency }).format(n)
}
// keep alias for existing call sites
const fmtCad = (n) => fmtPrice(n, 'CAD')

function fmtDate(d, lang = 'French') {
  if (!d) return '—'
  const locale = lang === 'English' ? 'en-CA' : 'fr-CA'
  return new Date(d).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' })
}

// ── PDF generation ────────────────────────────────────────────────────────────

async function generateSoumissionPdf(soumission, items, company, contact, tenant) {
  return new Promise((resolve, reject) => {
    const lang = soumission.language === 'English' ? 'English' : 'French'
    const isFr = lang !== 'English'
    const currency = soumission.currency || 'CAD'
    const fmt = (n) => fmtPrice(n, currency)

    const dir = uploadsDir()
    const filename = `soumission-${soumission.id}.pdf`
    const filepath = path.join(dir, filename)

    const doc = new PDFDocument({ size: 'LETTER', margin: 50 })
    const stream = fs.createWriteStream(filepath)
    doc.pipe(stream)

    // Colors
    const INDIGO = '#4f46e5'
    const SLATE = '#1e293b'
    const GRAY = '#64748b'
    const LIGHT = '#f1f5f9'
    const WHITE = '#ffffff'
    const LINE = '#e2e8f0'

    // ── Header bar ────────────────────────────────────────────────────────────
    doc.rect(50, 50, doc.page.width - 100, 70).fill(INDIGO)

    doc.fillColor(WHITE).fontSize(22).font('Helvetica-Bold')
       .text(isFr ? 'SOUMISSION' : 'QUOTE', 70, 68)

    const docNum = soumission.document_number || soumission.id.slice(0, 8).toUpperCase()
    doc.fontSize(10).font('Helvetica').fillColor('#c7d2fe')
       .text(`#${docNum}`, 70, 94)

    // Date in top-right
    doc.fontSize(9).fillColor(WHITE)
       .text(isFr ? `Date : ${fmtDate(soumission.created_at, lang)}` : `Date: ${fmtDate(soumission.created_at, lang)}`,
             doc.page.width - 250, 68, { width: 200, align: 'right' })

    if (soumission.expiration_date) {
      doc.text(isFr ? `Expiration : ${fmtDate(soumission.expiration_date, lang)}` : `Expires: ${fmtDate(soumission.expiration_date, lang)}`,
               doc.page.width - 250, 84, { width: 200, align: 'right' })
    }

    // Title below header
    let y = 138
    if (soumission.title) {
      doc.fillColor(SLATE).fontSize(14).font('Helvetica-Bold')
         .text(soumission.title, 50, y)
      y += 24
    }

    // ── FROM / TO blocks ──────────────────────────────────────────────────────
    y += 8
    const colW = (doc.page.width - 100) / 2 - 10

    // FROM (Orisha / tenant)
    doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
       .text(isFr ? 'DE' : 'FROM', 50, y)
    doc.fillColor(SLATE).fontSize(10).font('Helvetica-Bold')
       .text(tenant?.name || 'Orisha', 50, y + 12)
    doc.font('Helvetica').fontSize(9).fillColor(GRAY)
       .text('orisha.ag', 50, y + 26)

    // TO (client company)
    if (company) {
      doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
         .text(isFr ? 'À' : 'TO', 50 + colW + 20, y)
      doc.fillColor(SLATE).fontSize(10).font('Helvetica-Bold')
         .text(company.name, 50 + colW + 20, y + 12)
      if (contact) {
        const contactName = [contact.first_name, contact.last_name].filter(Boolean).join(' ')
        doc.font('Helvetica').fontSize(9).fillColor(GRAY)
           .text(contactName, 50 + colW + 20, y + 26)
        if (contact.email) {
          doc.text(contact.email, 50 + colW + 20, y + 38)
        }
      }
      if (company.city || company.province) {
        const addr = [company.city, company.province].filter(Boolean).join(', ')
        doc.font('Helvetica').fontSize(9).fillColor(GRAY)
           .text(addr, 50 + colW + 20, y + 50)
      }
    }

    y += 80

    // ── Divider ───────────────────────────────────────────────────────────────
    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor(LINE).lineWidth(1).stroke()
    y += 16

    // ── Items table ───────────────────────────────────────────────────────────
    const COL = {
      desc: { x: 50, w: 280 },
      qty:  { x: 340, w: 60 },
      unit: { x: 410, w: 90 },
      total:{ x: 465, w: 85 },
    }

    // Table header
    doc.rect(50, y, doc.page.width - 100, 22).fill(LIGHT)
    doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
    doc.text(isFr ? 'DESCRIPTION' : 'DESCRIPTION', COL.desc.x + 4, y + 7)
    doc.text(isFr ? 'QTÉ' : 'QTY', COL.qty.x, y + 7, { width: COL.qty.w, align: 'center' })
    doc.text(isFr ? `PRIX UNIT. (${currency})` : `UNIT PRICE (${currency})`, COL.unit.x, y + 7, { width: COL.unit.w, align: 'right' })
    doc.text(isFr ? 'TOTAL' : 'TOTAL', COL.total.x, y + 7, { width: COL.total.w, align: 'right' })
    y += 22

    // Items
    let subtotal = 0
    for (const item of items) {
      const name = isFr
        ? (item.description_fr || item.name_fr || '')
        : (item.description_en || item.name_en || '')
      const lineTotal = (item.qty || 1) * (item.unit_price_cad || 0)
      subtotal += lineTotal

      const rowH = 28
      doc.rect(50, y, doc.page.width - 100, rowH).fill(WHITE).strokeColor(LINE).lineWidth(0.5).stroke()
      doc.fillColor(SLATE).fontSize(9.5).font('Helvetica')
         .text(name, COL.desc.x + 4, y + 8, { width: COL.desc.w - 8, lineBreak: false })
      doc.text(String(item.qty || 1), COL.qty.x, y + 8, { width: COL.qty.w, align: 'center' })
      doc.text(fmt(item.unit_price_cad || 0), COL.unit.x, y + 8, { width: COL.unit.w, align: 'right' })
      doc.text(fmt(lineTotal), COL.total.x, y + 8, { width: COL.total.w, align: 'right' })
      y += rowH
    }

    if (items.length === 0) {
      doc.fillColor(GRAY).fontSize(9).font('Helvetica')
         .text(isFr ? 'Aucun article' : 'No items', 50, y + 10)
      y += 30
    }

    y += 10

    // ── Totals ────────────────────────────────────────────────────────────────
    const totalW = 200
    const totalX = doc.page.width - 50 - totalW

    doc.moveTo(totalX, y).lineTo(doc.page.width - 50, y).strokeColor(LINE).lineWidth(1).stroke()
    y += 10

    // Subtotal + global discount
    const discPct = soumission.discount_pct || 0
    const discAmt = soumission.discount_amount || 0
    const totalDiscount = Math.min(subtotal, subtotal * discPct / 100 + discAmt)
    const netTotal = Math.max(0, subtotal - totalDiscount)

    doc.fillColor(GRAY).fontSize(9).font('Helvetica')
       .text(isFr ? 'Sous-total' : 'Subtotal', totalX, y, { width: totalW - 80, align: 'left' })
    doc.fillColor(SLATE)
       .text(fmt(subtotal), totalX + totalW - 80, y, { width: 80, align: 'right' })
    y += 18

    if (totalDiscount > 0) {
      const discParts = []
      if (discPct > 0) discParts.push(`-${discPct}%`)
      if (discAmt > 0) discParts.push(`-${fmt(discAmt)}`)
      doc.fillColor('#ef4444').fontSize(9).font('Helvetica')
         .text(isFr ? `Rabais (${discParts.join(' + ')})` : `Discount (${discParts.join(' + ')})`,
               totalX, y, { width: totalW - 80, align: 'left' })
      doc.fillColor('#ef4444')
         .text(`-${fmt(totalDiscount)}`, totalX + totalW - 80, y, { width: 80, align: 'right' })
      y += 18
    }

    doc.fillColor(GRAY).fontSize(8)
       .text(isFr ? '* Taxes non incluses' : '* Taxes not included', totalX, y)
    y += 16

    // Grand total box
    doc.rect(totalX, y, totalW, 28).fill(INDIGO)
    doc.fillColor(WHITE).fontSize(11).font('Helvetica-Bold')
       .text(isFr ? 'TOTAL (avant taxes)' : 'TOTAL (before tax)', totalX + 8, y + 8, { width: totalW - 90 })
    doc.text(fmt(netTotal), totalX + totalW - 88, y + 8, { width: 80, align: 'right' })
    y += 44

    // ── Notes ─────────────────────────────────────────────────────────────────
    if (soumission.notes) {
      y += 8
      doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
         .text(isFr ? 'NOTES' : 'NOTES', 50, y)
      y += 12
      doc.fillColor(SLATE).fontSize(9).font('Helvetica')
         .text(soumission.notes, 50, y, { width: doc.page.width - 100 })
      y += doc.heightOfString(soumission.notes, { width: doc.page.width - 100 }) + 8
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    const footerY = doc.page.height - 60
    doc.moveTo(50, footerY).lineTo(doc.page.width - 50, footerY).strokeColor(LINE).lineWidth(0.5).stroke()
    doc.fillColor(GRAY).fontSize(8).font('Helvetica')
       .text('orisha.ag  |  info@orisha.ag', 50, footerY + 10, { width: doc.page.width - 100, align: 'center' })

    doc.end()

    stream.on('finish', () => resolve(filepath))
    stream.on('error', reject)
  })
}

// ── Soumissions ───────────────────────────────────────────────────────────────

router.get('/soumissions', (req, res) => {
  const { company_id, project_id, status, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  let where = 'WHERE 1=1'
  const params = []
  if (company_id) { where += ' AND s.company_id = ?'; params.push(company_id) }
  if (project_id) { where += ' AND s.project_id = ?'; params.push(project_id) }
  if (status) { where += ' AND s.status = ?'; params.push(status) }

  const total = db.prepare(`SELECT COUNT(*) as c FROM soumissions s ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT s.*,
      p.name as project_name,
      co.name as company_name,
      c.first_name || ' ' || c.last_name as contact_name
    FROM soumissions s
    LEFT JOIN projects p ON s.project_id = p.id
    LEFT JOIN companies co ON s.company_id = co.id
    LEFT JOIN contacts c ON s.contact_id = c.id
    ${where}
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/soumissions/:id', (req, res) => {
  const row = db.prepare(`
    SELECT s.*,
      p.name as project_name,
      co.name as company_name, co.city as company_city, co.province as company_province,
      c.first_name || ' ' || c.last_name as contact_name,
      c.email as contact_email
    FROM soumissions s
    LEFT JOIN projects p ON s.project_id = p.id
    LEFT JOIN companies co ON s.company_id = co.id
    LEFT JOIN contacts c ON s.contact_id = c.id
    WHERE s.id = ?
  `).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })

  const items = db.prepare(`
    SELECT di.*, p.name_fr, p.name_en
    FROM document_items di
    LEFT JOIN products p ON di.catalog_product_id = p.id
    WHERE di.document_id = ? AND di.document_type = 'soumission'
    ORDER BY di.sort_order
  `).all(req.params.id)

  res.json({ ...row, items })
})

const ITEMS_QUERY = `
  SELECT di.*, p.name_fr, p.name_en
  FROM document_items di
  LEFT JOIN products p ON di.catalog_product_id = p.id
  WHERE di.document_id = ? AND di.document_type = 'soumission'
  ORDER BY di.sort_order
`
const INSERT_ITEM = `
  INSERT INTO document_items
    (id, document_type, document_id, catalog_product_id, qty, unit_price_cad, discount_pct, discount_amount, description_fr, description_en, sort_order)
  VALUES (?, 'soumission', ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

router.post('/soumissions', async (req, res) => {
  const {
    company_id, contact_id, project_id, language = 'French', currency = 'CAD',
    notes, discount_pct = 0, discount_amount = 0, items = []
  } = req.body

  // Auto-number: next quote_number for this tenant
  const { next_num } = db.prepare(
    `SELECT COALESCE(MAX(quote_number), 0) + 1 AS next_num FROM soumissions`
  ).get()
  const autoTitle = `QTE-Z-${next_num}`
  const autoExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const id = randomUUID()
  db.prepare(`
    INSERT INTO soumissions
      (id, company_id, contact_id, project_id, language, currency, status, title, notes,
       expiration_date, quote_number, discount_pct, discount_amount)
    VALUES (?, ?, ?, ?, ?, ?, 'Brouillon', ?, ?, ?, ?, ?, ?)
  `).run(id, company_id || null, contact_id || null, project_id || null,
         language, currency, autoTitle, notes || null, autoExpiry, next_num,
         discount_pct, discount_amount)

  const insertItem = db.prepare(INSERT_ITEM)
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    insertItem.run(randomUUID(), id, it.catalog_product_id || null,
                   it.qty || 1, it.unit_price_cad ?? 0, it.discount_pct ?? 0, it.discount_amount ?? 0,
                   it.description_fr || null, it.description_en || null, i)
  }

  try {
    const soumission = db.prepare('SELECT * FROM soumissions WHERE id = ?').get(id)
    const allItems = db.prepare(ITEMS_QUERY).all(id)
    const company = company_id ? db.prepare('SELECT * FROM companies WHERE id = ?').get(company_id) : null
    const contact = contact_id ? db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact_id) : null
    const tenant = db.prepare('SELECT * FROM tenants LIMIT 1').get()
    const pdfPath = await generateSoumissionPdf(soumission, allItems, company, contact, tenant)
    const relPath = path.relative(path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads'), pdfPath)
    db.prepare('UPDATE soumissions SET generated_pdf_path = ? WHERE id = ?').run(relPath, id)
  } catch (e) {
    console.error('PDF generation error:', e)
  }

  res.json(db.prepare(`
    SELECT s.*, co.name as company_name FROM soumissions s
    LEFT JOIN companies co ON s.company_id = co.id WHERE s.id = ?
  `).get(id))
})

router.put('/soumissions/:id', async (req, res) => {
  const existing = db.prepare('SELECT id FROM soumissions WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })

  const { language, currency, status, notes, discount_pct, discount_amount, discount_valid_until, items } = req.body

  db.prepare(`
    UPDATE soumissions SET
      language = COALESCE(?, language),
      currency = COALESCE(?, currency),
      status = COALESCE(?, status),
      notes = ?,
      discount_pct = COALESCE(?, discount_pct),
      discount_amount = COALESCE(?, discount_amount),
      discount_valid_until = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(language ?? null, currency ?? null, status ?? null, notes ?? null,
         discount_pct ?? null, discount_amount ?? null, discount_valid_until ?? null, req.params.id)

  if (Array.isArray(items)) {
    db.prepare("DELETE FROM document_items WHERE document_id = ? AND document_type = 'soumission'").run(req.params.id)
    const insertItem = db.prepare(INSERT_ITEM)
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      insertItem.run(randomUUID(), req.params.id, it.catalog_product_id || null,
                     it.qty || 1, it.unit_price_cad ?? 0, it.discount_pct ?? 0, it.discount_amount ?? 0,
                     it.description_fr || null, it.description_en || null, i)
    }
  }

  try {
    const soumission = db.prepare('SELECT * FROM soumissions WHERE id = ?').get(req.params.id)
    const allItems = db.prepare(ITEMS_QUERY).all(req.params.id)
    const company = soumission.company_id ? db.prepare('SELECT * FROM companies WHERE id = ?').get(soumission.company_id) : null
    const contact = soumission.contact_id ? db.prepare('SELECT * FROM contacts WHERE id = ?').get(soumission.contact_id) : null
    const tenant = db.prepare('SELECT * FROM tenants LIMIT 1').get()
    const pdfPath = await generateSoumissionPdf(soumission, allItems, company, contact, tenant)
    const relPath = path.relative(path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads'), pdfPath)
    db.prepare('UPDATE soumissions SET generated_pdf_path = ? WHERE id = ?').run(relPath, req.params.id)
  } catch (e) {
    console.error('PDF regeneration error:', e)
  }

  res.json(db.prepare('SELECT * FROM soumissions WHERE id = ?').get(req.params.id))
})

router.delete('/soumissions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM soumissions WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  if (row.airtable_id) return res.status(400).json({ error: 'Cannot delete Airtable-synced soumission' })
  db.prepare("DELETE FROM document_items WHERE document_id = ? AND document_type = 'soumission'").run(req.params.id)
  db.prepare('DELETE FROM soumissions WHERE id = ?').run(req.params.id)
  // Clean up PDF
  if (row.generated_pdf_path) {
    try {
      const uploadsBase = path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads')
      const fromUploads = path.join(uploadsBase, row.generated_pdf_path)
      const fromCwd     = path.resolve(process.cwd(), row.generated_pdf_path)
      fs.unlinkSync(fs.existsSync(fromUploads) ? fromUploads : fromCwd)
    } catch {}
  }
  res.json({ ok: true })
})

// ── PDF download ──────────────────────────────────────────────────────────────

router.get('/soumissions/:id/pdf', async (req, res) => {
  const soumission = db.prepare('SELECT * FROM soumissions WHERE id = ?').get(req.params.id)
  if (!soumission) return res.status(404).json({ error: 'Not found' })

  let pdfPath
  if (soumission.generated_pdf_path) {
    // Essaie uploads-relative (nouvelles soumissions), puis cwd-relative (legacy)
    const uploadsBase = path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads')
    const fromUploads = path.join(uploadsBase, soumission.generated_pdf_path)
    const fromCwd     = path.resolve(process.cwd(), soumission.generated_pdf_path)
    pdfPath = fs.existsSync(fromUploads) ? fromUploads : fromCwd
  }

  // Regenerate if missing
  if (!pdfPath || !fs.existsSync(pdfPath)) {
    const allItems = db.prepare(ITEMS_QUERY).all(req.params.id)
    const company = soumission.company_id ? db.prepare('SELECT * FROM companies WHERE id = ?').get(soumission.company_id) : null
    const contact = soumission.contact_id ? db.prepare('SELECT * FROM contacts WHERE id = ?').get(soumission.contact_id) : null
    const tenant = db.prepare('SELECT * FROM tenants LIMIT 1').get()
    try {
      pdfPath = await generateSoumissionPdf(soumission, allItems, company, contact, tenant)
      const relPath = path.relative(path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads'), pdfPath)
      db.prepare("UPDATE soumissions SET generated_pdf_path = ? WHERE id = ?").run(relPath, req.params.id)
    } catch (e) {
      return res.status(500).json({ error: 'PDF generation failed' })
    }
  }

  const docNum = soumission.document_number || soumission.id.slice(0, 8).toUpperCase()
  const lang = soumission.language === 'English' ? 'English' : 'French'
  const filename = lang === 'English' ? `Quote-${docNum}.pdf` : `Soumission-${docNum}.pdf`

  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  fs.createReadStream(pdfPath).pipe(res)
})

// ── Duplicate ─────────────────────────────────────────────────────────────────

router.post('/soumissions/:id/duplicate', async (req, res) => {
  const src = db.prepare('SELECT * FROM soumissions WHERE id = ?').get(req.params.id)
  if (!src) return res.status(404).json({ error: 'Not found' })

  const newId = randomUUID()
  // Auto-number for the copy
  const { next_num: copyNum } = db.prepare(
    `SELECT COALESCE(MAX(quote_number), 0) + 1 AS next_num FROM soumissions`
  ).get()
  const copyExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  db.prepare(`
    INSERT INTO soumissions
      (id, project_id, company_id, contact_id, language, currency, status, title, notes,
       expiration_date, quote_number, discount_pct, discount_amount)
    VALUES (?, ?, ?, ?, ?, ?, 'Brouillon', ?, ?, ?, ?, ?, ?)
  `).run(newId, src.project_id, src.company_id, src.contact_id,
         src.language, src.currency || 'CAD',
         `Copie de ${src.title || 'soumission'}`, src.notes,
         copyExpiry, copyNum, src.discount_pct || 0, src.discount_amount || 0)

  // Copy items
  const srcItems = db.prepare(`
    SELECT * FROM document_items WHERE document_id = ? AND document_type = 'soumission' ORDER BY sort_order
  `).all(req.params.id)
  const insertItem = db.prepare(`
    INSERT INTO document_items (id, document_type, document_id, catalog_product_id, qty, unit_price_cad, discount_pct, discount_amount, description_fr, description_en, sort_order)
    VALUES (?, 'soumission', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const it of srcItems) {
    insertItem.run(randomUUID(), newId, it.catalog_product_id, it.qty, it.unit_price_cad, it.discount_pct ?? 0, it.discount_amount ?? 0, it.description_fr, it.description_en, it.sort_order)
  }

  // Generate PDF
  try {
    const soumission = db.prepare('SELECT * FROM soumissions WHERE id = ?').get(newId)
    const allItems = db.prepare(ITEMS_QUERY).all(newId)
    const company = src.company_id ? db.prepare('SELECT * FROM companies WHERE id = ?').get(src.company_id) : null
    const contact = src.contact_id ? db.prepare('SELECT * FROM contacts WHERE id = ?').get(src.contact_id) : null
    const tenant = db.prepare('SELECT * FROM tenants LIMIT 1').get()
    const pdfPath = await generateSoumissionPdf(soumission, allItems, company, contact, tenant)
    const relPath = path.relative(path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads'), pdfPath)
    db.prepare('UPDATE soumissions SET generated_pdf_path = ? WHERE id = ?').run(relPath, newId)
  } catch (e) {
    console.error('PDF generation error (duplicate):', e)
  }

  res.json(db.prepare('SELECT * FROM soumissions WHERE id = ?').get(newId))
})

export default router
