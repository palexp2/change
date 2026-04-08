import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/products
router.get('/', (req, res) => {
  const { search, type, procurement_type, low_stock, active, page = 1, limit = 100 } = req.query;
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit);

  let where = 'WHERE deleted_at IS NULL';
  const params = [];

  if (search) {
    where += ' AND (unaccent(sku) LIKE unaccent(?) OR unaccent(name_fr) LIKE unaccent(?) OR unaccent(name_en) LIKE unaccent(?) OR unaccent(supplier) LIKE unaccent(?))';
    const q = `%${search}%`;
    params.push(q, q, q, q);
  }
  if (type) {
    where += ' AND type = ?';
    params.push(type);
  }
  if (procurement_type) {
    where += ' AND procurement_type = ?';
    params.push(procurement_type);
  }
  if (low_stock === 'true') {
    where += ' AND stock_qty <= min_stock AND min_stock > 0';
  }
  if (active !== undefined) {
    where += ' AND active = ?';
    params.push(active === 'true' ? 1 : 0);
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM products ${where}`).get(...params).c;
  const products = db.prepare(
    `SELECT * FROM products ${where} ORDER BY name_fr LIMIT ? OFFSET ?`
  ).all(...params, limitVal, offset);

  res.json({ data: products, total, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/products/:id
router.get('/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const movements = db.prepare(
    `SELECT sm.*, u.name as user_name FROM stock_movements sm
     LEFT JOIN users u ON sm.user_id = u.id
     WHERE sm.product_id = ?
     ORDER BY sm.created_at DESC LIMIT 50`
  ).all(req.params.id);

  res.json({ ...product, movements });
});

// POST /api/products
router.post('/', (req, res) => {
  const { sku, name_fr, name_en, type, unit_cost, price_cad, stock_qty, min_stock, order_qty, supplier, procurement_type, weight_lbs, notes } = req.body;
  if (!name_fr) return res.status(400).json({ error: 'name_fr is required' });

  const id = uuidv4();
  db.prepare(
    `INSERT INTO products (id, sku, name_fr, name_en, type, unit_cost, price_cad, stock_qty, min_stock, order_qty, supplier, procurement_type, weight_lbs, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, sku || null, name_fr, name_en || null, type || null,
    unit_cost || 0, price_cad || 0, stock_qty || 0, min_stock || 0, order_qty || 0,
    supplier || null, procurement_type || null, weight_lbs || 0, notes || null);

  res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
});

// PUT /api/products/:id
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found' });

  const { sku, name_fr, name_en, type, unit_cost, price_cad, price_usd, monthly_price_cad, monthly_price_usd, is_sellable, min_stock, order_qty, location, supplier, procurement_type, weight_lbs, notes, active } = req.body;
  db.prepare(
    `UPDATE products SET sku=?, name_fr=?, name_en=?, type=?, unit_cost=?, price_cad=?, price_usd=?, monthly_price_cad=?, monthly_price_usd=?, is_sellable=?, min_stock=?, order_qty=?, location=?, supplier=?, procurement_type=?, weight_lbs=?, notes=?, active=?, updated_at=datetime('now')
     WHERE id = ?`
  ).run(sku || null, name_fr, name_en || null, type || null, unit_cost || 0, price_cad || 0,
    price_usd || 0, monthly_price_cad || 0, monthly_price_usd || 0, is_sellable ? 1 : 0,
    min_stock || 0, order_qty || 0, location || null, supplier || null, procurement_type || null, weight_lbs || 0, notes || null,
    active !== undefined ? (active ? 1 : 0) : 1, req.params.id);

  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
});

// POST /api/products/:id/stock — adjust stock
router.post('/:id/stock', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const { type, qty, reason, reference_id } = req.body;
  if (!type || !['in', 'out', 'adjustment'].includes(type)) {
    return res.status(400).json({ error: 'type must be in|out|adjustment' });
  }
  if (qty === undefined || qty === null) {
    return res.status(400).json({ error: 'qty is required' });
  }

  const movId = uuidv4();
  let newQty;

  if (type === 'adjustment') {
    newQty = parseInt(qty);
  } else if (type === 'in') {
    newQty = product.stock_qty + parseInt(qty);
  } else {
    newQty = product.stock_qty - parseInt(qty);
  }

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, type, qty, reason, reference_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(movId, req.params.id, type, parseInt(qty), reason || null, reference_id || null, req.user.id);

    db.prepare(`UPDATE products SET stock_qty=?, updated_at=datetime('now') WHERE id = ?`)
      .run(newQty, req.params.id);
  });
  run();

  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
});

// DELETE /api/products/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found' });
  db.prepare("UPDATE products SET active=0, deleted_at=datetime('now'), updated_at=datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ message: 'Deleted' });
});

export default router;
