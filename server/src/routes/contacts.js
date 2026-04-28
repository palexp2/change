import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { rematchCalls } from './calls.js';
import { buildPartialUpdate } from '../utils/partialUpdate.js';

const router = Router();
router.use(requireAuth);

// GET /api/contacts/lookup — minimal list for dropdowns
router.get('/lookup', (req, res) => {
  const rows = db.prepare(
    `SELECT id, first_name, last_name, company_id
     FROM contacts
     WHERE deleted_at IS NULL
     ORDER BY first_name COLLATE NOCASE, last_name COLLATE NOCASE`
  ).all()
  res.json(rows)
})

// GET /api/contacts
router.get('/', (req, res) => {
  const { search, company_id, page = 1, limit = 50 } = req.query;
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit);
  let where = 'WHERE ct.deleted_at IS NULL';
  const params = [];

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
  res.json({ data: contacts, total, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/contacts/:id
router.get('/:id', (req, res) => {
  const contact = db.prepare(
    `SELECT ct.*, c.name as company_name
     FROM contacts ct
     LEFT JOIN companies c ON ct.company_id = c.id
     WHERE ct.id = ?`
  ).get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  res.json(contact);
});

// POST /api/contacts
router.post('/', (req, res) => {
  const { first_name, last_name, email, phone, mobile, company_id, language, notes } = req.body;
  if (!first_name || !last_name) return res.status(400).json({ error: 'First name and last name required' });

  // Validate company belongs to tenant
  if (company_id) {
    const co = db.prepare('SELECT id FROM companies WHERE id = ?').get(company_id);
    if (!co) return res.status(400).json({ error: 'Invalid company' });
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO contacts (id, first_name, last_name, email, phone, mobile, company_id, language, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, first_name, last_name, email || null, phone || null,
    mobile || null, company_id || null, language || null, notes || null);

  const contact = db.prepare('SELECT ct.*, c.name as company_name FROM contacts ct LEFT JOIN companies c ON ct.company_id = c.id WHERE ct.id = ?').get(id);
  if (phone || mobile) rematchCalls();
  res.status(201).json(contact);
});

// PUT /api/contacts/:id — partial update
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM contacts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Contact not found' });

  const { setClause, values, cols, error } = buildPartialUpdate(req.body, {
    allowed: ['first_name', 'last_name', 'email', 'phone', 'mobile', 'company_id', 'language', 'notes'],
    nonNullable: new Set(['first_name', 'last_name']),
  });
  if (error) return res.status(400).json({ error });
  if (setClause) {
    db.prepare(`UPDATE contacts SET ${setClause} WHERE id = ?`).run(...values, req.params.id);
  }

  const updated = db.prepare('SELECT ct.*, c.name as company_name FROM contacts ct LEFT JOIN companies c ON ct.company_id = c.id WHERE ct.id = ?').get(req.params.id);
  if (cols.includes('phone') || cols.includes('mobile')) rematchCalls();
  res.json(updated);
});

// DELETE /api/contacts/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM contacts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Contact not found' });
  db.prepare("UPDATE contacts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(req.params.id);
  res.json({ message: 'Deleted' });
});

export default router;
