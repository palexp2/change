import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/companies
router.get('/', (req, res) => {
  const { search, lifecycle_phase, type, farm_province, page = 1, limit = 50 } = req.query;
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit);
  let where = 'WHERE c.deleted_at IS NULL';
  const params = [];

  if (search) {
    where += ' AND (c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.city LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q, q, q);
  }
  if (lifecycle_phase && lifecycle_phase !== 'Tous') {
    where += ' AND c.lifecycle_phase = ?';
    params.push(lifecycle_phase);
  }
  if (type) {
    where += " AND (c.type = ? OR c.type = 'Client / Fournisseur')";
    params.push(type);
  }
  if (farm_province) {
    where += ` AND c.id IN (
      SELECT ct.company_id FROM adresses a
      JOIN contacts ct ON ct.id = a.contact_id
      WHERE a.address_type = 'Ferme' AND a.province = ? AND ct.company_id IS NOT NULL
    )`;
    params.push(farm_province);
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM companies c ${where}`).get(...params).c;
  const companies = db.prepare(
    `SELECT c.*,
      (SELECT COUNT(*) FROM contacts ct WHERE ct.company_id = c.id) as contacts_count,
      (SELECT COUNT(*) FROM projects p WHERE p.company_id = c.id) as projects_count,
      (SELECT COUNT(*) FROM orders o WHERE o.company_id = c.id) as orders_count
     FROM companies c ${where}
     ORDER BY c.updated_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limitVal, offset);

  res.json({ data: companies, total, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/companies/:id
router.get('/:id', (req, res) => {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
  if (!company) return res.status(404).json({ error: 'Company not found' });

  const contacts = db.prepare('SELECT * FROM contacts WHERE company_id = ? ORDER BY first_name').all(req.params.id);
  const projects = db.prepare(
    'SELECT p.*, u.name as assigned_name FROM projects p LEFT JOIN users u ON p.assigned_to = u.id WHERE p.company_id = ? ORDER BY p.created_at DESC'
  ).all(req.params.id);
  const orders = db.prepare(
    `SELECT o.*,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as items_count,
      u.name as assigned_name
     FROM orders o LEFT JOIN users u ON o.assigned_to = u.id
     WHERE o.company_id = ? ORDER BY o.created_at DESC LIMIT 20`
  ).all(req.params.id);
  const tickets = db.prepare(
    'SELECT t.*, u.name as assigned_name FROM tickets t LEFT JOIN users u ON t.assigned_to = u.id WHERE t.company_id = ? ORDER BY t.created_at DESC LIMIT 20'
  ).all(req.params.id);
  const serials = db.prepare(`
    SELECT sn.*, pr.name_fr as product_name, pr.sku, pr.image_url as product_image
    FROM serial_numbers sn
    LEFT JOIN products pr ON sn.product_id = pr.id
    WHERE sn.company_id = ?
    ORDER BY sn.created_at DESC
  `).all(req.params.id);

  const returnsCount = db.prepare('SELECT COUNT(*) as count FROM returns WHERE company_id = ?').get(req.params.id);
  res.json({ ...company, contacts, projects, orders, tickets, serials, returns_count: returnsCount?.count || 0 });
});

// POST /api/companies
router.post('/', (req, res) => {
  const { name, type, lifecycle_phase, phone, email, website, address, city, province, country, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const id = uuidv4();
  db.prepare(
    `INSERT INTO companies (id, name, type, lifecycle_phase, phone, email, website, address, city, province, country, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, type || null, lifecycle_phase || null, phone || null, email || null,
    website || null, address || null, city || null, province || null, country || 'Canada', notes || null);

  res.status(201).json(db.prepare('SELECT * FROM companies WHERE id = ?').get(id));
});

// PUT /api/companies/:id
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM companies WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Company not found' });

  const { name, type, lifecycle_phase, phone, email, website, address, city, province, country, notes } = req.body;
  db.prepare(
    `UPDATE companies SET name=?, type=?, lifecycle_phase=?, phone=?, email=?, website=?, address=?, city=?, province=?, country=?, notes=?, updated_at=datetime('now')
     WHERE id = ?`
  ).run(name, type || null, lifecycle_phase || null, phone || null, email || null,
    website || null, address || null, city || null, province || null, country || 'Canada', notes || null,
    req.params.id);

  res.json(db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id));
});

// GET /api/companies/:id/returns
router.get('/:id/returns', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*,
           ct.first_name as contact_first_name, ct.last_name as contact_last_name,
           o.order_number,
           (SELECT COUNT(*) FROM return_items ri WHERE ri.return_id = r.id) as items_count
    FROM returns r
    LEFT JOIN contacts ct ON r.contact_id = ct.id
    LEFT JOIN orders o ON r.order_id = o.id
    WHERE r.company_id = ?
    ORDER BY r.created_at DESC
  `).all(req.params.id)
  res.json({ data: rows })
})

// DELETE /api/companies/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM companies WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Company not found' });
  db.prepare("UPDATE companies SET deleted_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ message: 'Deleted' });
});

export default router;
