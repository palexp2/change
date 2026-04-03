import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/tasks
router.get('/', (req, res) => {
  const { search, status, priority, company_id, contact_id, assigned_to, page = 1, limit = 50 } = req.query;
  const limitAll = limit === 'all';
  const limitVal = limitAll ? -1 : parseInt(limit);
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit);
  const tid = req.user.tenant_id;

  let where = 'WHERE t.tenant_id = ? AND t.deleted_at IS NULL';
  const params = [tid];

  if (search) {
    where += ' AND (t.title LIKE ? OR t.description LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q);
  }
  if (status) { where += ' AND t.status = ?'; params.push(status); }
  if (priority) { where += ' AND t.priority = ?'; params.push(priority); }
  if (company_id) { where += ' AND t.company_id = ?'; params.push(company_id); }
  if (contact_id) { where += ' AND t.contact_id = ?'; params.push(contact_id); }
  if (assigned_to) { where += ' AND t.assigned_to = ?'; params.push(assigned_to); }

  const total = db.prepare(
    `SELECT COUNT(*) as c FROM tasks t ${where}`
  ).get(...params).c;

  const tasks = db.prepare(
    `SELECT t.*,
       c.name as company_name,
       ct.first_name || ' ' || ct.last_name as contact_name,
       u.name as assigned_name
     FROM tasks t
     LEFT JOIN companies c ON t.company_id = c.id
     LEFT JOIN contacts ct ON t.contact_id = ct.id
     LEFT JOIN users u ON t.assigned_to = u.id
     ${where}
     ORDER BY
       CASE t.priority WHEN 'Urgente' THEN 1 WHEN 'Haute' THEN 2 WHEN 'Normal' THEN 3 ELSE 4 END,
       t.due_date ASC NULLS LAST,
       t.created_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limitVal, offset);

  res.json({ data: tasks, total, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/tasks/:id
router.get('/:id', (req, res) => {
  const task = db.prepare(
    `SELECT t.*,
       c.name as company_name,
       ct.first_name || ' ' || ct.last_name as contact_name,
       u.name as assigned_name
     FROM tasks t
     LEFT JOIN companies c ON t.company_id = c.id
     LEFT JOIN contacts ct ON t.contact_id = ct.id
     LEFT JOIN users u ON t.assigned_to = u.id
     WHERE t.id = ? AND t.tenant_id = ?`
  ).get(req.params.id, req.user.tenant_id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

// POST /api/tasks
router.post('/', (req, res) => {
  const { title, description, status, priority, due_date, company_id, contact_id, assigned_to, notes } = req.body;
  if (!title) return res.status(400).json({ error: 'Le titre est requis' });

  const id = uuidv4();
  db.prepare(
    `INSERT INTO tasks (id, tenant_id, title, description, status, priority, due_date, company_id, contact_id, assigned_to, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, req.user.tenant_id, title,
    description || null,
    status || 'À faire',
    priority || 'Normal',
    due_date || null,
    company_id || null,
    contact_id || null,
    assigned_to || null,
    notes || null
  );

  res.status(201).json(db.prepare(
    `SELECT t.*, c.name as company_name, ct.first_name || ' ' || ct.last_name as contact_name, u.name as assigned_name
     FROM tasks t
     LEFT JOIN companies c ON t.company_id = c.id
     LEFT JOIN contacts ct ON t.contact_id = ct.id
     LEFT JOIN users u ON t.assigned_to = u.id
     WHERE t.id = ?`
  ).get(id));
});

// PUT /api/tasks/:id
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM tasks WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!existing) return res.status(404).json({ error: 'Task not found' });

  const { title, description, status, priority, due_date, company_id, contact_id, assigned_to, notes } = req.body;
  if (!title) return res.status(400).json({ error: 'Le titre est requis' });

  db.prepare(
    `UPDATE tasks SET title=?, description=?, status=?, priority=?, due_date=?, company_id=?, contact_id=?, assigned_to=?, notes=?, updated_at=datetime('now')
     WHERE id = ? AND tenant_id = ?`
  ).run(
    title, description || null, status || 'À faire', priority || 'Normal',
    due_date || null, company_id || null, contact_id || null, assigned_to || null,
    notes || null, req.params.id, req.user.tenant_id
  );

  res.json(db.prepare(
    `SELECT t.*, c.name as company_name, ct.first_name || ' ' || ct.last_name as contact_name, u.name as assigned_name
     FROM tasks t LEFT JOIN companies c ON t.company_id = c.id
     LEFT JOIN contacts ct ON t.contact_id = ct.id
     LEFT JOIN users u ON t.assigned_to = u.id
     WHERE t.id = ?`
  ).get(req.params.id));
});

// PATCH /api/tasks/:id/status
router.patch('/:id/status', (req, res) => {
  const existing = db.prepare('SELECT id FROM tasks WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!existing) return res.status(404).json({ error: 'Task not found' });

  const { status } = req.body;
  const valid = ['À faire', 'En cours', 'Terminé', 'Annulé'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Statut invalide' });

  db.prepare(`UPDATE tasks SET status=?, updated_at=datetime('now') WHERE id = ? AND tenant_id = ?`)
    .run(status, req.params.id, req.user.tenant_id);

  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id));
});

// DELETE /api/tasks/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM tasks WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!existing) return res.status(404).json({ error: 'Task not found' });
  db.prepare("UPDATE tasks SET deleted_at = datetime('now') WHERE id = ? AND tenant_id = ?").run(req.params.id, req.user.tenant_id);
  res.json({ ok: true });
});

export default router;
