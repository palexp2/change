import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

router.get('/', requireAuth, (req, res) => {
  const { q = '' } = req.query
  const term = q.trim()
  if (!term || term.length < 2) return res.json({ results: [] })

  const tid = req.user.tenant_id
  const like = `%${term}%`
  const results = []

  // Companies
  const companies = db.prepare(`
    SELECT id, name, phone, website FROM companies
    WHERE tenant_id = ? AND (name LIKE ? OR phone LIKE ? OR website LIKE ?)
    LIMIT 8
  `).all(tid, like, like, like)
  companies.forEach(r => results.push({
    type: 'company', id: r.id, label: r.name,
    sub: r.phone || r.website || '',
    url: `/companies/${r.id}`
  }))

  // Contacts
  const contacts = db.prepare(`
    SELECT c.id, c.first_name, c.last_name, c.email, c.phone,
           co.name AS company_name
    FROM contacts c
    LEFT JOIN companies co ON co.id = c.company_id
    WHERE c.tenant_id = ? AND (c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)
    LIMIT 8
  `).all(tid, like, like, like, like)
  contacts.forEach(r => results.push({
    type: 'contact', id: r.id,
    label: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
    sub: r.company_name || r.email || '',
    url: `/contacts/${r.id}`
  }))

  // Projects (pipeline)
  const projects = db.prepare(`
    SELECT id, name, status FROM projects
    WHERE tenant_id = ? AND name LIKE ?
    LIMIT 6
  `).all(tid, like)
  projects.forEach(r => results.push({
    type: 'project', id: r.id, label: r.name,
    sub: r.status || '',
    url: `/pipeline/${r.id}`
  }))

  // Orders
  const orders = db.prepare(`
    SELECT o.id, o.order_number, c.name AS company_name
    FROM orders o
    LEFT JOIN companies c ON c.id = o.company_id
    WHERE o.tenant_id = ? AND (o.order_number LIKE ? OR c.name LIKE ?)
    LIMIT 6
  `).all(tid, like, like)
  orders.forEach(r => results.push({
    type: 'order', id: r.id,
    label: `#${r.order_number}`,
    sub: r.company_name || '',
    url: `/orders/${r.id}`
  }))

  // Products
  const products = db.prepare(`
    SELECT id, name_fr, name_en, sku FROM products
    WHERE tenant_id = ? AND (name_fr LIKE ? OR name_en LIKE ? OR sku LIKE ?)
    LIMIT 6
  `).all(tid, like, like, like)
  products.forEach(r => results.push({
    type: 'product', id: r.id, label: r.name_fr || r.name_en || r.sku,
    sub: r.sku || '',
    url: `/products/${r.id}`
  }))

  // Serial numbers
  const serials = db.prepare(`
    SELECT sn.id, sn.serial, sn.status, pr.name_fr AS product_name
    FROM serial_numbers sn
    LEFT JOIN products pr ON pr.id = sn.product_id
    WHERE sn.tenant_id = ? AND sn.serial LIKE ?
    LIMIT 6
  `).all(tid, like)
  serials.forEach(r => results.push({
    type: 'serial', id: r.id,
    label: r.serial,
    sub: r.product_name || r.status || '',
    url: `/serials/${r.id}`
  }))

  // Tickets
  const tickets = db.prepare(`
    SELECT t.id, t.title, c.name AS company_name
    FROM tickets t
    LEFT JOIN companies c ON c.id = t.company_id
    WHERE t.tenant_id = ? AND t.title LIKE ?
    LIMIT 6
  `).all(tid, like)
  tickets.forEach(r => results.push({
    type: 'ticket', id: r.id, label: r.title,
    sub: r.company_name || '',
    url: `/tickets/${r.id}`
  }))

  res.json({ results })
})

export default router
