import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// GET /api/stripe-invoice-items
// Filtres : facture_id, stripe_invoice_id, product_id, unlinked=1, linked=1,
//   stripe_price_id, search (LIKE description), page, limit (ou 'all').
router.get('/', (req, res) => {
  const {
    facture_id, stripe_invoice_id, product_id, unlinked, linked,
    stripe_price_id, search, page = 1, limit = 50,
  } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  let where = 'WHERE 1=1'
  const params = []

  if (facture_id) { where += ' AND sii.facture_id = ?'; params.push(facture_id) }
  if (stripe_invoice_id) { where += ' AND sii.stripe_invoice_id = ?'; params.push(stripe_invoice_id) }
  if (stripe_price_id) { where += ' AND sii.stripe_price_id = ?'; params.push(stripe_price_id) }
  if (product_id) { where += ' AND sii.product_id = ?'; params.push(product_id) }
  if (unlinked === '1' || unlinked === 'true') where += ' AND sii.product_id IS NULL'
  if (linked === '1' || linked === 'true') where += ' AND sii.product_id IS NOT NULL'
  if (search) {
    where += ' AND (sii.description LIKE ? OR sii.stripe_price_id LIKE ? OR sii.stripe_product_id LIKE ?)'
    const q = `%${search}%`
    params.push(q, q, q)
  }

  const total = db.prepare(`SELECT COUNT(*) AS c FROM stripe_invoice_items sii ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT sii.*,
      f.document_number AS facture_document_number,
      f.invoice_id AS facture_invoice_id,
      p.name_fr AS product_name_fr,
      p.sku AS product_sku
    FROM stripe_invoice_items sii
    LEFT JOIN factures f ON f.id = sii.facture_id
    LEFT JOIN products p ON p.id = sii.product_id
    ${where}
    ORDER BY sii.created_at DESC, sii.id ASC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) })
})

// GET /api/stripe-invoice-items/:id
router.get('/:id', (req, res) => {
  const row = db.prepare(`
    SELECT sii.*,
      f.document_number AS facture_document_number,
      f.invoice_id AS facture_invoice_id,
      p.name_fr AS product_name_fr, p.sku AS product_sku
    FROM stripe_invoice_items sii
    LEFT JOIN factures f ON f.id = sii.facture_id
    LEFT JOIN products p ON p.id = sii.product_id
    WHERE sii.id = ?
  `).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

// PATCH /api/stripe-invoice-items/:id
// Permet de poser le lien manuel product_id (ou de le retirer en passant null).
router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM stripe_invoice_items WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })

  if (Object.prototype.hasOwnProperty.call(req.body, 'product_id')) {
    const productId = req.body.product_id || null
    if (productId) {
      const p = db.prepare('SELECT id FROM products WHERE id = ?').get(productId)
      if (!p) return res.status(400).json({ error: 'Produit introuvable' })
    }
    db.prepare(`
      UPDATE stripe_invoice_items
      SET product_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(productId, req.params.id)
  }

  const row = db.prepare(`
    SELECT sii.*,
      f.document_number AS facture_document_number,
      f.invoice_id AS facture_invoice_id,
      p.name_fr AS product_name_fr, p.sku AS product_sku
    FROM stripe_invoice_items sii
    LEFT JOIN factures f ON f.id = sii.facture_id
    LEFT JOIN products p ON p.id = sii.product_id
    WHERE sii.id = ?
  `).get(req.params.id)
  res.json(row)
})

export default router
