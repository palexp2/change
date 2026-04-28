import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { getCentralControllers } from '../utils/centralController.js';
import { buildPartialUpdate } from '../utils/partialUpdate.js';

const router = Router();
router.use(requireAuth);

// GET /api/tickets/meta — distinct types & statuses
router.get('/meta', (req, res) => {
  const types = db.prepare("SELECT DISTINCT type FROM tickets WHERE type IS NOT NULL AND type != '' ORDER BY type").all().map(r => r.type);
  const statuses = db.prepare("SELECT DISTINCT status FROM tickets WHERE status IS NOT NULL AND status != '' ORDER BY status").all().map(r => r.status);
  res.json({ types, statuses });
});

// GET /api/tickets
router.get('/', (req, res) => {
  const { search, status, type, company_id, assigned_to, page = 1, limit = 50 } = req.query;
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit);
  let where = 'WHERE 1=1';
  const params = [];

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
     WHERE t.id = ?`
  ).get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  ticket.central_controllers = getCentralControllers(ticket.company_id);
  res.json(ticket);
});

// POST /api/tickets
router.post('/', (req, res) => {
  const { company_id, contact_id, assigned_to, title, description, response, type, status, duration_minutes } = req.body;
  const id = uuidv4();
  db.prepare(
    `INSERT INTO tickets (id, company_id, contact_id, assigned_to, title, description, response, type, status, duration_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, company_id || null, contact_id || null, assigned_to || null,
    title, description || null, response || null, type || null, status || 'Waiting on us', duration_minutes || 0);

  const created = db.prepare(
    `SELECT t.*, c.name as company_name, u.name as assigned_name FROM tickets t LEFT JOIN companies c ON t.company_id = c.id LEFT JOIN users u ON t.assigned_to = u.id WHERE t.id = ?`
  ).get(id);
  created.central_controllers = getCentralControllers(created.company_id);
  res.status(201).json(created);
});

// PUT /api/tickets/:id — partial update
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM tickets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Ticket not found' });

  const { setClause, values, error } = buildPartialUpdate(req.body, {
    allowed: ['company_id', 'contact_id', 'assigned_to', 'title', 'description',
      'response', 'type', 'status', 'duration_minutes'],
  });
  if (error) return res.status(400).json({ error });
  if (setClause) {
    db.prepare(`UPDATE tickets SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id);
  }

  const updated = db.prepare(
    `SELECT t.*, c.name as company_name, u.name as assigned_name FROM tickets t LEFT JOIN companies c ON t.company_id = c.id LEFT JOIN users u ON t.assigned_to = u.id WHERE t.id = ?`
  ).get(req.params.id);
  updated.central_controllers = getCentralControllers(updated.company_id);
  res.json(updated);
});

// PATCH /api/tickets/:id/status
router.patch('/:id/status', (req, res) => {
  const existing = db.prepare('SELECT id FROM tickets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Ticket not found' });

  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'Status is required' });
  db.prepare(`UPDATE tickets SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(status, req.params.id);
  res.json({ message: 'Status updated' });
});

// DELETE /api/tickets/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM tickets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Ticket not found' });
  db.prepare('DELETE FROM tickets WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

export default router;
