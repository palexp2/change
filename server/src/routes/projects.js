import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/projects
router.get('/', (req, res) => {
  const { search, status, assigned_to, company_id, page = 1, limit = 100 } = req.query;
  const limitAll = limit === 'all';
  const limitVal = limitAll ? -1 : parseInt(limit);
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit);
  const tid = req.user.tenant_id;

  let where = 'WHERE p.tenant_id = ? AND p.deleted_at IS NULL';
  const params = [tid];

  if (search) {
    where += ' AND (p.name LIKE ? OR c.name LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q);
  }
  if (status) {
    where += ' AND p.status = ?';
    params.push(status);
  }
  if (assigned_to) {
    where += ' AND p.assigned_to = ?';
    params.push(assigned_to);
  }
  if (company_id) {
    where += ' AND p.company_id = ?';
    params.push(company_id);
  }
  if (req.query.month) {
    where += " AND strftime('%Y-%m', COALESCE(p.close_date, p.updated_at)) = ?";
    params.push(req.query.month);
  }

  const total = db.prepare(
    `SELECT COUNT(*) as c FROM projects p LEFT JOIN companies c ON p.company_id = c.id ${where}`
  ).get(...params).c;

  const projects = db.prepare(
    `SELECT p.*, c.name as company_name, u.name as assigned_name, ct.first_name || ' ' || ct.last_name as contact_name
     FROM projects p
     LEFT JOIN companies c ON p.company_id = c.id
     LEFT JOIN users u ON p.assigned_to = u.id
     LEFT JOIN contacts ct ON p.contact_id = ct.id
     ${where}
     ORDER BY p.updated_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limitVal, offset);

  res.json({ data: projects, total, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/projects/:id
router.get('/:id', (req, res) => {
  const project = db.prepare(
    `SELECT p.*, c.name as company_name, u.name as assigned_name, ct.first_name || ' ' || ct.last_name as contact_name
     FROM projects p
     LEFT JOIN companies c ON p.company_id = c.id
     LEFT JOIN users u ON p.assigned_to = u.id
     LEFT JOIN contacts ct ON p.contact_id = ct.id
     WHERE p.id = ? AND p.tenant_id = ?`
  ).get(req.params.id, req.user.tenant_id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

// POST /api/projects
router.post('/', (req, res) => {
  const { name, company_id, contact_id, assigned_to, type, status, probability, value_cad, monthly_cad, nb_greenhouses, close_date, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const id = uuidv4();
  db.prepare(
    `INSERT INTO projects (id, tenant_id, name, company_id, contact_id, assigned_to, type, status, probability, value_cad, monthly_cad, nb_greenhouses, close_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.user.tenant_id, name, company_id || null, contact_id || null, assigned_to || null,
    type || null, status || 'Ouvert', probability || 0, value_cad || 0, monthly_cad || 0,
    nb_greenhouses || 0, close_date || null, notes || null);

  const project = db.prepare(
    `SELECT p.*, c.name as company_name, u.name as assigned_name FROM projects p LEFT JOIN companies c ON p.company_id = c.id LEFT JOIN users u ON p.assigned_to = u.id WHERE p.id = ?`
  ).get(id);
  res.status(201).json(project);
});

// PUT /api/projects/:id
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM projects WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  const { name, company_id, contact_id, assigned_to, type, status, probability, value_cad, monthly_cad, nb_greenhouses, close_date, refusal_reason, notes } = req.body;
  db.prepare(
    `UPDATE projects SET name=?, company_id=?, contact_id=?, assigned_to=?, type=?, status=?, probability=?, value_cad=?, monthly_cad=?, nb_greenhouses=?, close_date=?, refusal_reason=?, notes=?, updated_at=datetime('now')
     WHERE id = ? AND tenant_id = ?`
  ).run(name, company_id || null, contact_id || null, assigned_to || null, type || null,
    status || 'Ouvert', probability || 0, value_cad || 0, monthly_cad || 0, nb_greenhouses || 0,
    close_date || null, refusal_reason || null, notes || null, req.params.id, req.user.tenant_id);

  res.json(db.prepare('SELECT p.*, c.name as company_name, u.name as assigned_name FROM projects p LEFT JOIN companies c ON p.company_id = c.id LEFT JOIN users u ON p.assigned_to = u.id WHERE p.id = ?').get(req.params.id));
});

// PATCH /api/projects/:id/status
router.patch('/:id/status', (req, res) => {
  const existing = db.prepare('SELECT id FROM projects WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  const { status, refusal_reason } = req.body;
  if (!['Ouvert', 'Gagné', 'Perdu'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  db.prepare(`UPDATE projects SET status=?, refusal_reason=?, updated_at=datetime('now') WHERE id = ? AND tenant_id = ?`)
    .run(status, refusal_reason || null, req.params.id, req.user.tenant_id);
  res.json({ message: 'Status updated' });
});

// DELETE /api/projects/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM projects WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });
  db.prepare("UPDATE projects SET deleted_at = datetime('now') WHERE id = ? AND tenant_id = ?").run(req.params.id, req.user.tenant_id);
  res.json({ message: 'Deleted' });
});

export default router;
