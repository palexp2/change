import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

router.get('/', requireAuth, (req, res) => {
  const { q = '' } = req.query
  const term = q.trim()
  if (!term || term.length < 2) return res.json({ results: [] })

  const like = `%${term}%`
  const results = []

  // Companies
  const companies = db.prepare(`
    SELECT id, name, phone, website FROM companies
    WHERE (name LIKE ? OR phone LIKE ? OR website LIKE ?)
    LIMIT 8
  `).all(like, like, like)
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
    WHERE (c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)
    LIMIT 8
  `).all(like, like, like, like)
  contacts.forEach(r => results.push({
    type: 'contact', id: r.id,
    label: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
    sub: r.company_name || r.email || '',
    url: `/contacts/${r.id}`
  }))

  // Projects (pipeline)
  const projects = db.prepare(`
    SELECT id, name, status FROM projects
    WHERE name LIKE ?
    LIMIT 6
  `).all(like)
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
    WHERE (o.order_number LIKE ? OR c.name LIKE ?)
    LIMIT 6
  `).all(like, like)
  orders.forEach(r => results.push({
    type: 'order', id: r.id,
    label: `#${r.order_number}`,
    sub: r.company_name || '',
    url: `/orders/${r.id}`
  }))

  // Products
  const products = db.prepare(`
    SELECT id, name_fr, name_en, sku FROM products
    WHERE (name_fr LIKE ? OR name_en LIKE ? OR sku LIKE ?)
    LIMIT 6
  `).all(like, like, like)
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
    WHERE sn.serial LIKE ?
    LIMIT 6
  `).all(like)
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
    WHERE t.title LIKE ?
    LIMIT 6
  `).all(like)
  tickets.forEach(r => results.push({
    type: 'ticket', id: r.id, label: r.title,
    sub: r.company_name || '',
    url: `/tickets/${r.id}`
  }))

  // Achats fournisseurs (factures + dépenses dans la même table)
  const achats = db.prepare(`
    SELECT id, type, vendor, vendor_invoice_number, bill_number, reference,
           description, total_cad, date_achat
    FROM achats_fournisseurs
    WHERE (vendor LIKE ? OR vendor_invoice_number LIKE ? OR bill_number LIKE ?
           OR reference LIKE ? OR description LIKE ?)
    ORDER BY date_achat DESC
    LIMIT 8
  `).all(like, like, like, like, like)
  achats.forEach(r => {
    const isBill = r.type === 'bill'
    const num = r.vendor_invoice_number || r.bill_number || r.reference || ''
    const label = isBill
      ? `Facture ${num || '—'}`
      : `Dépense ${num || (r.description ? r.description.slice(0, 40) : '—')}`
    const sub = [
      r.vendor,
      r.date_achat,
      r.total_cad != null ? `${Number(r.total_cad).toFixed(2)} CAD` : null,
    ].filter(Boolean).join(' · ')
    results.push({
      type: isBill ? 'bill' : 'expense',
      id: r.id, label, sub,
      url: `/achats-fournisseurs?id=${r.id}`,
    })
  })

  res.json({ results })
})

export default router
