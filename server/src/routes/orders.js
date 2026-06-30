import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import { PDFDocument as PDFLibDocument } from 'pdf-lib';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { buildPartialUpdate } from '../utils/partialUpdate.js';
import { emitOrder, emitOrderItem } from '../services/realtimeEmitters.js';
import { notifyAssignment } from '../services/notifications.js';
import { getCentralControllers } from '../utils/centralController.js';
import { rescanRachatForCompany } from '../services/subscriptionEvents.js';
import { logSync } from '../services/syncLog.js';
import { parsePositiveInt, parseNonNegativeInt, parseNonNegativeNumber, validateNumericFields } from '../utils/validateNumbers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = Router();
router.use(requireAuth);

// Re-scan best-effort des churns récents d'un client à la création/modif d'une
// commande (détection "rachat"). rescanRachatForCompany route déjà chaque event
// par safeDetectRachatForChurn (log + file de retry), mais un échec de la passe
// elle-même (SELECT, emits) ne doit pas être avalé silencieusement : on le trace
// dans sync_log au lieu d'un catch {} muet.
function rescanRachatLogged(companyId, trigger) {
  if (!companyId) return;
  try {
    const scanned = rescanRachatForCompany(companyId);
    logSync('rachat-rescan', 'manual', { status: 'success', modified: scanned });
  } catch (e) {
    logSync('rachat-rescan', 'manual', { status: 'error', error: `${trigger}: ${e.message}` });
    console.error(`rescanRachatForCompany (${trigger}, company ${companyId}):`, e.message);
  }
}

// GET /api/orders/lookup — minimal list for dropdowns
router.get('/lookup', (req, res) => {
  const rows = db.prepare(
    `SELECT o.id, o.order_number, o.company_id, c.name as company_name
     FROM orders o
     LEFT JOIN companies c ON c.id = o.company_id
     WHERE o.deleted_at IS NULL
     ORDER BY o.order_number DESC`
  ).all()
  res.json(rows)
})

// GET /api/orders
router.get('/', (req, res) => {
  const { search, status, company_id, page = 1, limit = 50 } = req.query;
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit);
  let where = 'WHERE o.deleted_at IS NULL';
  const params = [];

  if (search) {
    where += ' AND (c.name LIKE ? OR CAST(o.order_number AS TEXT) LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q);
  }
  if (status) {
    where += ' AND o.status = ?';
    params.push(status);
  }
  if (company_id) {
    where += ' AND o.company_id = ?';
    params.push(company_id);
  }

  const total = db.prepare(
    `SELECT COUNT(*) as c FROM orders o LEFT JOIN companies c ON o.company_id = c.id ${where}`
  ).get(...params).c;

  const orders = db.prepare(
    `SELECT o.*, c.name as company_name, u.name as assigned_name,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as items_count,
      (SELECT SUM(oi.qty * oi.unit_cost) FROM order_items oi WHERE oi.order_id = o.id) as total_value
     FROM orders o
     LEFT JOIN companies c ON o.company_id = c.id
     LEFT JOIN users u ON o.assigned_to = u.id
     ${where}
     ORDER BY o.created_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limitVal, offset);

  res.json({ data: orders, total, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/orders/:id
router.get('/:id', (req, res) => {
  const order = db.prepare(
    `SELECT o.*, c.name as company_name, u.name as assigned_name, p.name as project_name,
      a.line1 as address_line1, a.city as address_city, a.province as address_province,
      a.postal_code as address_postal_code, a.country as address_country
     FROM orders o
     LEFT JOIN companies c ON o.company_id = c.id
     LEFT JOIN users u ON o.assigned_to = u.id
     LEFT JOIN projects p ON o.project_id = p.id
     LEFT JOIN adresses a ON o.address_id = a.id
     WHERE o.id = ? AND o.deleted_at IS NULL`
  ).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const items = db.prepare(
    `SELECT oi.*, pr.name_fr as product_name, pr.name_en as product_name_en, pr.sku, pr.image_url as product_image, pr.stock_qty as product_stock, pr.location as product_location, pr.type as product_type
     FROM order_items oi
     LEFT JOIN products pr ON oi.product_id = pr.id
     WHERE oi.order_id = ?
     ORDER BY oi.sort_order, oi.created_at`
  ).all(req.params.id);

  const shipments = db.prepare('SELECT * FROM shipments WHERE order_id = ? AND deleted_at IS NULL ORDER BY created_at').all(req.params.id);

  const itemIds = items.map(i => i.id)
  let itemsWithSerials = items
  if (itemIds.length > 0) {
    const serials = db.prepare(
      `SELECT * FROM serial_numbers WHERE order_item_id IN (${itemIds.map(() => '?').join(',')}) ORDER BY serial`
    ).all(...itemIds)
    const byItem = {}
    for (const s of serials) {
      if (!byItem[s.order_item_id]) byItem[s.order_item_id] = []
      byItem[s.order_item_id].push(s)
    }
    itemsWithSerials = items.map(i => ({ ...i, serials: byItem[i.id] || [] }))
  }

  const factures = db.prepare(
    `SELECT id, document_number, status, total_amount FROM factures
     WHERE (order_id = ? OR (? IS NOT NULL AND project_id = ?))
     ORDER BY document_date ASC`
  ).all(req.params.id, order.project_id, order.project_id);

  const central_controllers = getCentralControllers(order.company_id);

  // ── Rentabilité ────────────────────────────────────────────────────────────
  // Revenu et coûts calculés EXACTEMENT comme le tableau Rentabilité du dashboard
  // (server/src/routes/dashboard.js). Garder les deux alignés.
  //   Revenu : abonnement → 1re facture HT × 38 ; achat → SUM des factures HT,
  //            liées directement (order_id) ou via le projet (project_id).
  //   Coûts (COGS) : SUM(COALESCE(shipped_unit_cost, unit_cost) × qty) pour les
  //            items 'Facturable' uniquement.
  // L'override (revenue_override_cad) prime sur le revenu calculé quand il est posé.
  const revenueComputed = order.is_subscription
    ? (db.prepare(
        `SELECT f.amount_before_tax_cad * 38 AS rev FROM factures f
         WHERE (f.order_id = ? OR (? IS NOT NULL AND f.project_id = ?))
         ORDER BY COALESCE(f.document_date, f.created_at) ASC LIMIT 1`
      ).get(req.params.id, order.project_id, order.project_id)?.rev || 0)
    : (db.prepare(
        `SELECT COALESCE(SUM(f.amount_before_tax_cad), 0) AS rev FROM factures f
         WHERE (f.order_id = ? OR (? IS NOT NULL AND f.project_id = ?))`
      ).get(req.params.id, order.project_id, order.project_id)?.rev || 0);
  const cogs = db.prepare(
    `SELECT COALESCE(SUM(COALESCE(oi.shipped_unit_cost, oi.unit_cost) * oi.qty), 0) AS cogs
     FROM order_items oi WHERE oi.order_id = ? AND oi.item_type = 'Facturable'`
  ).get(req.params.id)?.cogs || 0;
  const override = order.revenue_override_cad;
  const revenueEffective = (override != null) ? override : revenueComputed;
  const profitability = {
    revenue_computed: revenueComputed,
    revenue_override_cad: override != null ? override : null,
    revenue_effective: revenueEffective,
    cogs,
    profit: revenueEffective - cogs,
    margin_pct: revenueEffective ? ((revenueEffective - cogs) / revenueEffective) * 100 : null,
  };

  res.json({ ...order, items: itemsWithSerials, shipments, factures, central_controllers, profitability });
});

// POST /api/orders
router.post('/', (req, res) => {
  const { company_id, project_id, assigned_to, status, priority, notes, date_commande, items = [] } = req.body;

  if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
  // Valide qty/unit_cost de chaque ligne avant d'ouvrir la transaction : aucune
  // quantité NaN/décimale/négative ni coût négatif ne doit entrer en DB.
  for (const item of items) {
    if (item.qty !== undefined && item.qty !== null && parsePositiveInt(item.qty) === null) {
      return res.status(400).json({ error: 'item qty must be a positive integer' });
    }
    if (item.unit_cost !== undefined && item.unit_cost !== null && item.unit_cost !== '' &&
        parseNonNegativeNumber(item.unit_cost) === null) {
      return res.status(400).json({ error: 'item unit_cost must be a number >= 0' });
    }
  }

  const id = uuidv4();

  // Generate next order number
  const maxNum = db.prepare('SELECT MAX(order_number) as m FROM orders').get();
  const orderNumber = (maxNum?.m || 0) + 1;

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO orders (id, order_number, company_id, project_id, assigned_to, status, priority, notes, date_commande)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orderNumber, company_id || null, project_id || null, assigned_to || null,
      status || 'Commande vide', priority || null, notes || null, date_commande || null);

    for (const item of items) {
      const itemId = uuidv4();
      // Get current product cost if not provided
      let unitCost = item.unit_cost;
      if (!unitCost && item.product_id) {
        const product = db.prepare('SELECT unit_cost FROM products WHERE id = ?').get(item.product_id);
        unitCost = product?.unit_cost || 0;
      }
      db.prepare(
        `INSERT INTO order_items (id, order_id, product_id, qty, unit_cost, item_type, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(itemId, id, item.product_id || null, item.qty || 1, unitCost || 0,
        item.item_type || 'Facturable', item.notes || null);
    }
  });
  run();

  const order = db.prepare(
    `SELECT o.*, c.name as company_name FROM orders o LEFT JOIN companies c ON o.company_id = c.id WHERE o.id = ?`
  ).get(id);
  const orderItems = db.prepare(
    `SELECT oi.*, pr.name_fr as product_name, pr.sku FROM order_items oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.order_id = ?`
  ).all(id);

  emitOrder('created', id, req.user?.id);
  notifyAssignment({
    assignedTo: assigned_to,
    actorUserId: req.user?.id,
    type: 'order:assigned',
    title: `Commande #${orderNumber} assignée à vous`,
    link: `/orders/${id}`,
  });
  // Une nouvelle commande peut être le rachat d'un churn récent du même
  // client — re-scanne les churns sans rachat des 12 derniers mois.
  rescanRachatLogged(order?.company_id, 'order-create');
  res.status(201).json({ ...order, items: orderItems });
});

// PUT /api/orders/:id — partial update
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id, assigned_to, order_number FROM orders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Order not found' });

  // L'override de revenu alimente directement le P&L : un `"abc"` ou un négatif
  // doit être rejeté (400), pas stocké tel quel (NaN) ni coercé silencieusement.
  // '' / null restent permis (efface l'override → retour au revenu calculé).
  const { error: numError } = validateNumericFields(req.body, [
    { key: 'revenue_override_cad' },
  ]);
  if (numError) return res.status(400).json({ error: numError });

  const { setClause, values, error } = buildPartialUpdate(req.body, {
    allowed: ['company_id', 'project_id', 'assigned_to', 'status', 'priority',
      'notes', 'address_id', 'date_commande', 'is_subscription', 'revenue_override_cad'],
    nonNullable: new Set(['status']),
    coerce: {
      is_subscription: v => v ? 1 : 0,
      // '' / null effacent l'override → on retombe sur le revenu calculé.
      revenue_override_cad: v => (v === '' || v == null ? null : Number(v)),
    },
  });
  if (error) return res.status(400).json({ error });
  if (setClause) {
    db.prepare(`UPDATE orders SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id);
  }

  emitOrder('updated', req.params.id, req.user?.id);
  if ('assigned_to' in req.body) {
    notifyAssignment({
      assignedTo: req.body.assigned_to,
      prevAssignedTo: existing.assigned_to,
      actorUserId: req.user?.id,
      type: 'order:assigned',
      title: `Commande #${existing.order_number} assignée à vous`,
      link: `/orders/${req.params.id}`,
    });
  }
  const updated = db.prepare('SELECT o.*, c.name as company_name, p.name as project_name FROM orders o LEFT JOIN companies c ON o.company_id = c.id LEFT JOIN projects p ON o.project_id = p.id WHERE o.id = ?').get(req.params.id);
  // Une modif de commande (date, company, ou items en cascade) peut affecter
  // l'éligibilité comme rachat — re-scan best-effort.
  rescanRachatLogged(updated?.company_id, 'order-update');
  res.json(updated);
});

// PATCH /api/orders/:id/status
router.patch('/:id/status', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { status } = req.body;
  const validStatuses = ['Commande vide', "Gel d'envois", 'En attente', 'Items à fabriquer ou à acheter', 'Tous les items sont disponibles', 'Tout est dans la boite', 'Partiellement envoyé', 'JWT-config', "Envoyé aujourd'hui", 'Envoyé', 'ERREUR SYSTÈME'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  // When marking as Envoyé or Envoyé aujourd'hui, decrease stock for each item
  const shippedStatuses = ['Envoyé', "Envoyé aujourd'hui"]
  if (shippedStatuses.includes(status) && !shippedStatuses.includes(order.status)) {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
    const run = db.transaction(() => {
      db.prepare(`UPDATE orders SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(status, order.id);
      for (const item of items) {
        if (!item.product_id) continue;
        const product = db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(item.product_id);
        if (product) {
          db.prepare(`UPDATE products SET stock_qty=MAX(0, stock_qty - ?), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
            .run(item.qty, item.product_id);
          db.prepare(
            `INSERT INTO stock_movements (id, product_id, type, qty, reason, reference_id, user_id)
             VALUES (?, ?, 'out', ?, 'Commande envoyée', ?, ?)`
          ).run(uuidv4(), item.product_id, item.qty, order.id, req.user.id);
        }
      }
    });
    run();
  } else {
    db.prepare(`UPDATE orders SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(status, req.params.id);
  }

  emitOrder('updated', req.params.id, req.user?.id);
  res.json({ message: 'Status updated', status });
});

// POST /api/orders/:id/shipments
router.post('/:id/shipments', (req, res) => {
  const order = db.prepare('SELECT id, address_id FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { tracking_number, carrier, status, shipped_at, notes, item_ids = [], address_id } = req.body;
  const resolvedAddressId = address_id !== undefined ? address_id : order.address_id;
  const id = uuidv4();
  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO shipments (id, order_id, tracking_number, carrier, status, shipped_at, notes, address_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, req.params.id, tracking_number || null, carrier || null,
      status || 'À envoyer', shipped_at || null, notes || null, resolvedAddressId || null);

    if (item_ids.length > 0) {
      const stmt = db.prepare(`UPDATE order_items SET shipment_id = ?, fulfillment_status = 'Dans l''envoi' WHERE id = ? AND order_id = ?`);
      for (const itemId of item_ids) {
        stmt.run(id, itemId, req.params.id);
      }
      // Freeze unit cost if shipment is already Envoyé
      if ((status || 'À envoyer') === 'Envoyé') {
        const freezeStmt = db.prepare(`UPDATE order_items SET shipped_unit_cost = unit_cost WHERE id = ? AND shipped_unit_cost IS NULL`);
        for (const itemId of item_ids) {
          freezeStmt.run(itemId);
        }
      }
    }
  });
  run();

  const shipment = db.prepare('SELECT * FROM shipments WHERE id = ?').get(id);
  emitOrderItem('bulk_updated', req.params.id, { shipment, item_ids }, req.user?.id);
  res.status(201).json(shipment);
});

// POST /api/orders/:id/items — add item to existing order
router.post('/:id/items', (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { product_id, qty, unit_cost, item_type, notes } = req.body;
  if (qty !== undefined && qty !== null && parsePositiveInt(qty) === null) {
    return res.status(400).json({ error: 'qty must be a positive integer' });
  }
  if (unit_cost !== undefined && unit_cost !== null && unit_cost !== '' &&
      parseNonNegativeNumber(unit_cost) === null) {
    return res.status(400).json({ error: 'unit_cost must be a number >= 0' });
  }
  let cost = unit_cost;
  if (!cost && product_id) {
    const product = db.prepare('SELECT unit_cost FROM products WHERE id = ?').get(product_id);
    cost = product?.unit_cost || 0;
  }
  const itemId = uuidv4();
  db.prepare(
    `INSERT INTO order_items (id, order_id, product_id, qty, unit_cost, item_type, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(itemId, req.params.id, product_id || null, qty || 1, cost || 0, item_type || 'Facturable', notes || null);

  db.prepare(`UPDATE orders SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(req.params.id);
  const newItem = db.prepare('SELECT oi.*, pr.name_fr as product_name, pr.sku FROM order_items oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.id = ?').get(itemId);
  emitOrderItem('created', req.params.id, newItem, req.user?.id);
  res.status(201).json(newItem);
});

// PATCH /api/orders/:id/items/reorder
router.patch('/:id/items/reorder', (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Array required' });
  const stmt = db.prepare('UPDATE order_items SET sort_order=? WHERE id=? AND order_id=?');
  for (const { id, sort_order } of req.body) {
    stmt.run(sort_order, id, req.params.id);
  }
  emitOrderItem('reordered', req.params.id, { items: req.body }, req.user?.id);
  res.json({ ok: true });
});

// PATCH /api/orders/:id/items/:itemId — inline edit
router.patch('/:id/items/:itemId', (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  // Refuse les états impossibles avant l'UPDATE : qty entier positif, unit_cost
  // nombre >= 0, fulfilled_qty entier >= 0.
  if ('qty' in req.body && parsePositiveInt(req.body.qty) === null) {
    return res.status(400).json({ error: 'qty must be a positive integer' });
  }
  if ('unit_cost' in req.body && req.body.unit_cost !== null && req.body.unit_cost !== '' &&
      parseNonNegativeNumber(req.body.unit_cost) === null) {
    return res.status(400).json({ error: 'unit_cost must be a number >= 0' });
  }
  if ('fulfilled_qty' in req.body && req.body.fulfilled_qty !== null &&
      parseNonNegativeInt(req.body.fulfilled_qty) === null) {
    return res.status(400).json({ error: 'fulfilled_qty must be an integer >= 0' });
  }
  const allowed = ['product_id', 'qty', 'unit_cost', 'item_type', 'notes', 'replaced_serial', 'fulfillment_status', 'fulfilled_qty', 'shipment_id'];
  const updates = [];
  const values = [];
  for (const key of allowed) {
    if (key in req.body) { updates.push(`${key}=?`); values.push(req.body[key]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  db.prepare(`UPDATE order_items SET ${updates.join(', ')} WHERE id=? AND order_id=?`).run(...values, req.params.itemId, req.params.id);

  // Décochage en mode expédition : si on remet l'article à « À prélever » ou
  // à fulfilled_qty=0, on détache les numéros de série liés (sinon ils
  // restent collés à un item qui n'est plus prélevé). Cas pratique : le
  // picker scanne le mauvais SN, décoche, rescanne le bon.
  const isUnpicking = req.body.fulfillment_status === 'À prélever' || req.body.fulfilled_qty === 0
  if (isUnpicking) {
    db.prepare('UPDATE serial_numbers SET order_item_id = NULL WHERE order_item_id = ?').run(req.params.itemId)
  }

  db.prepare(`UPDATE orders SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(req.params.id);
  const item = db.prepare('SELECT oi.*, pr.name_fr as product_name, pr.sku, pr.image_url as product_image FROM order_items oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.id=?').get(req.params.itemId);
  // Inclure serials dans la réponse (et l'événement realtime) pour que le
  // client mette à jour ses badges sans refetch — le merge côté UI applique
  // `serials: []` quand on vient de détacher.
  const serials = db.prepare('SELECT * FROM serial_numbers WHERE order_item_id = ? ORDER BY serial').all(req.params.itemId)
  const itemWithSerials = { ...item, serials }
  emitOrderItem('updated', req.params.id, itemWithSerials, req.user?.id);
  res.json(itemWithSerials);
});

// POST /api/orders/:id/items/:itemId/duplicate
router.post('/:id/items/:itemId/duplicate', (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const item = db.prepare('SELECT * FROM order_items WHERE id=? AND order_id=?').get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const newId = uuidv4();
  db.prepare('INSERT INTO order_items (id, order_id, product_id, qty, unit_cost, item_type, notes, sort_order) VALUES (?,?,?,?,?,?,?,?)')
    .run(newId, req.params.id, item.product_id, item.qty, item.unit_cost, item.item_type, item.notes, (item.sort_order || 0) + 1);
  db.prepare(`UPDATE orders SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(req.params.id);
  const dup = db.prepare('SELECT oi.*, pr.name_fr as product_name, pr.sku, pr.image_url as product_image FROM order_items oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.id=?').get(newId);
  emitOrderItem('created', req.params.id, dup, req.user?.id);
  res.status(201).json(dup);
});

// DELETE /api/orders/:id/items/:itemId
router.delete('/:id/items/:itemId', (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  db.prepare('DELETE FROM order_items WHERE id = ? AND order_id = ?').run(req.params.itemId, req.params.id);
  emitOrderItem('deleted', req.params.id, { id: req.params.itemId }, req.user?.id);
  res.json({ message: 'Item deleted' });
});

// POST /api/orders/:id/scan — barcode scanner (serial or SKU)
router.post('/:id/scan', (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(req.params.id)
  if (!order) return res.status(404).json({ error: 'Order not found' })

  const { value, mode } = req.body
  if (!value || !value.trim()) return res.status(400).json({ error: 'value required' })

  const v = value.trim()

  // ── PICKING MODE: each scan increments fulfilled_qty by 1 ───────────────────
  if (mode === 'pick') {
    function pickItem(item, serialObj) {
      const newQty = Math.min((item.fulfilled_qty || 0) + 1, item.qty)
      const newStatus = newQty >= item.qty ? 'Prélevé' : item.fulfillment_status || 'À prélever'
      db.prepare(`UPDATE order_items SET fulfilled_qty = ?, fulfillment_status = ? WHERE id = ?`).run(newQty, newStatus, item.id)
      if (serialObj && !serialObj.order_item_id) db.prepare('UPDATE serial_numbers SET order_item_id = ? WHERE id = ?').run(item.id, serialObj.id)
      return db.prepare('SELECT oi.*, pr.name_fr as product_name FROM order_items oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.id = ?').get(item.id)
    }

    const serial = db.prepare(
      `SELECT sn.*, pr.name_fr as product_name FROM serial_numbers sn
       LEFT JOIN products pr ON sn.product_id = pr.id
       WHERE sn.serial = ?`
    ).get(v)

    if (serial) {
      const item = db.prepare(
        `SELECT * FROM order_items WHERE order_id = ? AND product_id = ? AND fulfillment_status NOT IN ('Envoyé', 'Dans l''envoi')`
      ).get(req.params.id, serial.product_id)
      if (!item) return res.json({ type: 'serial', action: 'not_in_order', serial })
      const updated = pickItem(item, serial)
      emitOrderItem('updated', req.params.id, updated, req.user?.id)
      return res.json({ type: 'serial', action: 'picked', serial, item: updated })
    }

    const product = db.prepare('SELECT * FROM products WHERE sku = ?').get(v)
    if (product) {
      const item = db.prepare(
        `SELECT * FROM order_items WHERE order_id = ? AND product_id = ? AND fulfillment_status NOT IN ('Envoyé', 'Dans l''envoi')`
      ).get(req.params.id, product.id)
      if (!item) return res.json({ type: 'sku', action: 'not_in_order', product })
      const updated = pickItem(item, null)
      emitOrderItem('updated', req.params.id, updated, req.user?.id)
      return res.json({ type: 'sku', action: 'picked', product, item: updated })
    }

    return res.json({ type: 'not_found', value: v })
  }

  // ── ADD MODE (default): scan adds or links items ────────────────────────────

  // 1. Try serial number
  const serial = db.prepare(
    `SELECT sn.*, pr.name_fr as product_name, pr.sku, pr.unit_cost as product_cost
     FROM serial_numbers sn
     LEFT JOIN products pr ON sn.product_id = pr.id
     WHERE sn.serial = ?`
  ).get(v)

  if (serial) {
    let item = serial.product_id
      ? db.prepare('SELECT * FROM order_items WHERE order_id = ? AND product_id = ?').get(req.params.id, serial.product_id)
      : null

    let action = 'linked'
    if (!item) {
      const itemId = uuidv4()
      db.prepare('INSERT INTO order_items (id, order_id, product_id, qty, unit_cost, item_type) VALUES (?, ?, ?, 1, ?, ?)')
        .run(itemId, req.params.id, serial.product_id || null, serial.product_cost || 0, 'Facturable')
      item = db.prepare('SELECT oi.*, pr.name_fr as product_name FROM order_items oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.id = ?').get(itemId)
      action = 'added'
    }

    db.prepare('UPDATE serial_numbers SET order_item_id = ? WHERE id = ?').run(item.id, serial.id)
    db.prepare(`UPDATE orders SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(req.params.id)
    emitOrderItem(action === 'added' ? 'created' : 'updated', req.params.id, item, req.user?.id)
    return res.json({ type: 'serial', action, serial, item })
  }

  // 2. Try SKU
  const product = db.prepare('SELECT * FROM products WHERE sku = ?').get(v)

  if (product) {
    let item = db.prepare('SELECT * FROM order_items WHERE order_id = ? AND product_id = ?').get(req.params.id, product.id)
    let action

    if (item) {
      db.prepare('UPDATE order_items SET qty = qty + 1 WHERE id = ?').run(item.id)
      item = db.prepare('SELECT oi.*, pr.name_fr as product_name FROM order_items oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.id = ?').get(item.id)
      action = 'incremented'
    } else {
      const itemId = uuidv4()
      db.prepare('INSERT INTO order_items (id, order_id, product_id, qty, unit_cost, item_type) VALUES (?, ?, ?, 1, ?, ?)')
        .run(itemId, req.params.id, product.id, product.unit_cost || 0, 'Facturable')
      item = db.prepare('SELECT oi.*, pr.name_fr as product_name FROM order_items oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.id = ?').get(itemId)
      action = 'added'
    }

    db.prepare(`UPDATE orders SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(req.params.id)
    emitOrderItem(action === 'added' ? 'created' : 'updated', req.params.id, item, req.user?.id)
    return res.json({ type: 'sku', action, product, item })
  }

  return res.json({ type: 'not_found', value: v })
})

// POST /api/orders/:id/generate-installation-docs
// Fusionne en un seul PDF les copies locales (uploads/products/docs/*) :
//   - item_type='Remplacement' → lien_pdf_remplacement_<lang>_local
//   - sinon                     → lien_pdf_installation_<lang>_local
// où <lang> = fr|en selon orders.langue_du_contact_a_la_ferme.
// Dedup par (product_id, doc_type) — un produit présent N fois ne génère qu'un doc.
// Si un *_local est CSV (multi-URL), tous les fichiers sont inclus.
// Les items dont le PDF local manque sont silencieusement ignorés.
router.post('/:id/generate-installation-docs', async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const items = db.prepare(`
    SELECT oi.id, oi.item_type, oi.product_id, p.name_fr as product_name, p.sku,
      p.lien_pdf_installation_fr_local, p.lien_pdf_installation_en_local,
      p.lien_pdf_remplacement_fr_local, p.lien_pdf_remplacement_en_local
    FROM order_items oi
    LEFT JOIN products p ON oi.product_id = p.id
    WHERE oi.order_id = ?
    ORDER BY oi.created_at
  `).all(req.params.id);

  const lang = (order.langue_du_contact_a_la_ferme || '').toLowerCase().startsWith('en') ? 'en' : 'fr';
  const uploadsRoot = path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads');

  const merged = await PDFLibDocument.create();
  const included = [];
  const skipped = [];
  const seen = new Set();

  for (const item of items) {
    if (!item.product_id) {
      skipped.push({ item_id: item.id, sku: item.sku, name: item.product_name, reason: 'no_product' });
      continue;
    }
    const docType = item.item_type === 'Remplacement' ? 'remplacement' : 'installation';
    const dedupKey = `${item.product_id}:${docType}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const col = `lien_pdf_${docType}_${lang}_local`;
    const csvPaths = item[col];
    const paths = (csvPaths || '').split(',').map(s => s.trim()).filter(Boolean);
    if (paths.length === 0) {
      skipped.push({ item_id: item.id, sku: item.sku, name: item.product_name, doc_type: docType, lang, reason: 'no_local_copy' });
      continue;
    }

    for (const relPath of paths) {
      const absPath = path.resolve(uploadsRoot, relPath);
      // Garde-fou : doit être sous uploads/products/docs/
      const allowed = path.resolve(uploadsRoot, 'products', 'docs');
      if (!absPath.startsWith(allowed + path.sep)) {
        skipped.push({ item_id: item.id, sku: item.sku, reason: 'path_outside_allowed' });
        continue;
      }
      if (!fs.existsSync(absPath)) {
        skipped.push({ item_id: item.id, sku: item.sku, name: item.product_name, doc_type: docType, lang, path: relPath, reason: 'file_missing' });
        continue;
      }
      try {
        const bytes = fs.readFileSync(absPath);
        const src = await PDFLibDocument.load(bytes, { ignoreEncryption: true });
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach(p => merged.addPage(p));
        included.push({ item_id: item.id, sku: item.sku, name: item.product_name, doc_type: docType, lang, path: relPath, pages: pages.length });
      } catch (e) {
        skipped.push({ item_id: item.id, sku: item.sku, name: item.product_name, doc_type: docType, lang, path: relPath, reason: 'parse_error', error: e.message });
      }
    }
  }

  if (merged.getPageCount() === 0) {
    return res.status(409).json({ error: 'Aucun document local disponible pour les items de cette commande.', included, skipped });
  }

  const out = await merged.save();
  const filename = `documents-commande-${order.order_number}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('X-Docs-Included', String(included.length));
  res.setHeader('X-Docs-Skipped', String(skipped.length));
  res.send(Buffer.from(out));
});

// DELETE /api/orders/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM orders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Order not found' });

  // ?hard=true → suppression DÉFINITIVE (admin only). Supprime aussi les
  // order_items (FK ON). Réservé au nettoyage de commandes jetables (résidus de
  // tests E2E, junk). Émet 'deleted' + le trigger change_log pose un tombstone
  // → les clients retirent la commande de leur cache. Le défaut reste le
  // soft-delete (deleted_at) pour les vraies commandes.
  const hard = req.query.hard === 'true' || req.query.hard === '1';
  if (hard) {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required for permanent delete' });
    }
    try {
      db.transaction(() => {
        db.prepare('DELETE FROM order_items WHERE order_id = ?').run(req.params.id);
        db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
      })();
    } catch (e) {
      // FK (serials, factures…) → on refuse plutôt que de corrompre.
      return res.status(409).json({ error: 'Permanent delete blocked by dependencies: ' + e.message });
    }
    emitOrder('deleted', req.params.id, req.user?.id);
    return res.json({ message: 'Deleted permanently' });
  }

  db.prepare("UPDATE orders SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(req.params.id);
  emitOrder('deleted', req.params.id, req.user?.id);
  res.json({ message: 'Deleted' });
});

// POST /api/orders/:id/bon-livraison — generate delivery note PDF
router.post('/:id/bon-livraison', async (req, res) => {
  const order = db.prepare(
    `SELECT o.*, c.name as company_name, c.address as company_address, c.city as company_city,
      c.province as company_province, c.country as company_country,
      a.line1 as address_line1, a.city as address_city,
      a.province as address_province, a.postal_code as address_postal_code, a.country as address_country
     FROM orders o
     LEFT JOIN companies c ON o.company_id = c.id
     LEFT JOIN adresses a ON o.address_id = a.id
     WHERE o.id = ? AND o.deleted_at IS NULL`
  ).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const items = db.prepare(
    `SELECT oi.*, pr.name_fr as product_name, pr.sku
     FROM order_items oi
     LEFT JOIN products pr ON oi.product_id = pr.id
     WHERE oi.order_id = ?
     ORDER BY oi.created_at`
  ).all(req.params.id);

  const uploadsDir = path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'bons-livraison');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  const filename = `bon-livraison-${order.order_number}-${Date.now()}.pdf`;
  const filepath = path.join(uploadsDir, filename);

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);

    const pageWidth = doc.page.width - 100; // margins 50 each side

    // ── Header ──────────────────────────────────────────────────────────────
    doc.fontSize(22).font('Helvetica-Bold').text('BON DE LIVRAISON', 50, 50);
    doc.fontSize(11).font('Helvetica').fillColor('#555555')
      .text(`Commande #${order.order_number}`, 50, 80);
    const dateStr = new Date().toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' });
    doc.text(`Généré le ${dateStr}`, 50, 95);
    if (order.date_commande) {
      const cmdDate = new Date(order.date_commande).toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' });
      doc.text(`Date de commande : ${cmdDate}`, 50, 110);
    }

    // ── Divider ──────────────────────────────────────────────────────────────
    doc.moveTo(50, 130).lineTo(50 + pageWidth, 130).strokeColor('#cccccc').lineWidth(1).stroke();

    // ── Client address ───────────────────────────────────────────────────────
    doc.fillColor('#000000').fontSize(12).font('Helvetica-Bold').text('LIVRER À', 50, 145);
    doc.fontSize(11).font('Helvetica');
    let addrY = 162;

    if (order.company_name) {
      doc.fillColor('#000000').text(order.company_name, 50, addrY);
      addrY += 15;
    }

    // Use order address if available, otherwise fall back to company address
    const hasOrderAddr = order.address_line1;
    if (hasOrderAddr) {
      doc.fillColor('#333333').text(order.address_line1, 50, addrY); addrY += 15;
      const cityLine = [order.address_city, order.address_province, order.address_postal_code].filter(Boolean).join('  ');
      if (cityLine) { doc.text(cityLine, 50, addrY); addrY += 15; }
      if (order.address_country) { doc.text(order.address_country, 50, addrY); addrY += 15; }
    } else if (order.company_address || order.company_city) {
      if (order.company_address) { doc.fillColor('#333333').text(order.company_address, 50, addrY); addrY += 15; }
      const cityLine = [order.company_city, order.company_province].filter(Boolean).join('  ');
      if (cityLine) { doc.text(cityLine, 50, addrY); addrY += 15; }
      if (order.company_country) { doc.text(order.company_country, 50, addrY); addrY += 15; }
    } else {
      doc.fillColor('#999999').text('Aucune adresse enregistrée', 50, addrY); addrY += 15;
    }

    // ── Divider ──────────────────────────────────────────────────────────────
    const tableY = addrY + 20;
    doc.moveTo(50, tableY).lineTo(50 + pageWidth, tableY).strokeColor('#cccccc').lineWidth(1).stroke();

    // ── Items table header ───────────────────────────────────────────────────
    const col = { product: 50, sku: 320, qty: 430, notes: 470 };
    const headerY = tableY + 10;
    doc.fillColor('#000000').fontSize(10).font('Helvetica-Bold');
    doc.text('PRODUIT', col.product, headerY);
    doc.text('SKU', col.sku, headerY);
    doc.text('QTÉ', col.qty, headerY);
    doc.text('NOTES', col.notes, headerY);

    doc.moveTo(50, headerY + 16).lineTo(50 + pageWidth, headerY + 16).strokeColor('#cccccc').lineWidth(0.5).stroke();

    // ── Items rows ───────────────────────────────────────────────────────────
    let rowY = headerY + 24;
    doc.font('Helvetica').fontSize(10).fillColor('#222222');

    if (items.length === 0) {
      doc.fillColor('#999999').text('Aucun article dans cette commande.', col.product, rowY);
    } else {
      for (const item of items) {
        if (rowY > doc.page.height - 100) { doc.addPage(); rowY = 50; }

        doc.fillColor('#222222').text(item.product_name || 'Produit inconnu', col.product, rowY, { width: 260, ellipsis: true });
        doc.text(item.sku || '—', col.sku, rowY, { width: 100 });
        doc.text(String(item.qty), col.qty, rowY, { width: 35 });
        if (item.notes) doc.fillColor('#666666').text(item.notes, col.notes, rowY, { width: 80, ellipsis: true });

        rowY += 18;
        doc.moveTo(50, rowY - 4).lineTo(50 + pageWidth, rowY - 4).strokeColor('#eeeeee').lineWidth(0.5).stroke();
        doc.fillColor('#222222');
      }
    }

    // ── Footer ───────────────────────────────────────────────────────────────
    const footerY = doc.page.height - 60;
    doc.moveTo(50, footerY).lineTo(50 + pageWidth, footerY).strokeColor('#cccccc').lineWidth(1).stroke();
    doc.fillColor('#999999').fontSize(9).font('Helvetica')
      .text(`ERP Orisha · Commande #${order.order_number} · ${dateStr}`, 50, footerY + 10, { align: 'center', width: pageWidth });

    doc.end();
  });

  // Store relative path in DB
  const relPath = `bons-livraison/${filename}`;
  db.prepare(`UPDATE orders SET bon_livraison_path = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(relPath, req.params.id);

  emitOrder('updated', req.params.id, req.user?.id);
  res.json({ bon_livraison_path: relPath, url: `/api/bons-livraison/${filename}` });
});

export default router;
