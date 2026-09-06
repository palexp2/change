import { Router } from 'express';
import { newRecordId } from '../utils/recordId.js';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { getCentralControllers } from '../utils/centralController.js';
import { CC_PERMISSION_SELECT, CC_PERMISSIONS_JOIN } from '../utils/ccPermissions.js';
import { emitCompany } from '../services/realtimeEmitters.js';
import { findCompanyDuplicates } from '../utils/duplicateMatch.js';
import { readRelation } from '../services/customFieldsView.js'
import { parsePage } from '../utils/pagination.js'
import { buildPartialUpdate } from '../utils/partialUpdate.js';

const router = Router();
router.use(requireAuth);

// GET /api/companies/lookup — minimal list for dropdowns (id + name only, no subqueries)
router.get('/lookup', (req, res) => {
  const rows = db.prepare(
    "SELECT id, name FROM companies WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE"
  ).all()
  res.json(rows)
})

// GET /api/companies/duplicates — correspondances potentielles (nom/courriel/
// téléphone) avant de créer une entreprise. Non bloquant : juste un avertissement.
// Doit rester AVANT la route GET /:id pour ne pas être capturé par celle-ci.
router.get('/duplicates', (req, res) => {
  const { name, email, phone, exclude_id } = req.query;
  const matches = findCompanyDuplicates(db, { name, email, phone, excludeId: exclude_id });
  res.json({ matches });
})

// GET /api/companies
router.get('/', (req, res) => {
  const { search, lifecycle_phase, type, farm_province, shipping_province } = req.query;
  const { page, limit, limitVal, offset } = parsePage(req.query, 50);
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
  if (shipping_province) {
    // Filter by the company's FIRST shipping address (earliest created_at)
    // and require the company to be a customer.
    where += ` AND c.lifecycle_phase = 'Customer'
      AND c.id IN (
        SELECT company_id FROM (
          SELECT ct.company_id, a.province,
            ROW_NUMBER() OVER (
              PARTITION BY ct.company_id
              ORDER BY a.created_at ASC, a.id ASC
            ) AS rn
          FROM adresses a
          JOIN contacts ct ON ct.id = a.contact_id
          WHERE a.address_type = 'Livraison'
            AND ct.company_id IS NOT NULL
        ) WHERE rn = 1 AND province = ?
      )`;
    params.push(shipping_province);
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM companies c ${where}`).get(...params).c;
  const companies = db.prepare(
    `SELECT c.*,
      (SELECT COUNT(*) FROM contacts ct WHERE ct.company_id = c.id AND ct.deleted_at IS NULL) as contacts_count,
      (SELECT COUNT(*) FROM projects p WHERE p.company_id = c.id AND p.deleted_at IS NULL) as projects_count,
      (SELECT COUNT(*) FROM orders o WHERE o.company_id = c.id AND o.deleted_at IS NULL) as orders_count,
      ${CC_PERMISSION_SELECT}
     FROM companies c
     ${CC_PERMISSIONS_JOIN} ON ccp.company_id = c.id
     ${where}
     ORDER BY c.updated_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limitVal, offset);

  res.json({ data: companies, total, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/companies/:id
router.get('/:id', (req, res) => {
  const company = db.prepare(`SELECT * FROM ${readRelation('companies')} WHERE id = ?`).get(req.params.id);
  if (!company) return res.status(404).json({ error: 'Company not found' });

  // Liste les contacts liés via la jointure (inclut les contacts dont
  // l'entreprise principale est ailleurs). `is_primary` indique si c'est
  // l'entreprise principale du contact.
  const contacts = db.prepare(
    `SELECT ct.*, cc.role as link_role, cc.is_primary as link_is_primary
     FROM contact_companies cc
     JOIN contacts ct ON ct.id = cc.contact_id
     WHERE cc.company_id = ? AND ct.deleted_at IS NULL
     ORDER BY cc.is_primary DESC, ct.first_name COLLATE NOCASE`
  ).all(req.params.id);
  const projects = db.prepare(
    'SELECT p.* FROM projects p WHERE p.company_id = ? AND p.deleted_at IS NULL ORDER BY p.created_at DESC'
  ).all(req.params.id);
  const orders = db.prepare(
    `SELECT o.*,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as items_count,
      u.name as assigned_name
     FROM orders o LEFT JOIN users u ON o.assigned_to = u.id
     WHERE o.company_id = ? AND o.deleted_at IS NULL ORDER BY o.created_at DESC LIMIT 20`
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
  const central_controllers = getCentralControllers(req.params.id);
  res.json({ ...company, contacts, projects, orders, tickets, serials, returns_count: returnsCount?.count || 0, central_controllers });
});

// POST /api/companies
router.post('/', (req, res) => {
  const { name, type, lifecycle_phase, phone, email, website, address, city, province, country, notes, currency, language } = req.body;
  if (name === undefined || name === null) return res.status(400).json({ error: 'Name is required' });

  const id = newRecordId();
  db.prepare(
    `INSERT INTO companies (id, name, type, lifecycle_phase, phone, email, website, address, city, province, country, notes, currency, language)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, type || null, lifecycle_phase || null, phone || null, email || null,
    website || null, address || null, city || null, province || null, country || 'Canada', notes || null,
    currency || 'CAD', language || null);

  emitCompany('created', id, req.user?.id);
  res.status(201).json(db.prepare('SELECT * FROM companies WHERE id = ?').get(id));
});

// PUT /api/companies/:id — patch partial : n'écrit que les champs présents dans le body
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM companies WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Company not found' });

  const { setClause, values } = buildPartialUpdate(req.body, {
    allowed: ['name','type','lifecycle_phase','phone','email','website','address','city','province','country','notes','currency','language','is_vendeur_orisha'],
    coerce: { is_vendeur_orisha: v => (v === true || v === 1 || v === '1' ? 1 : 0) },
  });
  if (setClause) {
    db.prepare(`UPDATE companies SET ${setClause}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(...values, req.params.id);
    emitCompany('updated', req.params.id, req.user?.id);
  }

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
    LEFT JOIN contacts ct ON r.contact = ct.id
    LEFT JOIN orders o ON r.order_id = o.id
    WHERE r.company_id = ?
    ORDER BY r.created_at DESC
  `).all(req.params.id)
  res.json({ data: rows })
})

// GET /api/companies/:id/onboarding-responses
// Réponses du wizard post-paiement (`customer_onboarding_responses`).
router.get('/:id/onboarding-responses', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*,
           pi.id AS extras_pending_id,
           pi.status AS extras_pending_status,
           pi.paid_invoice_id AS extras_paid_invoice_id
    FROM customer_onboarding_responses r
    LEFT JOIN pending_invoices pi ON pi.id = r.extras_pending_invoice_id
    WHERE r.company_id = ?
    ORDER BY COALESCE(r.submitted_at, r.updated_at, r.created_at) DESC
  `).all(req.params.id)

  const safeParse = v => {
    if (!v) return null
    try { return JSON.parse(v) } catch { return null }
  }

  const data = rows.map(r => ({
    id: r.id,
    stripe_session_id: r.stripe_session_id,
    stripe_invoice_id: r.stripe_invoice_id,
    pending_invoice_id: r.pending_invoice_id,
    status: r.status,
    is_new_site: r.is_new_site,
    farm_address: safeParse(r.farm_address_json),
    shipping_same_as_farm: r.shipping_same_as_farm == null ? null : !!r.shipping_same_as_farm,
    shipping_address: safeParse(r.shipping_address_json),
    network_access: r.network_access,
    wifi_ssid: r.wifi_ssid,
    wifi_password: r.wifi_password,
    permission_level: r.permission_level,
    num_greenhouses: r.num_greenhouses,
    greenhouses: safeParse(r.greenhouses_json) || [],
    extras: safeParse(r.extras_json) || [],
    extras_pending_invoice: r.extras_pending_id ? {
      id: r.extras_pending_id,
      status: r.extras_pending_status,
      paid_invoice_id: r.extras_paid_invoice_id,
    } : null,
    submitted_at: r.submitted_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }))
  res.json({ data })
})

// DELETE /api/companies/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM companies WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Company not found' });
  db.prepare("UPDATE companies SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(req.params.id);
  emitCompany('deleted', req.params.id, req.user?.id);
  res.json({ message: 'Deleted' });
});

export default router;
