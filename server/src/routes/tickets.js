import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/tickets
router.get('/', (req, res) => {
  const { search, status, type, company_id, assigned_to, page = 1, limit = 50 } = req.query;
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit);
  const tid = req.user.tenant_id;

  let where = 'WHERE t.tenant_id = ?';
  const params = [tid];

  if (search) {
    where += ' AND (t.title LIKE ? OR c.name LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q);
  }
  if (status) {
    where += ' AND t.status = ?';
    params.push(status);
  }
  if (type) {
    where += ' AND t.type = ?';
    params.push(type);
  }
  if (company_id) {
    where += ' AND t.company_id = ?';
    params.push(company_id);
  }
  if (assigned_to) {
    where += ' AND t.assigned_to = ?';
    params.push(assigned_to);
  }

  const total = db.prepare(
    `SELECT COUNT(*) as c FROM tickets t LEFT JOIN companies c ON t.company_id = c.id ${where}`
  ).get(...params).c;

  const tickets = db.prepare(
    `SELECT t.*, c.name as company_name, u.name as assigned_name,
      ct.first_name || ' ' || ct.last_name as contact_name
     FROM tickets t
     LEFT JOIN companies c ON t.company_id = c.id
     LEFT JOIN users u ON t.assigned_to = u.id
     LEFT JOIN contacts ct ON t.contact_id = ct.id
     ${where}
     ORDER BY t.created_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limitVal, offset);

  res.json({ data: tickets, total, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/tickets/:id
router.get('/:id', (req, res) => {
  const ticket = db.prepare(
    `SELECT t.*, c.name as company_name, u.name as assigned_name,
      ct.first_name || ' ' || ct.last_name as contact_name
     FROM tickets t
     LEFT JOIN companies c ON t.company_id = c.id
     LEFT JOIN users u ON t.assigned_to = u.id
     LEFT JOIN contacts ct ON t.contact_id = ct.id
     WHERE t.id = ? AND t.tenant_id = ?`
  ).get(req.params.id, req.user.tenant_id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json(ticket);
});

// POST /api/tickets
router.post('/', (req, res) => {
  const { company_id, contact_id, assigned_to, title, description, type, status, duration_minutes, notes } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const id = uuidv4();
  db.prepare(
    `INSERT INTO tickets (id, tenant_id, company_id, contact_id, assigned_to, title, description, type, status, duration_minutes, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.user.tenant_id, company_id || null, contact_id || null, assigned_to || null,
    title, description || null, type || null, status || 'Waiting on us', duration_minutes || 0, notes || null);

  res.status(201).json(db.prepare(
    `SELECT t.*, c.name as company_name, u.name as assigned_name FROM tickets t LEFT JOIN companies c ON t.company_id = c.id LEFT JOIN users u ON t.assigned_to = u.id WHERE t.id = ?`
  ).get(id));
});

// PUT /api/tickets/:id
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM tickets WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!existing) return res.status(404).json({ error: 'Ticket not found' });

  const { company_id, contact_id, assigned_to, title, description, type, status, duration_minutes, notes } = req.body;
  db.prepare(
    `UPDATE tickets SET company_id=?, contact_id=?, assigned_to=?, title=?, description=?, type=?, status=?, duration_minutes=?, notes=?, updated_at=datetime('now')
     WHERE id = ? AND tenant_id = ?`
  ).run(company_id || null, contact_id || null, assigned_to || null, title, description || null,
    type || null, status, duration_minutes || 0, notes || null, req.params.id, req.user.tenant_id);

  res.json(db.prepare(
    `SELECT t.*, c.name as company_name, u.name as assigned_name FROM tickets t LEFT JOIN companies c ON t.company_id = c.id LEFT JOIN users u ON t.assigned_to = u.id WHERE t.id = ?`
  ).get(req.params.id));
});

// PATCH /api/tickets/:id/status
router.patch('/:id/status', (req, res) => {
  const existing = db.prepare('SELECT id FROM tickets WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!existing) return res.status(404).json({ error: 'Ticket not found' });

  const { status } = req.body;
  const validStatuses = ['Waiting on us', 'Waiting on them', 'Closed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  db.prepare(`UPDATE tickets SET status=?, updated_at=datetime('now') WHERE id = ? AND tenant_id = ?`)
    .run(status, req.params.id, req.user.tenant_id);
  res.json({ message: 'Status updated' });
});

// DELETE /api/tickets/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM tickets WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!existing) return res.status(404).json({ error: 'Ticket not found' });
  db.prepare('DELETE FROM tickets WHERE id = ? AND tenant_id = ?').run(req.params.id, req.user.tenant_id);
  res.json({ message: 'Deleted' });
});

export default router;
