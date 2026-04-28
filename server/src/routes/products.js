import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { buildPartialUpdate } from '../utils/partialUpdate.js';
import { buildPurchaseOrderPdf, fetchOrishaLogo } from '../services/purchaseOrderPdf.js';
import { sendEmail as sendGmail } from '../services/gmail.js';
import { insertPurchasesFromPo } from '../services/purchaseOrder.js';

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

  let supplier_company = null
  if (product.supplier_company_id) {
    supplier_company = db.prepare('SELECT id, name FROM companies WHERE id = ?').get(product.supplier_company_id) || null
  }

  res.json({ ...product, movements, supplier_company });
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

// PUT /api/products/:id — partial update
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found' });

  const { setClause, values, error } = buildPartialUpdate(req.body, {
    allowed: ['sku', 'name_fr', 'name_en', 'type', 'unit_cost', 'price_cad', 'price_usd',
      'monthly_price_cad', 'monthly_price_usd', 'is_sellable', 'min_stock', 'order_qty',
      'location', 'supplier', 'supplier_company_id', 'buy_via_po', 'procurement_type',
      'weight_lbs', 'notes', 'active', 'manufacturier', 'order_email',
      'role'],
    nonNullable: new Set(['name_fr']),
    coerce: {
      is_sellable: v => v ? 1 : 0,
      buy_via_po: v => v ? 1 : 0,
      active: v => v ? 1 : 0,
      order_email: v => v ? String(v).trim() : null,
    },
  });
  if (error) return res.status(400).json({ error });
  if (setClause) {
    db.prepare(`UPDATE products SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id);
  }

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

    db.prepare(`UPDATE products SET stock_qty=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(newQty, req.params.id);
  });
  run();

  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
});

// GET /api/products/:id/purchase-order/prefill
// Returns a default PO draft: supplier info, shipping defaults, and items = this product +
// other products from the same supplier with order_qty > 0. Also returns supplier_products
// (all parts linked to this supplier) so the UI can offer a picker to add more lines.
router.get('/:id/purchase-order/prefill', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  let supplier = null
  let contacts = []
  let currency = 'CAD'
  let lang = 'fr'
  let supplierProducts = []
  if (product.supplier_company_id) {
    supplier = db.prepare('SELECT id, name, currency, language FROM companies WHERE id = ?').get(product.supplier_company_id)
    if (supplier?.currency) currency = supplier.currency
    if (supplier?.language) lang = supplier.language === 'English' ? 'en' : 'fr'
    contacts = db.prepare(`
      SELECT id, first_name, last_name, email
      FROM contacts
      WHERE company_id = ? AND email IS NOT NULL AND email != '' AND deleted_at IS NULL
      ORDER BY created_at ASC
    `).all(product.supplier_company_id)
    supplierProducts = db.prepare(`
      SELECT id, sku, name_fr, name_en, manufacturier, order_qty, unit_cost
      FROM products
      WHERE supplier_company_id = ? AND deleted_at IS NULL
      ORDER BY name_fr
    `).all(product.supplier_company_id)
  }

  const po_number = `PO-${Date.now().toString(36).toUpperCase()}`
  const today = new Date().toISOString().slice(0, 10)

  const toLabel = (p) => p.manufacturier || p.name_fr || p.name_en || p.sku || ''
  const toItem = (p) => ({
    product_id: p.id,
    product: toLabel(p),
    qty: Number(p.order_qty) || 0,
    rate: Number(p.unit_cost) || 0,
  })

  const items = [
    { ...toItem(product), qty: Number(product.order_qty) || Number(product.quantite_a_commander) || 0 },
  ]
  for (const sp of supplierProducts) {
    if (sp.id === product.id) continue
    if ((Number(sp.order_qty) || 0) > 0) items.push(toItem(sp))
  }

  res.json({
    lang,
    po_number,
    date: today,
    currency,
    supplier: supplier?.name || product.supplier || '',
    supplier_email: product.order_email || contacts[0]?.email || null,
    supplier_contacts: contacts.map(c => ({
      id: c.id,
      name: [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.email,
      email: c.email,
    })),
    supplier_products: supplierProducts.map(sp => ({
      id: sp.id,
      sku: sp.sku || '',
      label: toLabel(sp),
      order_qty: Number(sp.order_qty) || 0,
      unit_cost: Number(sp.unit_cost) || 0,
    })),
    details: '',
    bill_to: {
      company: 'Automatisation Orisha inc.',
      address1: '1535 ch. Sainte-Foy, Bureau 220',
      address2: 'Québec QC G1S 2P1 CA',
      contact: 'Martin Audesse',
      phone: '(418) 386-0213',
      email: 'martin@orisha.io',
    },
    ship_to: {
      company: 'Automatisation Orisha inc.',
      address1: '1535 ch. Sainte-Foy, Bureau 220',
      address2: 'Québec QC G1S 2P1 CA',
      contact: 'Martin Audesse',
      phone: '(418) 386-0213',
      email: 'martin@orisha.io',
    },
    items,
  });
});

function normalizePoPayload(body) {
  const items = Array.isArray(body.items) ? body.items : []
  return {
    lang: body.lang === 'en' ? 'en' : 'fr',
    po_number: String(body.po_number || '').trim() || `PO-${Date.now().toString(36).toUpperCase()}`,
    date: body.date || new Date().toISOString().slice(0, 10),
    currency: body.currency || 'CAD',
    supplier: String(body.supplier || '').trim(),
    details: String(body.details || ''),
    bill_to: body.bill_to || {},
    ship_to: body.ship_to || {},
    items: items
      .map(it => ({
        product_id: it.product_id ? String(it.product_id) : null,
        product: String(it.product || '').trim(),
        qty: Number(it.qty) || 0,
        rate: Number(it.rate) || 0,
      }))
      .filter(it => it.product),
  }
}

// POST /api/products/:id/purchase-order/pdf — stream PDF (ephemeral, no persistence)
router.post('/:id/purchase-order/pdf', async (req, res) => {
  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  try {
    const po = normalizePoPayload(req.body)
    const logo = await fetchOrishaLogo()
    const pdf = await buildPurchaseOrderPdf({ ...po, logoBuffer: logo })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${po.po_number}.pdf"`)
    res.send(pdf)
  } catch (e) {
    console.error('PO PDF error:', e)
    res.status(500).json({ error: e.message })
  }
});

// POST /api/products/:id/purchase-order/send-email — build PDF + send via Gmail OAuth
router.post('/:id/purchase-order/send-email', async (req, res) => {
  const product = db.prepare('SELECT id, supplier_company_id FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const { to, cc, subject, body_html, from_account } = req.body || {}
  if (!to || !to.includes('@')) return res.status(400).json({ error: 'Adresse courriel invalide' })

  try {
    const po = normalizePoPayload(req.body.po || {})
    const logo = await fetchOrishaLogo()
    const pdf = await buildPurchaseOrderPdf({ ...po, logoBuffer: logo })

    const filename = `${po.po_number}.pdf`
    const finalSubject = (subject && String(subject).trim()) || `Purchase Order ${po.po_number}`
    const finalHtml = body_html && String(body_html).trim()
      ? String(body_html)
      : `<p>Bonjour,</p><p>Vous trouverez ci-joint notre bon de commande <strong>${po.po_number}</strong>.</p><p>Merci,<br>Automatisation Orisha inc.</p>`

    const result = await sendGmail(to, finalSubject, finalHtml, {
      cc: cc || undefined,
      attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
      userId: req.user?.id,
      accountEmail: from_account || undefined,
    })

    // Log interaction (outbound email to supplier)
    const companyId = product.supplier_company_id || null
    const contactId = companyId
      ? (db.prepare('SELECT id FROM contacts WHERE company_id=? AND email=? AND deleted_at IS NULL').get(companyId, to)?.id || null)
      : null
    const interactionId = uuidv4()
    const emailId = uuidv4()
    const senderUserId = db.prepare('SELECT id FROM users WHERE lower(email)=lower(?)').get(result.account_email)?.id || req.user?.id || null
    db.prepare(`
      INSERT INTO interactions (id, contact_id, company_id, user_id, type, direction, timestamp)
      VALUES (?, ?, ?, ?, 'email', 'out', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(interactionId, contactId, companyId, senderUserId)
    db.prepare(`
      INSERT INTO emails (id, interaction_id, subject, body_html, from_address, to_address, cc, gmail_message_id, gmail_thread_id, automated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(emailId, interactionId, finalSubject, finalHtml, result.account_email, to, cc || null, result.message_id, result.thread_id)

    // Créer un achat fournisseur (bill brouillon) à partir du PO envoyé
    const achatId = uuidv4()
    const subtotal = po.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.rate) || 0), 0)
    const linesJson = JSON.stringify(po.items.map(it => ({
      amount: (Number(it.qty) || 0) * (Number(it.rate) || 0),
      qty: Number(it.qty) || 0,
      rate: Number(it.rate) || 0,
      description: it.product,
    })))
    const descSummary = po.items.map(it => it.product).filter(Boolean).slice(0, 3).join(', ')
    db.prepare(`
      INSERT INTO achats_fournisseurs
        (id, type, date_achat, vendor, vendor_id, bill_number, reference, description,
         amount_cad, tax_cad, total_cad, amount_paid_cad, currency, exchange_rate,
         status, lines, notes)
      VALUES (?, 'bill', ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, 1, 'Brouillon', ?, ?)
    `).run(
      achatId,
      po.date,
      po.supplier || null,
      companyId,
      po.po_number,
      po.po_number,
      descSummary || null,
      subtotal,
      subtotal,
      po.currency || 'CAD',
      linesJson,
      `Créé automatiquement depuis PO ${po.po_number} envoyé à ${to}.${po.details ? ' ' + po.details : ''}`,
    )

    const purchaseIds = insertPurchasesFromPo(db, po, { supplierCompanyId: companyId, to })

    res.json({ success: true, interaction_id: interactionId, email_id: emailId, achat_id: achatId, purchase_ids: purchaseIds })
  } catch (e) {
    console.error('PO send-email error:', e)
    res.status(500).json({ error: e.message })
  }
});

// DELETE /api/products/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found' });
  db.prepare("UPDATE products SET active=0, deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(req.params.id);
  res.json({ message: 'Deleted' });
});

export default router;
