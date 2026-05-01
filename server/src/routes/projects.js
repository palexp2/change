import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { buildPartialUpdate } from '../utils/partialUpdate.js';
import { getActiveCustomColumns } from './custom-fields.js';

const router = Router();
router.use(requireAuth);

// GET /api/projects/vendeur-options — liste fusionnée pour le picker du champ
// Vendeur sur les projets : employés actifs avec is_salesperson=1 + companies
// avec is_vendeur_orisha=1.
router.get('/vendeur-options', (req, res) => {
  const employees = db.prepare(`
    SELECT id, first_name, last_name FROM employees
    WHERE active=1 AND is_salesperson=1
    ORDER BY first_name COLLATE NOCASE, last_name COLLATE NOCASE
  `).all()
  const companies = db.prepare(`
    SELECT id, name FROM companies
    WHERE deleted_at IS NULL AND is_vendeur_orisha=1
    ORDER BY name COLLATE NOCASE
  `).all()
  const data = [
    ...employees.map(e => ({
      ref: `employee:${e.id}`,
      kind: 'employee',
      label: [e.first_name, e.last_name].filter(Boolean).join(' '),
    })),
    ...companies.map(c => ({
      ref: `company:${c.id}`,
      kind: 'company',
      label: c.name,
    })),
  ]
  res.json({ data })
})

// GET /api/projects
router.get('/', (req, res) => {
  const { search, status, company_id, page = 1, limit = 100 } = req.query;
  const limitAll = limit === 'all';
  const limitVal = limitAll ? -1 : parseInt(limit);
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit);
  let where = 'WHERE p.deleted_at IS NULL';
  const params = [];

  if (search) {
    where += ' AND (p.name LIKE ? OR c.name LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q);
  }
  if (status) {
    where += ' AND p.status = ?';
    params.push(status);
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
    `SELECT p.*, c.name as company_name, ct.first_name || ' ' || ct.last_name as contact_name,
            CASE
              WHEN p.vendeur_ref LIKE 'employee:%' THEN (
                SELECT TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,''))
                FROM employees e WHERE e.id = substr(p.vendeur_ref, 10)
              )
              WHEN p.vendeur_ref LIKE 'company:%' THEN (
                SELECT vc.name FROM companies vc WHERE vc.id = substr(p.vendeur_ref, 9)
              )
            END AS vendeur_label,
            (SELECT json_group_array(json_object('id', o.id, 'order_number', o.order_number))
               FROM orders o WHERE o.project_id = p.id) as orders_json
     FROM projects p
     LEFT JOIN companies c ON p.company_id = c.id
     LEFT JOIN contacts ct ON p.contact_id = ct.id
     ${where}
     ORDER BY p.updated_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limitVal, offset);

  for (const p of projects) {
    try { p.orders = p.orders_json ? JSON.parse(p.orders_json).filter(o => o.id) : []; }
    catch { p.orders = []; }
    delete p.orders_json;
  }

  res.json({ data: projects, total, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/projects/:id
router.get('/:id', (req, res) => {
  const project = db.prepare(
    `SELECT p.*, c.name as company_name, ct.first_name || ' ' || ct.last_name as contact_name,
            CASE
              WHEN p.vendeur_ref LIKE 'employee:%' THEN (
                SELECT TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,''))
                FROM employees e WHERE e.id = substr(p.vendeur_ref, 10)
              )
              WHEN p.vendeur_ref LIKE 'company:%' THEN (
                SELECT vc.name FROM companies vc WHERE vc.id = substr(p.vendeur_ref, 9)
              )
            END AS vendeur_label
     FROM projects p
     LEFT JOIN companies c ON p.company_id = c.id
     LEFT JOIN contacts ct ON p.contact_id = ct.id
     WHERE p.id = ?`
  ).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  project.orders = db.prepare(
    `SELECT id, order_number, status FROM orders WHERE project_id = ? ORDER BY order_number`
  ).all(req.params.id);
  res.json(project);
});

// POST /api/projects
router.post('/', (req, res) => {
  const { name, company_id, contact_id, type, status, probability, value_cad, monthly_cad, nb_greenhouses, close_date, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const id = uuidv4();
  db.prepare(
    `INSERT INTO projects (id, name, company_id, contact_id, type, status, probability, value_cad, monthly_cad, nb_greenhouses, close_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, company_id || null, contact_id || null,
    type || null, status || 'Ouvert', probability || 0, value_cad || 0, monthly_cad || 0,
    nb_greenhouses || 0, close_date || null, notes || null);

  const project = db.prepare(
    `SELECT p.*, c.name as company_name FROM projects p LEFT JOIN companies c ON p.company_id = c.id WHERE p.id = ?`
  ).get(id);
  res.status(201).json(project);
});

// PUT /api/projects/:id — partial update
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  const customCols = getActiveCustomColumns('projects').map(c => c.column_name)
  const { setClause, values, error } = buildPartialUpdate(req.body, {
    allowed: ['name', 'company_id', 'contact_id', 'type', 'status', 'probability',
      'value_cad', 'monthly_cad', 'nb_greenhouses', 'close_date', 'refusal_reason', 'notes',
      'vendeur_ref', ...customCols],
    nonNullable: new Set(['name']),
  });
  if (error) return res.status(400).json({ error });
  if (setClause) {
    db.prepare(`UPDATE projects SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id);
  }

  res.json(db.prepare('SELECT p.*, c.name as company_name FROM projects p LEFT JOIN companies c ON p.company_id = c.id WHERE p.id = ?').get(req.params.id));
});

// PATCH /api/projects/:id/status
router.patch('/:id/status', (req, res) => {
  const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  const { status, refusal_reason } = req.body;
  if (!['Ouvert', 'Gagné', 'Perdu'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  db.prepare(`UPDATE projects SET status=?, refusal_reason=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(status, refusal_reason || null, req.params.id);
  res.json({ message: 'Status updated' });
});

// DELETE /api/projects/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });
  db.prepare("UPDATE projects SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(req.params.id);
  res.json({ message: 'Deleted' });
});

export default router;
