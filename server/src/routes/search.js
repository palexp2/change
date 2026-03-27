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
    WHERE name LIKE ? OR phone LIKE ? OR website LIKE ?
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
    WHERE c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?
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
    WHERE o.order_number LIKE ? OR c.name LIKE ?
    LIMIT 6
  `).all(like, like)
  orders.forEach(r => results.push({
    type: 'order', id: r.id,
    label: r.order_number || `Commande #${r.id}`,
    sub: r.company_name || '',
    url: `/orders/${r.id}`
  }))

  // Products
  const products = db.prepare(`
    SELECT id, name, sku FROM products
    WHERE name LIKE ? OR sku LIKE ?
    LIMIT 6
  `).all(like, like)
  products.forEach(r => results.push({
    type: 'product', id: r.id, label: r.name,
    sub: r.sku || '',
    url: `/products/${r.id}`
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

  // Interactions
  const interactions = db.prepare(`
    SELECT i.id, i.type, i.subject,
           c.first_name, c.last_name
    FROM interactions i
    LEFT JOIN contacts c ON c.id = i.contact_id
    WHERE i.subject LIKE ?
    LIMIT 6
  `).all(like)
  interactions.forEach(r => results.push({
    type: 'interaction', id: r.id,
    label: r.subject || `Interaction #${r.id}`,
    sub: r.first_name ? `${r.first_name} ${r.last_name || ''}`.trim() : '',
    url: `/interactions`
  }))

  res.json({ results })
})

export default router
