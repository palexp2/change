import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

function parseExtra(row) {
  if (!row) return row;
  try { row.extra_fields = JSON.parse(row.extra_fields || '{}'); } catch { row.extra_fields = {}; }
  return row;
}

// GET /api/companies
router.get('/', (req, res) => {
  const { search, lifecycle_phase, page = 1, limit = 50 } = req.query;
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit);
  const tid = req.user.tenant_id;

  let where = 'WHERE c.tenant_id = ?';
  const params = [tid];

  if (search) {
    where += ' AND (c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.city LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q, q, q);
  }
  if (lifecycle_phase && lifecycle_phase !== 'Tous') {
    where += ' AND c.lifecycle_phase = ?';
    params.push(lifecycle_phase);
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM companies c ${where}`).get(...params).c;
  const companies = db.prepare(
    `SELECT c.*,
      (SELECT COUNT(*) FROM contacts ct WHERE ct.company_id = c.id) as contacts_count,
      (SELECT COUNT(*) FROM projects p WHERE p.company_id = c.id AND p.tenant_id = ?) as projects_count,
      (SELECT COUNT(*) FROM orders o WHERE o.company_id = c.id AND o.tenant_id = ?) as orders_count
     FROM companies c ${where}
     ORDER BY c.updated_at DESC
     LIMIT ? OFFSET ?`
  ).all(tid, tid, ...params, limitVal, offset);

  res.json({ data: companies.map(parseExtra), total, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/companies/:id
router.get('/:id', (req, res) => {
  const company = db.prepare('SELECT * FROM companies WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!company) return res.status(404).json({ error: 'Company not found' });
  parseExtra(company);

  const contacts = db.prepare('SELECT * FROM contacts WHERE company_id = ? ORDER BY first_name').all(req.params.id);
  const projects = db.prepare(
    'SELECT p.*, u.name as assigned_name FROM projects p LEFT JOIN users u ON p.assigned_to = u.id WHERE p.company_id = ? AND p.tenant_id = ? ORDER BY p.created_at DESC'
  ).all(req.params.id, req.user.tenant_id);
  const orders = db.prepare(
    `SELECT o.*,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as items_count,
      u.name as assigned_name
     FROM orders o LEFT JOIN users u ON o.assigned_to = u.id
     WHERE o.company_id = ? AND o.tenant_id = ? ORDER BY o.created_at DESC LIMIT 20`
  ).all(req.params.id, req.user.tenant_id);
  const tickets = db.prepare(
    'SELECT t.*, u.name as assigned_name FROM tickets t LEFT JOIN users u ON t.assigned_to = u.id WHERE t.company_id = ? AND t.tenant_id = ? ORDER BY t.created_at DESC LIMIT 20'
  ).all(req.params.id, req.user.tenant_id);
  const serials = db.prepare(`
    SELECT sn.*, pr.name_fr as product_name, pr.sku, pr.image_url as product_image
    FROM serial_numbers sn
    LEFT JOIN products pr ON sn.product_id = pr.id
    WHERE sn.company_id = ? AND sn.tenant_id = ?
    ORDER BY sn.created_at DESC
  `).all(req.params.id, req.user.tenant_id);

  res.json({ ...company, contacts, projects, orders, tickets, serials });
});

// POST /api/companies
router.post('/', (req, res) => {
  const { name, type, lifecycle_phase, phone, email, website, address, city, province, country, notes, extra_fields } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const id = uuidv4();
  db.prepare(
    `INSERT INTO companies (id, tenant_id, name, type, lifecycle_phase, phone, email, website, address, city, province, country, notes, extra_fields)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.user.tenant_id, name, type || null, lifecycle_phase || null, phone || null, email || null,
    website || null, address || null, city || null, province || null, country || 'Canada', notes || null,
    JSON.stringify(extra_fields || {}));

  res.status(201).json(parseExtra(db.prepare('SELECT * FROM companies WHERE id = ?').get(id)));
});

// PUT /api/companies/:id
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM companies WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!existing) return res.status(404).json({ error: 'Company not found' });

  const { name, type, lifecycle_phase, phone, email, website, address, city, province, country, notes, extra_fields } = req.body;
  db.prepare(
    `UPDATE companies SET name=?, type=?, lifecycle_phase=?, phone=?, email=?, website=?, address=?, city=?, province=?, country=?, notes=?, extra_fields=?, updated_at=datetime('now')
     WHERE id = ? AND tenant_id = ?`
  ).run(name, type || null, lifecycle_phase || null, phone || null, email || null,
    website || null, address || null, city || null, province || null, country || 'Canada', notes || null,
    JSON.stringify(extra_fields || {}), req.params.id, req.user.tenant_id);

  res.json(parseExtra(db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id)));
});

// DELETE /api/companies/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM companies WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!existing) return res.status(404).json({ error: 'Company not found' });
  db.prepare('DELETE FROM companies WHERE id = ? AND tenant_id = ?').run(req.params.id, req.user.tenant_id);
  res.json({ message: 'Deleted' });
});

export default router;
