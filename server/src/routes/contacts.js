import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { rematchCalls } from './calls.js';

const router = Router();
router.use(requireAuth);

function parseExtra(row) {
  if (!row) return row;
  try { row.extra_fields = JSON.parse(row.extra_fields || '{}'); } catch { row.extra_fields = {}; }
  return row;
}

// GET /api/contacts
router.get('/', (req, res) => {
  const { search, company_id, page = 1, limit = 50 } = req.query;
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit);
  const tid = req.user.tenant_id;

  let where = 'WHERE ct.tenant_id = ?';
  const params = [tid];

  if (search) {
    where += ' AND (ct.first_name LIKE ? OR ct.last_name LIKE ? OR ct.email LIKE ? OR ct.phone LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q, q, q);
  }
  if (company_id) {
    where += ' AND ct.company_id = ?';
    params.push(company_id);
  }

  const contacts = db.prepare(
    `SELECT ct.*, c.name as company_name
     FROM contacts ct
     LEFT JOIN companies c ON ct.company_id = c.id
     ${where}
     ORDER BY ct.first_name, ct.last_name
     LIMIT ? OFFSET ?`
  ).all(...params, limitVal, offset);

  const total = limitAll ? contacts.length : db.prepare(`SELECT COUNT(*) as c FROM contacts ct ${where}`).get(...params).c;
  res.json({ data: contacts.map(parseExtra), total, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/contacts/:id
router.get('/:id', (req, res) => {
  const contact = db.prepare(
    `SELECT ct.*, c.name as company_name
     FROM contacts ct
     LEFT JOIN companies c ON ct.company_id = c.id
     WHERE ct.id = ? AND ct.tenant_id = ?`
  ).get(req.params.id, req.user.tenant_id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  res.json(parseExtra(contact));
});

// POST /api/contacts
router.post('/', (req, res) => {
  const { first_name, last_name, email, phone, mobile, company_id, language, notes, extra_fields } = req.body;
  if (!first_name || !last_name) return res.status(400).json({ error: 'First name and last name required' });

  // Validate company belongs to tenant
  if (company_id) {
    const co = db.prepare('SELECT id FROM companies WHERE id = ? AND tenant_id = ?').get(company_id, req.user.tenant_id);
    if (!co) return res.status(400).json({ error: 'Invalid company' });
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO contacts (id, tenant_id, first_name, last_name, email, phone, mobile, company_id, language, notes, extra_fields)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.user.tenant_id, first_name, last_name, email || null, phone || null,
    mobile || null, company_id || null, language || null, notes || null,
    JSON.stringify(extra_fields || {}));

  const contact = parseExtra(db.prepare('SELECT ct.*, c.name as company_name FROM contacts ct LEFT JOIN companies c ON ct.company_id = c.id WHERE ct.id = ?').get(id));
  if (phone || mobile) rematchCalls(req.user.tenant_id);
  res.status(201).json(contact);
});

// PUT /api/contacts/:id
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM contacts WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!existing) return res.status(404).json({ error: 'Contact not found' });

  const { first_name, last_name, email, phone, mobile, company_id, language, notes, extra_fields } = req.body;
  db.prepare(
    `UPDATE contacts SET first_name=?, last_name=?, email=?, phone=?, mobile=?, company_id=?, language=?, notes=?, extra_fields=?
     WHERE id = ? AND tenant_id = ?`
  ).run(first_name, last_name, email || null, phone || null, mobile || null,
    company_id || null, language || null, notes || null,
    JSON.stringify(extra_fields || {}), req.params.id, req.user.tenant_id);

  const updated = parseExtra(db.prepare('SELECT ct.*, c.name as company_name FROM contacts ct LEFT JOIN companies c ON ct.company_id = c.id WHERE ct.id = ?').get(req.params.id));
  if (phone || mobile) rematchCalls(req.user.tenant_id);
  res.json(updated);
});

// DELETE /api/contacts/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM contacts WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!existing) return res.status(404).json({ error: 'Contact not found' });
  db.prepare('DELETE FROM contacts WHERE id = ? AND tenant_id = ?').run(req.params.id, req.user.tenant_id);
  res.json({ message: 'Deleted' });
});

export default router;
