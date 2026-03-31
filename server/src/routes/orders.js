import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    `SELECT oi.*, pr.name_fr as product_name, pr.name_en as product_name_en, pr.sku, pr.image_url as product_image
     FROM order_items oi
     LEFT JOIN products pr ON oi.product_id = pr.id
     WHERE oi.order_id = ?
     ORDER BY oi.sort_order, oi.created_at`
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
  const { company_id, project_id, assigned_to, status, priority, notes, date_commande, items = [] } = req.body;

  const tid = req.user.tenant_id;
  const id = uuidv4();

  // Generate next order number
  const maxNum = db.prepare('SELECT MAX(order_number) as m FROM orders WHERE tenant_id = ?').get(tid);
  const orderNumber = (maxNum?.m || 0) + 1;

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO orders (id, tenant_id, order_number, company_id, project_id, assigned_to, status, priority, notes, date_commande)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, tid, orderNumber, company_id || null, project_id || null, assigned_to || null,
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

  res.status(201).json({ ...order, items: orderItems });
});

// PUT /api/orders/:id
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM orders WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!existing) return res.status(404).json({ error: 'Order not found' });

  const { company_id, project_id, assigned_to, status, priority, notes, address_id, date_commande } = req.body;
  db.prepare(
    `UPDATE orders SET company_id=?, project_id=?, assigned_to=?, status=?, priority=?, notes=?, address_id=?, date_commande=?, updated_at=datetime('now')
     WHERE id = ? AND tenant_id = ?`
  ).run(company_id || null, project_id || null, assigned_to || null, status,
    priority || null, notes || null, address_id || null, date_commande || null, req.params.id, req.user.tenant_id);

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

// PATCH /api/orders/:id/items/reorder
router.patch('/:id/items/reorder', (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Array required' });
  const stmt = db.prepare('UPDATE order_items SET sort_order=? WHERE id=? AND order_id=?');
  for (const { id, sort_order } of req.body) {
    stmt.run(sort_order, id, req.params.id);
  }
  res.json({ ok: true });
});

// PATCH /api/orders/:id/items/:itemId — inline edit
router.patch('/:id/items/:itemId', (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const allowed = ['product_id', 'qty', 'unit_cost', 'item_type', 'notes'];
  const updates = [];
  const values = [];
  for (const key of allowed) {
    if (key in req.body) { updates.push(`${key}=?`); values.push(req.body[key]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  db.prepare(`UPDATE order_items SET ${updates.join(', ')} WHERE id=? AND order_id=?`).run(...values, req.params.itemId, req.params.id);
  db.prepare(`UPDATE orders SET updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  res.json(db.prepare('SELECT oi.*, pr.name_fr as product_name, pr.sku, pr.image_url as product_image FROM order_items oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.id=?').get(req.params.itemId));
});

// POST /api/orders/:id/items/:itemId/duplicate
router.post('/:id/items/:itemId/duplicate', (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const item = db.prepare('SELECT * FROM order_items WHERE id=? AND order_id=?').get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const newId = uuidv4();
  db.prepare('INSERT INTO order_items (id, order_id, product_id, qty, unit_cost, item_type, notes, sort_order) VALUES (?,?,?,?,?,?,?,?)')
    .run(newId, req.params.id, item.product_id, item.qty, item.unit_cost, item.item_type, item.notes, (item.sort_order || 0) + 1);
  db.prepare(`UPDATE orders SET updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  res.status(201).json(db.prepare('SELECT oi.*, pr.name_fr as product_name, pr.sku, pr.image_url as product_image FROM order_items oi LEFT JOIN products pr ON oi.product_id = pr.id WHERE oi.id=?').get(newId));
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

// POST /api/orders/:id/bon-livraison — generate delivery note PDF
router.post('/:id/bon-livraison', async (req, res) => {
  const tid = req.user.tenant_id;
  const order = db.prepare(
    `SELECT o.*, c.name as company_name, c.address as company_address, c.city as company_city,
      c.province as company_province, c.country as company_country,
      a.line1 as address_line1, a.city as address_city,
      a.province as address_province, a.postal_code as address_postal_code, a.country as address_country
     FROM orders o
     LEFT JOIN companies c ON o.company_id = c.id
     LEFT JOIN adresses a ON o.address_id = a.id
     WHERE o.id = ? AND o.tenant_id = ?`
  ).get(req.params.id, tid);
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
  db.prepare(`UPDATE orders SET bon_livraison_path = ?, updated_at = datetime('now') WHERE id = ?`).run(relPath, req.params.id);

  res.json({ bon_livraison_path: relPath, url: `/api/bons-livraison/${filename}` });
});

export default router;
