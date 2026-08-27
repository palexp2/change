import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { rematchCalls } from './calls.js';
import { buildPartialUpdate } from '../utils/partialUpdate.js';
import { emitEntity, emitCompanyContactsChanged } from '../services/realtimeEmitters.js';
import { CC_PERMISSION_SELECT, CC_PERMISSIONS_JOIN } from '../utils/ccPermissions.js';
import { findContactDuplicates } from '../utils/duplicateMatch.js';

const router = Router();
router.use(requireAuth);

function buildContactRow(id) {
  return db.prepare(
    `SELECT ct.*, c.name as company_name
     FROM contacts ct
     LEFT JOIN companies c ON ct.company_id = c.id
     WHERE ct.id = ?`
  ).get(id)
}

// GET /api/contacts/lookup — minimal list for dropdowns
//
// `company_ids` liste TOUTES les entreprises du contact (liens
// `contact_companies` + l'entreprise principale legacy `contacts.company_id`).
// Un contact lié à plusieurs entreprises est courant : filtrer un picker sur
// `company_id` seul le rendait invisible depuis les autres entreprises.
router.get('/lookup', (req, res) => {
  const rows = db.prepare(
    `SELECT ct.id, ct.first_name, ct.last_name, ct.company_id,
            (SELECT group_concat(cc.company_id, ',')
             FROM contact_companies cc WHERE cc.contact_id = ct.id) AS linked_company_ids
     FROM contacts ct
     WHERE ct.deleted_at IS NULL
     ORDER BY ct.first_name COLLATE NOCASE, ct.last_name COLLATE NOCASE`
  ).all()
  res.json(rows.map(({ linked_company_ids, ...r }) => ({
    ...r,
    company_ids: [...new Set([r.company_id, ...(linked_company_ids || '').split(',')].filter(Boolean))],
  })))
})

function loadCompanies(contactId) {
  return db.prepare(
    `SELECT cc.id as link_id, cc.company_id, c.name as company_name,
            cc.role, cc.is_primary, cc.created_at
     FROM contact_companies cc
     LEFT JOIN companies c ON c.id = cc.company_id
     WHERE cc.contact_id = ?
     ORDER BY cc.is_primary DESC, c.name COLLATE NOCASE`
  ).all(contactId)
}

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
    // Filtre via la jointure pour inclure les contacts liés (pas seulement
    // ceux dont c'est l'entreprise principale).
    where += ' AND EXISTS (SELECT 1 FROM contact_companies cc WHERE cc.contact_id = ct.id AND cc.company_id = ?)';
    params.push(company_id);
  }

  const contacts = db.prepare(
    `SELECT ct.*, c.name as company_name,
            (SELECT group_concat(cc2.company_id, ',')
             FROM contact_companies cc2 WHERE cc2.contact_id = ct.id) AS linked_company_ids,
            ${CC_PERMISSION_SELECT},
            EXISTS (
              SELECT 1 FROM adresses a
              WHERE a.contact_id = ct.id AND a.address_type = 'Livraison'
            ) AS has_shipping_address
     FROM contacts ct
     LEFT JOIN companies c ON ct.company_id = c.id
     ${CC_PERMISSIONS_JOIN} ON ccp.company_id = ct.company_id
     ${where}
     ORDER BY ct.first_name, ct.last_name
     LIMIT ? OFFSET ?`
  ).all(...params, limitVal, offset);

  const total = limitAll ? contacts.length : db.prepare(`SELECT COUNT(*) as c FROM contacts ct ${where}`).get(...params).c;
  // Voir /lookup : `company_ids` = toutes les entreprises du contact.
  const data = contacts.map(({ linked_company_ids, ...ct }) => ({
    ...ct,
    company_ids: [...new Set([ct.company_id, ...(linked_company_ids || '').split(',')].filter(Boolean))],
  }));
  res.json({ data, total, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/contacts/duplicates — correspondances potentielles (nom complet /
// courriel / téléphone) avant de créer un contact. Non bloquant.
// Doit rester AVANT la route GET /:id pour ne pas être capturé par celle-ci.
router.get('/duplicates', (req, res) => {
  const { first_name, last_name, email, phone, mobile, exclude_id } = req.query;
  const matches = findContactDuplicates(db, { first_name, last_name, email, phone, mobile, excludeId: exclude_id });
  res.json({ matches });
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
  contact.companies = loadCompanies(req.params.id);
  res.json(contact);
});

// GET /api/contacts/:id/companies
router.get('/:id/companies', (req, res) => {
  const contact = db.prepare('SELECT id FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  res.json(loadCompanies(req.params.id));
});

// POST /api/contacts/:id/companies — lier une entreprise au contact
router.post('/:id/companies', (req, res) => {
  const { company_id, role, is_primary } = req.body;
  const contact = db.prepare('SELECT id, company_id FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (!company_id) return res.status(400).json({ error: 'company_id required' });
  const co = db.prepare('SELECT id FROM companies WHERE id = ?').get(company_id);
  if (!co) return res.status(400).json({ error: 'Invalid company' });

  const existing = db.prepare(
    'SELECT id FROM contact_companies WHERE contact_id = ? AND company_id = ?'
  ).get(req.params.id, company_id);
  if (existing) return res.status(409).json({ error: 'Company already linked to contact' });

  const hasPrimary = db.prepare(
    'SELECT 1 FROM contact_companies WHERE contact_id = ? AND is_primary = 1'
  ).get(req.params.id);
  const makePrimary = is_primary ? 1 : (hasPrimary ? 0 : 1);
  const linkId = uuidv4();
  const txn = db.transaction(() => {
    if (makePrimary) {
      db.prepare('UPDATE contact_companies SET is_primary = 0 WHERE contact_id = ?').run(req.params.id);
    }
    db.prepare(
      `INSERT INTO contact_companies (id, contact_id, company_id, role, is_primary)
       VALUES (?, ?, ?, ?, ?)`
    ).run(linkId, req.params.id, company_id, role || null, makePrimary);
    if (makePrimary) {
      db.prepare('UPDATE contacts SET company_id = ? WHERE id = ?').run(company_id, req.params.id);
    }
  });
  txn();

  const updated = db.prepare(
    `SELECT ct.*, c.name as company_name FROM contacts ct LEFT JOIN companies c ON ct.company_id = c.id WHERE ct.id = ?`
  ).get(req.params.id);
  updated.companies = loadCompanies(req.params.id);
  emitEntity('contact', 'updated', req.params.id, updated, req.user?.id);
  emitCompanyContactsChanged(company_id, req.user?.id);
  res.status(201).json(updated);
});

// PATCH /api/contacts/:id/companies/:linkId — modifier (rôle, principale)
router.patch('/:id/companies/:linkId', (req, res) => {
  const link = db.prepare(
    'SELECT * FROM contact_companies WHERE id = ? AND contact_id = ?'
  ).get(req.params.linkId, req.params.id);
  if (!link) return res.status(404).json({ error: 'Link not found' });

  const { role, is_primary } = req.body;
  // Sauve l'ancienne principale pour notifier les deux entreprises affectées.
  const prevPrimary = db.prepare(
    'SELECT company_id FROM contact_companies WHERE contact_id = ? AND is_primary = 1'
  ).get(req.params.id);
  const txn = db.transaction(() => {
    if (role !== undefined) {
      db.prepare('UPDATE contact_companies SET role = ? WHERE id = ?').run(role || null, link.id);
    }
    if (is_primary === true || is_primary === 1) {
      db.prepare('UPDATE contact_companies SET is_primary = 0 WHERE contact_id = ?').run(req.params.id);
      db.prepare('UPDATE contact_companies SET is_primary = 1 WHERE id = ?').run(link.id);
      db.prepare('UPDATE contacts SET company_id = ? WHERE id = ?').run(link.company_id, req.params.id);
    }
  });
  txn();

  const updated = db.prepare(
    `SELECT ct.*, c.name as company_name FROM contacts ct LEFT JOIN companies c ON ct.company_id = c.id WHERE ct.id = ?`
  ).get(req.params.id);
  updated.companies = loadCompanies(req.params.id);
  emitEntity('contact', 'updated', req.params.id, updated, req.user?.id);
  // Le badge "Principale/Secondaire" change côté entreprises affectées.
  emitCompanyContactsChanged([link.company_id, prevPrimary?.company_id], req.user?.id);
  res.json(updated);
});

// DELETE /api/contacts/:id/companies/:linkId
router.delete('/:id/companies/:linkId', (req, res) => {
  const link = db.prepare(
    'SELECT * FROM contact_companies WHERE id = ? AND contact_id = ?'
  ).get(req.params.linkId, req.params.id);
  if (!link) return res.status(404).json({ error: 'Link not found' });

  let promotedCompanyId = null;
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM contact_companies WHERE id = ?').run(link.id);
    if (link.is_primary) {
      // Promouvoir une autre entreprise principale s'il en reste.
      const next = db.prepare(
        'SELECT id, company_id FROM contact_companies WHERE contact_id = ? ORDER BY created_at LIMIT 1'
      ).get(req.params.id);
      if (next) {
        db.prepare('UPDATE contact_companies SET is_primary = 1 WHERE id = ?').run(next.id);
        db.prepare('UPDATE contacts SET company_id = ? WHERE id = ?').run(next.company_id, req.params.id);
        promotedCompanyId = next.company_id;
      } else {
        db.prepare('UPDATE contacts SET company_id = NULL WHERE id = ?').run(req.params.id);
      }
    }
  });
  txn();

  const updated = db.prepare(
    `SELECT ct.*, c.name as company_name FROM contacts ct LEFT JOIN companies c ON ct.company_id = c.id WHERE ct.id = ?`
  ).get(req.params.id);
  updated.companies = loadCompanies(req.params.id);
  emitEntity('contact', 'updated', req.params.id, updated, req.user?.id);
  // L'entreprise dont on retire le contact + celle promue (le cas échéant).
  emitCompanyContactsChanged([link.company_id, promotedCompanyId], req.user?.id);
  res.json(updated);
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
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO contacts (id, first_name, last_name, email, phone, mobile, company_id, language, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, first_name, last_name, email || null, phone || null,
      mobile || null, company_id || null, language || null, notes || null);
    if (company_id) {
      db.prepare(
        `INSERT INTO contact_companies (id, contact_id, company_id, is_primary) VALUES (?, ?, ?, 1)`
      ).run(uuidv4(), id, company_id);
    }
  });
  txn();

  const contact = db.prepare('SELECT ct.*, c.name as company_name FROM contacts ct LEFT JOIN companies c ON ct.company_id = c.id WHERE ct.id = ?').get(id);
  contact.companies = loadCompanies(id);
  if (phone || mobile) rematchCalls();
  emitEntity('contact', 'created', id, contact, req.user?.id);
  if (company_id) emitCompanyContactsChanged(company_id, req.user?.id);
  res.status(201).json(contact);
});

// PUT /api/contacts/:id — partial update
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id, company_id FROM contacts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Contact not found' });

  const { setClause, values, cols, error } = buildPartialUpdate(req.body, {
    allowed: ['first_name', 'last_name', 'email', 'phone', 'mobile', 'company_id', 'language', 'notes'],
    nonNullable: new Set(['first_name', 'last_name']),
  });
  if (error) return res.status(400).json({ error });
  const txn = db.transaction(() => {
    if (setClause) {
      db.prepare(`UPDATE contacts SET ${setClause} WHERE id = ?`).run(...values, req.params.id);
    }
    // Quand l'entreprise principale change, refléter dans la jointure :
    // bascule is_primary sur la nouvelle (ou l'insère), démote les autres.
    if (cols.includes('company_id')) {
      const newCid = req.body.company_id || null;
      db.prepare('UPDATE contact_companies SET is_primary = 0 WHERE contact_id = ?').run(req.params.id);
      if (newCid) {
        const exists = db.prepare(
          'SELECT id FROM contact_companies WHERE contact_id = ? AND company_id = ?'
        ).get(req.params.id, newCid);
        if (exists) {
          db.prepare('UPDATE contact_companies SET is_primary = 1 WHERE id = ?').run(exists.id);
        } else {
          db.prepare(
            'INSERT INTO contact_companies (id, contact_id, company_id, is_primary) VALUES (?, ?, ?, 1)'
          ).run(uuidv4(), req.params.id, newCid);
        }
      }
    }
  });
  txn();

  const updated = db.prepare('SELECT ct.*, c.name as company_name FROM contacts ct LEFT JOIN companies c ON ct.company_id = c.id WHERE ct.id = ?').get(req.params.id);
  updated.companies = loadCompanies(req.params.id);
  if (cols.includes('phone') || cols.includes('mobile')) rematchCalls();
  emitEntity('contact', 'updated', req.params.id, updated, req.user?.id);
  // Notifie les entreprises affectées : toutes celles liées au contact (les
  // tabs Contacts doivent refléter rename/email/téléphone), plus l'ancienne
  // entreprise principale si elle a changé (le contact disparaît de sa liste).
  const affected = new Set(updated.companies.map(c => c.company_id));
  if (cols.includes('company_id') && existing.company_id) affected.add(existing.company_id);
  if (affected.size) emitCompanyContactsChanged([...affected], req.user?.id);
  res.json(updated);
});

// DELETE /api/contacts/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM contacts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Contact not found' });
  // Capture les entreprises liées avant suppression pour notifier leurs fiches.
  const affected = db.prepare('SELECT company_id FROM contact_companies WHERE contact_id = ?').all(req.params.id).map(r => r.company_id);
  db.prepare("UPDATE contacts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(req.params.id);
  emitEntity('contact', 'deleted', req.params.id, { id: req.params.id }, req.user?.id);
  if (affected.length) emitCompanyContactsChanged(affected, req.user?.id);
  res.json({ message: 'Deleted' });
});

export default router;
