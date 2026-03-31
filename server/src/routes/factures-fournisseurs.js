import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

router.get('/', (req, res) => {
  const { status, category, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  const tid = req.user.tenant_id

  let where = 'WHERE tenant_id = ?'
  const params = [tid]

  if (status) { where += ' AND status = ?'; params.push(status) }
  if (category) { where += ' AND category = ?'; params.push(category) }

  const total = db.prepare(`SELECT COUNT(*) as c FROM factures_fournisseurs ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT *
    FROM factures_fournisseurs
    ${where}
    ORDER BY date_facture DESC, created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM factures_fournisseurs WHERE id = ? AND tenant_id = ?')
    .get(req.params.id, req.user.tenant_id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const { bill_number, vendor, vendor_invoice_number, date_facture, due_date, category, amount_cad, tax_cad, total_cad, amount_paid_cad, status, notes } = req.body
  if (!vendor || !date_facture) return res.status(400).json({ error: 'vendor et date_facture sont requis' })

  const id = randomUUID()
  const tot = total_cad || ((amount_cad || 0) + (tax_cad || 0))
  db.prepare(`
    INSERT INTO factures_fournisseurs (id, tenant_id, bill_number, vendor, vendor_invoice_number, date_facture, due_date, category, amount_cad, tax_cad, total_cad, amount_paid_cad, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user.tenant_id, bill_number || null, vendor, vendor_invoice_number || null, date_facture,
    due_date || null, category || null, amount_cad || 0, tax_cad || 0, tot, amount_paid_cad || 0, status || 'Reçue', notes || null)

  res.status(201).json(db.prepare('SELECT * FROM factures_fournisseurs WHERE id = ?').get(id))
})

router.put('/:id', (req, res) => {
  const { bill_number, vendor, vendor_invoice_number, date_facture, due_date, category, amount_cad, tax_cad, total_cad, amount_paid_cad, status, notes } = req.body
  const existing = db.prepare('SELECT id FROM factures_fournisseurs WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id)
  if (!existing) return res.status(404).json({ error: 'Not found' })

  const tot = total_cad || ((amount_cad || 0) + (tax_cad || 0))
  db.prepare(`
    UPDATE factures_fournisseurs SET bill_number=?, vendor=?, vendor_invoice_number=?, date_facture=?, due_date=?, category=?, amount_cad=?, tax_cad=?, total_cad=?, amount_paid_cad=?, status=?, notes=?, updated_at=datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).run(bill_number || null, vendor, vendor_invoice_number || null, date_facture, due_date || null,
    category || null, amount_cad || 0, tax_cad || 0, tot, amount_paid_cad || 0, status || 'Reçue', notes || null,
    req.params.id, req.user.tenant_id)

  res.json(db.prepare('SELECT * FROM factures_fournisseurs WHERE id = ?').get(req.params.id))
})

router.patch('/:id/status', (req, res) => {
  const { status } = req.body
  const existing = db.prepare('SELECT id FROM factures_fournisseurs WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id)
  if (!existing) return res.status(404).json({ error: 'Not found' })

  db.prepare(`UPDATE factures_fournisseurs SET status=?, updated_at=datetime('now') WHERE id = ? AND tenant_id = ?`)
    .run(status, req.params.id, req.user.tenant_id)
  res.json({ ok: true })
})

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM factures_fournisseurs WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare('DELETE FROM factures_fournisseurs WHERE id = ? AND tenant_id = ?').run(req.params.id, req.user.tenant_id)
  res.json({ ok: true })
})

export default router
