import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/orders
router.get('/', (req, res) => {
  const { search, status, company_id, page = 1, limit = 50 } = req.query;
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit);
  const tid = req.user.tenant_id;

  let where = 'WHERE o.tenant_id = ?';
  const params = [tid];

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
     WHERE o.id = ? AND o.tenant_id = ?`
  ).get(req.params.id, req.user.tenant_id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const items = db.prepare(
    `SELECT oi.*, pr.name_fr as product_name, pr.name_en as product_name_en, pr.sku
     FROM order_items oi
     LEFT JOIN products pr ON oi.product_id = pr.id
     WHERE oi.order_id = ?
     ORDER BY oi.created_at`
  ).all(req.params.id);

  const shipments = db.prepare('SELECT * FROM shipments WHERE order_id = ? ORDER BY created_at').all(req.params.id);

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
  res.json({ ...order, items: itemsWithSerials, shipments });
});

// POST /api/orders
router.post('/', (req, res) => {
  const { company_id, project_id, assigned_to, status, priority, notes, items = [] } = req.body;

  const tid = req.user.tenant_id;
  const id = uuidv4();

  // Generate next order number
  const maxNum = db.prepare('SELECT MAX(order_number) as m FROM orders WHERE tenant_id = ?').get(tid);
  const orderNumber = (maxNum?.m || 0) + 1;

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO orders (id, tenant_id, order_number, company_id, project_id, assigned_to, status, priority, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, tid, orderNumber, company_id || null, project_id || null, assigned_to || null,
      status || 'Commande vide', priority || null, notes || null);

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

  res.status(201).json({ ...order, items: orderItems });
});

// PUT /api/orders/:id
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM orders WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!existing) return res.status(404).json({ error: 'Order not found' });

  const { company_id, project_id, assigned_to, status, priority, notes, address_id } = req.body;
  db.prepare(
    `UPDATE orders SET company_id=?, project_id=?, assigned_to=?, status=?, priority=?, notes=?, address_id=?, updated_at=datetime('now')
     WHERE id = ? AND tenant_id = ?`
  ).run(company_id || null, project_id || null, assigned_to || null, status,
    priority || null, notes || null, address_id || null, req.params.id, req.user.tenant_id);

  res.json(db.prepare('SELECT o.*, c.name as company_name FROM orders o LEFT JOIN companies c ON o.company_id = c.id WHERE o.id = ?').get(req.params.id));
});

// PATCH /api/orders/:id/status
router.patch('/:id/status', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
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
      db.prepare(`UPDATE orders SET status=?, updated_at=datetime('now') WHERE id = ?`).run(status, order.id);
      for (const item of items) {
        if (!item.product_id) continue;
        const product = db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(item.product_id);
        if (product) {
          db.prepare(`UPDATE products SET stock_qty=MAX(0, stock_qty - ?), updated_at=datetime('now') WHERE id = ?`)
            .run(item.qty, item.product_id);
          db.prepare(
            `INSERT INTO stock_movements (id, tenant_id, product_id, type, qty, reason, reference_id, user_id)
             VALUES (?, ?, ?, 'out', ?, 'Commande envoyée', ?, ?)`
          ).run(uuidv4(), req.user.tenant_id, item.product_id, item.qty, order.id, req.user.id);
        }
      }
    });
    run();
  } else {
    db.prepare(`UPDATE orders SET status=?, updated_at=datetime('now') WHERE id = ? AND tenant_id = ?`)
      .run(status, req.params.id, req.user.tenant_id);
  }

  res.json({ message: 'Status updated', status });
});

// POST /api/orders/:id/shipments
router.post('/:id/shipments', (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { tracking_number, carrier, status, shipped_at, notes } = req.body;
  const id = uuidv4();
  db.prepare(
    `INSERT INTO shipments (id, tenant_id, order_id, tracking_number, carrier, status, shipped_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.user.tenant_id, req.params.id, tracking_number || null, carrier || null,
    status || 'À envoyer', shipped_at || null, notes || null);

  res.status(201).json(db.prepare('SELECT * FROM shipments WHERE id = ?').get(id));
});

// POST /api/orders/:id/items — add item to existing order
router.post('/:id/items', (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { product_id, qty, unit_cost, item_type, notes } = req.body;
  let cost = unit_cost;
  if (!cost && product_id) {
    const product = db.prepare('SELECT unit_cost FROM products WHERE id = ?').get(product_id);
    cost = product?.unit_cost || 0;
  }
  const itemId = uuidv4();
  db.prepare(
    `INSERT INTO order_items (id, order_id, product_id, qty, unit_cost, item_type, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(itemId, req.params.id, product_id || null, qty || 1, cost || 0, item_type || 'Facturable', notes || null);

  db.prepare(`UPDATE orders SET updated_at=datetime('now') WHERE id = ?`).run(req.params.id);
  res.status(201).json(db.prepare('SELECT oi.*, pr.name_fr as product_name, pr.sku FROM order_items oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.id = ?').get(itemId));
});

// DELETE /api/orders/:id/items/:itemId
router.delete('/:id/items/:itemId', (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  db.prepare('DELETE FROM order_items WHERE id = ? AND order_id = ?').run(req.params.itemId, req.params.id);
  res.json({ message: 'Item deleted' });
});

// DELETE /api/orders/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM orders WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!existing) return res.status(404).json({ error: 'Order not found' });
  db.prepare('DELETE FROM orders WHERE id = ? AND tenant_id = ?').run(req.params.id, req.user.tenant_id);
  res.json({ message: 'Deleted' });
});

export default router;
