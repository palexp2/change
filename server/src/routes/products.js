import { Router } from 'express';
import { newRecordId } from '../utils/recordId.js';
import fs from 'fs';
import path from 'path';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { buildPartialUpdate } from '../utils/partialUpdate.js';
import { makeUpload } from '../utils/upload.js';
import { buildPurchaseOrderPdf, fetchOrishaLogo } from '../services/purchaseOrderPdf.js';
import { reservePurchaseOrderNumber, resolvePurchaseOrderNumber } from '../services/purchaseOrderNumber.js';
import { sendEmail as sendGmail } from '../services/gmail.js';
import { emitEntity } from '../services/realtimeEmitters.js';
import { parseFiniteInt, parsePositiveInt, parseNonNegativeInt } from '../utils/validateNumbers.js';
import { readRelation } from '../services/customFieldsView.js'
import { writeBackRecord, createInAirtable } from '../services/airtableWriteback.js'
import { uploadsPath, ensureUploadsDir } from '../config/uploads.js'
import { parsePage } from '../utils/pagination.js'
import { productPurchasePrefill, createProductPurchase, syncProductPurchase, readProductPurchase, createPurchasesFromPo } from '../services/productPurchase.js'
import { trackEmailHtml } from '../services/emailTracking.js'
import { purchaseUnitPrice, computeFifo, applyFifo } from '../services/fifoCost.js'
import { runFifoFullPass } from '../services/fifoCostWatcher.js'

const INSTALLATION_DOC_FIELDS = [
  { url: 'lien_pdf_installation_fr', local: 'lien_pdf_installation_fr_local', type: 'installation-fr' },
  { url: 'lien_pdf_installation_en', local: 'lien_pdf_installation_en_local', type: 'installation-en' },
  { url: 'lien_pdf_remplacement_fr', local: 'lien_pdf_remplacement_fr_local', type: 'remplacement-fr' },
  { url: 'lien_pdf_remplacement_en', local: 'lien_pdf_remplacement_en_local', type: 'remplacement-en' },
];

function productDocsDir() {
  return ensureUploadsDir('products', 'docs');
}

function deleteLocalDocSafe(relativePath) {
  if (!relativePath) return;
  const abs = uploadsPath(relativePath);
  const root = uploadsPath('products', 'docs');
  if (!abs.startsWith(root + path.sep)) return; // refuse à supprimer hors du dossier docs
  try { fs.unlinkSync(abs); } catch {}
}

// Un champ lien_pdf_* peut contenir plusieurs URLs séparées par virgules
// (cas Airtable où la pièce a plusieurs PDFs pour la même variante).
function splitUrls(raw) {
  if (!raw) return [];
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

// Google Drive `file/d/<ID>` et `open?id=<ID>` renvoient la page HTML du visualiseur
// au lieu du PDF. On les réécrit vers l'URL de téléchargement direct.
function normalizeDocUrl(url) {
  if (!url) return url;
  // https://drive.google.com/file/d/<ID>[/view][?...]
  let m = url.match(/^https?:\/\/drive\.google\.com\/file\/d\/([^/?#]+)/i);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  // https://drive.google.com/open?id=<ID>
  m = url.match(/^https?:\/\/drive\.google\.com\/open\?(?:.*&)?id=([^&#]+)/i);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  // https://drive.google.com/uc?id=<ID>... sans export=download → on l'ajoute
  m = url.match(/^https?:\/\/drive\.google\.com\/uc\?/i);
  if (m && !/[?&]export=download(?:&|$)/i.test(url)) {
    return url + (url.includes('?') ? '&' : '?') + 'export=download';
  }
  return url;
}

const router = Router();
router.use(requireAuth);

// GET /api/products
router.get('/', (req, res) => {
  const { search, type, procurement_type, low_stock, active } = req.query;
  const { page, limit, limitVal, offset } = parsePage(req.query, 100);

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
    `SELECT products.*, (SELECT issue_count FROM product_fifo f WHERE f.product_id = products.id) AS fifo_issue_count
     FROM products ${where} ORDER BY name_fr LIMIT ? OFFSET ?`
  ).all(...params, limitVal, offset);

  res.json({ data: products, total, page: parseInt(page), limit: parseInt(limit) });
});

// Coût FIFO (services/fifoCost.js) : pièces en alerte, et recalcul complet
// à la demande (relit aussi les prix d'achat dans Airtable).
router.get('/fifo/alerts', (req, res) => {
  const rows = db.prepare(`
    SELECT f.product_id, f.cost, f.qty, f.uncovered, f.issues, f.issue_count, f.computed_at, p.sku, p.name_fr
    FROM product_fifo f JOIN products p ON p.id = f.product_id
    WHERE f.issue_count > 0 AND p.deleted_at IS NULL ORDER BY p.name_fr
  `).all()
  res.json({ data: rows.map(r => ({ ...r, issues: JSON.parse(r.issues || '[]') })) })
})

router.post('/fifo/recompute', async (req, res) => {
  try { res.json(await runFifoFullPass({ source: 'manuel' })) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/products/:id
router.get('/:id', (req, res) => {
  const product = db.prepare(`SELECT * FROM ${readRelation('products')} WHERE id = ?`).get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const movements = db.prepare(
    `SELECT sm.*, u.name as user_name FROM ${readRelation('stock_movements')} sm
     LEFT JOIN users u ON sm.user_id = u.id
     WHERE sm.product_id = ?
     ORDER BY sm.created_at DESC LIMIT 50`
  ).all(req.params.id);

  let supplier_company = null
  if (product.supplier_company_id) {
    supplier_company = db.prepare('SELECT id, name FROM companies WHERE id = ?').get(product.supplier_company_id) || null
  }

  const f = computeFifo(product.id);
  const fifo = f?.eligible ? { cost: f.cost, uncovered: f.uncovered, opening_cost: f.opening_cost, issues: f.issues } : null;
  res.json({ ...product, movements, supplier_company, fifo });
});

// GET /api/products/:id/purchases — les achats (PO du miroir Airtable
// « Achats ») qui citent cette pièce. `purchases.product_id` a été droppée
// (migration 035) : le lien vit dans le champ lien `nom_de_la_piece`, qui porte
// un (ou plusieurs) record ID Airtable, soit brut soit en tableau JSON. On
// cherche donc l'identifiant DANS le texte du champ — et aussi l'id ERP, au cas
// où une table cible serait posée un jour sur le mapping (elle réécrirait les
// valeurs, cf. link_target_table).
router.get('/:id/purchases', (req, res) => {
  const product = db.prepare('SELECT id, airtable_id FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const keys = [product.airtable_id, product.id].filter(Boolean);
  const where = keys.map(() => "instr(COALESCE(p.nom_de_la_piece, ''), ?) > 0").join(' OR ');
  const rows = db.prepare(`
    SELECT p.*, c.name as supplier_company_name
    FROM ${readRelation('purchases')} p
    LEFT JOIN companies c ON p.supplier_company_id = c.id
    WHERE ${where}
    ORDER BY COALESCE(p.date_de_commande, p.created_at) DESC
  `).all(...keys);

  // Quantité de chaque achat encore en stock selon le FIFO (null = épuisé).
  const inStock = new Map((computeFifo(product.id)?.layers || []).map(l => [l.purchase_id, l]))
  res.json({ data: rows.map(r => ({
    ...r,
    prix_unitaire: purchaseUnitPrice(r),
    fifo_qty: inStock.get(r.id)?.qty_in_stock ?? null,
    fifo_flag: inStock.get(r.id)?.flag ?? null,
    price_approved: inStock.get(r.id)?.approved ?? false,
  })) });
});

// Prix d'achat vérifié (alerte « prix douteux » levée) ou achat gratuit
// (alerte « sans prix » levée, compté à 0 $) / vérification annulée.
// Le prix est mémorisé : s'il change ensuite, l'alerte revient.
function setPriceApproval(req, res, approve) {
  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
  const purchase = db.prepare(`SELECT * FROM ${readRelation('purchases')} WHERE id = ?`).get(req.params.purchaseId);
  if (!product || !purchase) return res.status(404).json({ error: 'Achat introuvable' });
  if (approve) {
    // Achat sans prix : marqué gratuit (fournisseur qui ne facture pas), 0 $.
    const price = purchaseUnitPrice(purchase) ?? 0;
    db.prepare(`
      INSERT INTO purchase_price_approvals (purchase_id, unit_price, approved_by, approved_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(purchase_id) DO UPDATE SET unit_price=excluded.unit_price, approved_by=excluded.approved_by, approved_at=excluded.approved_at
    `).run(purchase.id, price, req.user?.id || null, new Date().toISOString());
  } else {
    db.prepare('DELETE FROM purchase_price_approvals WHERE purchase_id = ?').run(purchase.id);
  }
  // Seule l'alerte change ; un coût qui bougerait part vers Airtable à la minute.
  applyFifo(product.id);
  res.json({ ok: true });
}
// Coût unitaire de l'inventaire de départ (null = effacé).
router.put('/:id/opening-cost', (req, res) => {
  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const raw = req.body?.unit_cost;
  if (raw == null || raw === '') {
    db.prepare('DELETE FROM product_opening_costs WHERE product_id = ?').run(product.id);
  } else {
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'Coût invalide' });
    db.prepare(`
      INSERT INTO product_opening_costs (product_id, unit_cost, set_by, set_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(product_id) DO UPDATE SET unit_cost=excluded.unit_cost, set_by=excluded.set_by, set_at=excluded.set_at
    `).run(product.id, v, req.user?.id || null, new Date().toISOString());
  }
  // Un coût changé part vers Airtable à la minute (fifoCostWatcher).
  applyFifo(product.id);
  res.json({ ok: true });
});

router.post('/:id/purchases/:purchaseId/price-approval', (req, res) => setPriceApproval(req, res, true));
router.delete('/:id/purchases/:purchaseId/price-approval', (req, res) => setPriceApproval(req, res, false));


router.get('/:id/purchases/prefill', (req, res) => {
  res.json(productPurchasePrefill(req.params.id))
})

router.post('/:id/purchases', async (req, res) => {
  const id = createProductPurchase(req.params.id, req.body)
  const airtable = await syncProductPurchase(req.params.id, id)
  const created = readProductPurchase(id)
  emitEntity('purchase', 'created', id, created, req.user?.id)
  res.status(201).json({ ...created, airtable })
})

router.post('/:id/purchases/:purchaseId/sync', async (req, res) => {
  const airtable = await syncProductPurchase(req.params.id, req.params.purchaseId)
  const purchase = readProductPurchase(req.params.purchaseId)
  emitEntity('purchase', 'updated', purchase.id, purchase, req.user?.id)
  res.json({ ...purchase, airtable })
})

// POST /api/products
router.post('/', (req, res) => {
  const { sku, name_fr, name_en, type, unit_cost, price_cad, stock_qty, min_stock, order_qty, supplier, procurement_type, weight_lbs, notes } = req.body;
  if (!name_fr) return res.status(400).json({ error: 'name_fr is required' });

  const id = newRecordId();
  db.prepare(
    `INSERT INTO products (id, sku, name_fr, name_en, type, unit_cost, price_cad, stock_qty, min_stock, order_qty, supplier, procurement_type, weight_lbs, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, sku || null, name_fr, name_en || null, type || null,
    unit_cost || 0, price_cad || 0, stock_qty || 0, min_stock || 0, order_qty || 0,
    supplier || null, procurement_type || null, weight_lbs || 0, notes || null);

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  emitEntity('product', 'created', id, product, req.user?.id);
  res.status(201).json(product);
});

// Section « Ajustement d'inventaire » : champs poussés vers Airtable, où la
// formule « Quantité en inventaire » (et ses automatisations) vivent encore.
const AIRTABLE_ADJUSTMENT_COLUMNS = ['ajustement_manuel', 'raison_de_l_ajustement_manuel'];

// Liens PDF (installation / remplacement) : éditables depuis la fiche et
// repoussés vers Airtable, sinon le prochain sync les écraserait. Colonnes
// créées par le miroir : on ne retient que celles qui existent.
function docUrlColumns() {
  const cols = new Set(db.prepare('PRAGMA table_info(products)').all().map(c => c.name));
  return INSTALLATION_DOC_FIELDS.map(f => f.url).filter(c => cols.has(c));
}

// « Nom » d'Airtable est une formule (TRIM de « Nom modifiable ») : impossible à
// écrire, et le sync réimporte la formule par-dessus `name_fr`. Le nom saisi ici
// part donc dans « Nom modifiable », la vraie source.
function nameSourceColumn() {
  const cols = new Set(db.prepare('PRAGMA table_info(products)').all().map(c => c.name));
  return cols.has('nom_modifiable') ? 'nom_modifiable' : null;
}

// PUT /api/products/:id — partial update
router.put('/:id', async (req, res) => {
  const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found' });

  if ('ajustement_manuel' in req.body) {
    const v = req.body.ajustement_manuel;
    if (v !== null && v !== '' && parseFiniteInt(v) === null) {
      return res.status(400).json({ error: 'Ajustement manuel : nombre entier attendu' });
    }
  }

  const docCols = docUrlColumns();
  const docCoerce = Object.fromEntries(docCols.map(c => [c, v => (v ? String(v).trim() || null : null)]));
  const { setClause, values, error } = buildPartialUpdate(req.body, {
    allowed: ['sku', 'name_fr', 'name_en', 'type', 'unit_cost', 'price_cad', 'price_usd',
      'monthly_price_cad', 'monthly_price_usd', 'is_sellable', 'quote_farm_wide', 'min_stock', 'order_qty',
      'location', 'supplier', 'supplier_company_id', 'buy_via_po', 'procurement_type',
      'weight_lbs', 'notes', 'active', 'manufacturier', 'order_email',
      'role', 'purchase_snooze_until', ...AIRTABLE_ADJUSTMENT_COLUMNS, ...docCols],
    nonNullable: new Set(['name_fr']),
    coerce: {
      is_sellable: v => v ? 1 : 0,
      quote_farm_wide: v => v ? 1 : 0,
      buy_via_po: v => v ? 1 : 0,
      active: v => v ? 1 : 0,
      order_email: v => v ? String(v).trim() : null,
      ajustement_manuel: v => (v === null || v === '' ? null : parseFiniteInt(v)),
      raison_de_l_ajustement_manuel: v => (v ? String(v) : null),
      ...docCoerce,
    },
  });
  if (error) return res.status(400).json({ error });
  if (setClause) {
    db.prepare(`UPDATE products SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id);
  }
  const nameSource = 'name_fr' in req.body ? nameSourceColumn() : null;
  if (nameSource) {
    db.prepare(`UPDATE products SET ${nameSource} = name_fr WHERE id = ?`).run(req.params.id);
  }

  // Attendu (et non fire-and-forget) : un échec Airtable doit se voir dans la
  // fiche, sinon l'ajustement resterait local et serait écrasé au prochain sync.
  const pushCols = [...AIRTABLE_ADJUSTMENT_COLUMNS, ...docCols].filter(c => c in req.body);
  if (nameSource) pushCols.push(nameSource);
  const airtable = pushCols.length ? await writeBackRecord('pieces', req.params.id, pushCols) : undefined;

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  emitEntity('product', 'updated', req.params.id, updated, req.user?.id);
  res.json(airtable ? { ...updated, airtable } : updated);
});

// POST /api/products/:id/stock — adjust stock
router.post('/:id/stock', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const { qty, allow_negative } = req.body;
  let { type, reason } = req.body;
  // Forme de la modale : le « Type » d'Airtable (`reason`) + la variation
  // signée (`change`), comme « Changement » dans Airtable. Le sens se déduit
  // comme à l'import : libellé « Ajustement… », sinon le signe.
  const hasChange = req.body.change !== undefined && req.body.change !== null;
  if (hasChange) {
    const change = parseFiniteInt(req.body.change);
    if (!change) return res.status(400).json({ error: 'change must be a non-zero integer' });
    if (!reason) return res.status(400).json({ error: 'reason is required' });
    if (/ajustement/i.test(reason)) {
      type = 'adjustment';
      reason = change < 0 ? 'Ajustement (diminution)' : 'Ajustement (augmentation)';
    } else {
      type = change > 0 ? 'in' : 'out';
    }
    const newQty = product.stock_qty + change;
    if (newQty < 0 && !allow_negative) {
      return res.status(400).json({ error: `Resulting stock would be negative (${newQty}). Set allow_negative to force.` });
    }
    const movId = newRecordId();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO stock_movements (id, product_id, type, qty, reason, user_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(movId, req.params.id, type, Math.abs(change), reason, req.user.id);
      db.prepare(`UPDATE products SET stock_qty=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
        .run(newQty, req.params.id);
    })();
    createInAirtable('stock_movements', movId, { rowOverrides: { signed_change: change } });
    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    emitEntity('product', 'updated', req.params.id, updated, req.user?.id);
    return res.json(updated);
  }

  if (!type || !['in', 'out', 'adjustment'].includes(type)) {
    return res.status(400).json({ error: 'type must be in|out|adjustment' });
  }
  if (qty === undefined || qty === null) {
    return res.status(400).json({ error: 'qty is required' });
  }

  const movId = newRecordId();
  let newQty;
  let movQty;

  // Validation impossible-by-design : aucune quantité NaN/décimale/négative ne
  // doit pouvoir corrompre l'inventaire. Le stock résultant ne peut pas passer
  // sous zéro sauf override explicite (`allow_negative`).
  if (type === 'adjustment') {
    // qty = niveau de stock absolu cible.
    const target = allow_negative ? parseFiniteInt(qty) : parseNonNegativeInt(qty);
    if (target === null) {
      return res.status(400).json({
        error: allow_negative
          ? 'qty must be a finite integer'
          : 'qty must be an integer >= 0 (set allow_negative to force a negative stock level)',
      });
    }
    newQty = target;
    // On journalise la quantité telle qu'entrée (niveau cible), comme avant —
    // ne pas changer la sémantique stockée dans stock_movements.qty.
    movQty = target;
  } else {
    // in/out : qty = montant du mouvement, strictement positif.
    const amount = parsePositiveInt(qty);
    if (amount === null) {
      return res.status(400).json({ error: 'qty must be a positive integer' });
    }
    newQty = type === 'in' ? product.stock_qty + amount : product.stock_qty - amount;
    if (newQty < 0 && !allow_negative) {
      return res.status(400).json({
        error: `Resulting stock would be negative (${newQty}). Set allow_negative to force.`,
      });
    }
    movQty = amount;
  }

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, type, qty, reason, user_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(movId, req.params.id, type, movQty, reason || null, req.user.id);

    db.prepare(`UPDATE products SET stock_qty=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(newQty, req.params.id);
  });
  run();

  // Vers Airtable si le sens des mouvements le demande (sinon ignoré). Un
  // ajustement garde le niveau cible dans `qty` : on passe la vraie variation.
  createInAirtable('stock_movements', movId, {
    rowOverrides: type === 'adjustment' ? { signed_change: newQty - product.stock_qty } : {},
  });

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  emitEntity('product', 'updated', req.params.id, updated, req.user?.id);
  res.json(updated);
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
    // Contacts liés au fournisseur : entreprise principale (legacy) OU lien
    // multiple contact_companies — un contact rattaché à plusieurs entreprises
    // doit aussi être proposé.
    contacts = db.prepare(`
      SELECT id, first_name, last_name, email, language
      FROM contacts ct
      WHERE (ct.company_id = ? OR EXISTS (
          SELECT 1 FROM contact_companies cc WHERE cc.contact_id = ct.id AND cc.company_id = ?))
        AND ct.email IS NOT NULL AND ct.email != '' AND ct.deleted_at IS NULL
      ORDER BY ct.created_at ASC
    `).all(product.supplier_company_id, product.supplier_company_id)
  }
  const contactLang = (c) => c?.language === 'English' ? 'en' : c?.language === 'French' ? 'fr' : null
  const supplierEmail = product.order_email || contacts[0]?.email || null
  // La langue du contact destinataire prime sur celle de l'entreprise.
  const recipient = contacts.find(c => c.email.toLowerCase() === String(supplierEmail || '').toLowerCase())
  if (contactLang(recipient)) lang = contactLang(recipient)

  // Les pièces importées peuvent n'avoir que le nom texte du fournisseur.
  // Le lien explicite reste prioritaire : un ancien libellé ne doit jamais
  // ramener une pièce désormais liée à une autre entreprise. Sans lien sur la
  // pièce de départ, on regroupe seulement les pièces au même fournisseur texte.
  if (product.supplier_company_id || product.supplier?.trim()) {
    supplierProducts = db.prepare(`
      SELECT id, sku, name_fr, name_en, manufacturier, order_qty, unit_cost, image_url
      FROM products
      WHERE deleted_at IS NULL AND (
        supplier_company_id = ?
        OR (
          COALESCE(supplier_company_id, '') = ''
          AND NULLIF(trim(supplier), '') IS NOT NULL
          AND lower(trim(supplier)) = lower(trim(?))
        )
      )
      ORDER BY name_fr
    `).all(product.supplier_company_id || null, product.supplier || null)
  }

  const po_number = reservePurchaseOrderNumber(db, product.id)
  res.setHeader('Cache-Control', 'no-store')
  const today = new Date().toISOString().slice(0, 10)

  const toLabel = (p) => p.manufacturier || p.name_fr || p.name_en || p.sku || ''
  const toItem = (p) => ({
    product_id: p.id,
    product: toLabel(p),
    qty: Number(p.order_qty) || 0,
    // Tarif à 0 par défaut (demande de Martin) : le coût du catalogue n'est
    // pas le prix négocié du PO, on le saisit à la main.
    rate: 0,
    image_url: p.image_url || null,
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
    supplier_email: supplierEmail,
    supplier_contacts: contacts.map(c => ({
      id: c.id,
      name: [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.email,
      email: c.email,
      lang: contactLang(c),
    })),
    supplier_products: supplierProducts.map(sp => ({
      id: sp.id,
      sku: sp.sku || '',
      label: toLabel(sp),
      order_qty: Number(sp.order_qty) || 0,
      unit_cost: Number(sp.unit_cost) || 0,
      image_url: sp.image_url || null,
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

function normalizePoPayload(body, productId) {
  const items = Array.isArray(body.items) ? body.items : []
  return {
    lang: body.lang === 'en' ? 'en' : 'fr',
    po_number: resolvePurchaseOrderNumber(db, productId, body.po_number),
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

  const po = normalizePoPayload(req.body || {}, product.id)
  const logo = await fetchOrishaLogo()
  const pdf = await buildPurchaseOrderPdf({ ...po, logoBuffer: logo })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="${po.po_number}.pdf"`)
  res.send(pdf)
});

// POST /api/products/:id/purchase-order/send-email — build PDF + send via Gmail OAuth
router.post('/:id/purchase-order/send-email', async (req, res) => {
  const product = db.prepare('SELECT id, supplier_company_id FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const { to, cc, subject, body_html, from_account } = req.body || {}
  if (!to || !to.includes('@')) return res.status(400).json({ error: 'Adresse courriel invalide' })

  const po = normalizePoPayload(req.body.po || {}, product.id)
  const logo = await fetchOrishaLogo()
  const pdf = await buildPurchaseOrderPdf({ ...po, logoBuffer: logo })

  const filename = `${po.po_number}.pdf`
  const finalSubject = (subject && String(subject).trim()) || `Purchase Order ${po.po_number}`
  const finalHtml = body_html && String(body_html).trim()
    ? String(body_html)
    : `<p>Bonjour,</p><p>Vous trouverez ci-joint notre bon de commande <strong>${po.po_number}</strong>.</p><p>Merci,<br>Automatisation Orisha inc.</p>`

  const emailId = newRecordId()
  const result = await sendGmail(to, finalSubject, trackEmailHtml(finalHtml, emailId), {
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
  const interactionId = newRecordId()
  const achatId = newRecordId()
  const senderUserId = db.prepare('SELECT id FROM users WHERE lower(email)=lower(?)').get(result.account_email)?.id || req.user?.id || null

  // L'email est déjà parti (side effect irréversible) : on regroupe toutes les
  // écritures DB qui en découlent (interaction, email, achat fournisseur, achats)
  // dans une seule transaction pour éviter des records orphelins si une écriture
  // tardive échoue. achats_fournisseurs = comptabilité, doit rester cohérent.
  const subtotal = po.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.rate) || 0), 0)
  const linesJson = JSON.stringify(po.items.map(it => ({
    amount: (Number(it.qty) || 0) * (Number(it.rate) || 0),
    qty: Number(it.qty) || 0,
    rate: Number(it.rate) || 0,
    description: it.product,
  })))
  const descSummary = po.items.map(it => it.product).filter(Boolean).slice(0, 3).join(', ')

  const persist = db.transaction(() => {
    db.prepare(`
      INSERT INTO interactions (id, contact_id, company_id, user_id, type, direction, timestamp)
      VALUES (?, ?, ?, ?, 'email', 'out', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(interactionId, contactId, companyId, senderUserId)
    db.prepare(`
      INSERT INTO emails (id, interaction_id, subject, body_html, from_address, to_address, cc, gmail_message_id, gmail_thread_id, automated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(emailId, interactionId, finalSubject, finalHtml, result.account_email, to, cc || null, result.message_id, result.thread_id)

    // Créer un achat fournisseur (bill brouillon) à partir du PO envoyé
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

  })
  persist()

  // Un achat (table `purchases`) par ligne liée au catalogue, via les champs
  // personnalisés et le push Airtable de la section Achats de la fiche produit.
  const purchases = await createPurchasesFromPo(po, product.id)
  for (const id of purchases.purchase_ids) emitEntity('purchase', 'created', id, readProductPurchase(id), req.user?.id)
  res.json({
    success: true,
    interaction_id: interactionId,
    email_id: emailId,
    achat_id: achatId,
    ...purchases,
  })
});

// POST /api/products/:id/refresh-installation-docs
// Pour chaque champ lien_pdf_* (qui peut contenir plusieurs URLs séparées par virgules) :
// supprime les anciennes copies locales, télécharge chaque URL séparément (suffixe -1/-2/…),
// sauvegarde dans uploads/products/docs/, met à jour la colonne *_local (CSV de chemins).
// Pour les champs vides : supprime les copies locales et vide la colonne *_local.
router.post('/:id/refresh-installation-docs', async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  productDocsDir();
  const results = [];
  const updates = {};

  for (const f of INSTALLATION_DOC_FIELDS) {
    const urls = splitUrls(product[f.url]);
    const oldLocals = splitUrls(product[f.local]);

    // Toujours supprimer toutes les anciennes copies locales en premier
    for (const oldLocal of oldLocals) deleteLocalDocSafe(oldLocal);

    if (urls.length === 0) {
      updates[f.local] = null;
      results.push({ field: f.url, status: 'cleared' });
      continue;
    }

    const newLocals = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const fetchUrl = normalizeDocUrl(url);
      const suffix = urls.length === 1 ? '' : `-${i + 1}`;
      try {
        const response = await fetch(fetchUrl, { redirect: 'follow' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        // Vérifie le magic byte PDF : si l'URL renvoie une page HTML
        // (visualiseur Google Drive, page de connexion, etc.) on refuse.
        if (buffer.slice(0, 4).toString('ascii') !== '%PDF') {
          throw new Error('Réponse non-PDF (probablement une page HTML — le document est peut-être privé ou le lien n\'est pas un PDF direct)');
        }
        const filename = `${product.id}-${f.type}${suffix}.pdf`;
        const absPath = path.join(productDocsDir(), filename);
        fs.writeFileSync(absPath, buffer);
        const relativePath = path.posix.join('products', 'docs', filename);
        newLocals.push(relativePath);
        results.push({ field: f.url, index: i, url, status: 'downloaded', local: relativePath, bytes: buffer.length });
      } catch (e) {
        results.push({ field: f.url, index: i, url, status: 'error', error: e.message });
      }
    }
    updates[f.local] = newLocals.length ? newLocals.join(',') : null;
  }

  // Persiste tous les chemins locaux
  const setClause = INSTALLATION_DOC_FIELDS.map(f => `${f.local} = ?`).join(', ');
  const values = INSTALLATION_DOC_FIELDS.map(f => updates[f.local]);
  db.prepare(`UPDATE products SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(...values, req.params.id);

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  emitEntity('product', 'updated', req.params.id, updated, req.user?.id);
  res.json({ product: updated, results });
});

// ── Image du produit ────────────────────────────────────────────────────────
//
// Jusqu'ici `products.image_url` n'était rempli QUE par le miroir Airtable
// (pièce jointe « Image » de la table Pièces) : un produit créé dans l'ERP, ou
// une pièce dont la fiche Airtable n'a pas d'image, n'avait aucun moyen d'en
// obtenir une — d'où les cellules « Image » vides dans les tableaux (articles
// de commande, nomenclature, catalogue).
//
// Les fichiers déposés ici portent le préfixe `local-` : c'est ce qui les
// distingue des copies du miroir (nommées `<recAirtable>.<ext>`) et ce qui
// empêche la prochaine synchro de les écraser (cf. piecesPrepareImages).
const PRODUCT_IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg'];

function productImagesDir() {
  return ensureUploadsDir('products');
}

const productImageUpload = makeUpload({
  destination: (req, file, cb) => { try { cb(null, productImagesDir()); } catch (e) { cb(e); } },
  filename: (req, file) => `local-${req.params.id}${path.extname(file.originalname).toLowerCase()}`,
  fileSize: 10 * 1024 * 1024,
  allowedExt: PRODUCT_IMAGE_EXT,
  rejectMessage: ext => `Image non supportée : ${ext || 'sans extension'}`,
}).single('file');

// Ne supprime du disque que les dépôts manuels : un fichier du miroir Airtable
// n'est pas à nous, et la synchro ne le re-télécharge pas s'il existe déjà.
function unlinkLocalProductImage(imageUrl) {
  const name = String(imageUrl || '').split('/').pop();
  if (!name.startsWith('local-')) return;
  try { fs.unlinkSync(path.join(productImagesDir(), name)); } catch { /* déjà parti */ }
}

// POST /api/products/:id/image — dépose (ou remplace) l'image du produit.
router.post('/:id/image', (req, res) => {
  const existing = db.prepare('SELECT id, image_url FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found' });

  productImageUpload(req, res, (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message });
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });

    const imageUrl = `/erp/api/product-images/${req.file.filename}`;
    // Remplacement par un autre format (jpg → png) : l'ancien dépôt manuel
    // n'est plus référencé, on le retire.
    if (existing.image_url && existing.image_url !== imageUrl) unlinkLocalProductImage(existing.image_url);

    db.prepare("UPDATE products SET image_url = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(imageUrl, req.params.id);
    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    emitEntity('product', 'updated', req.params.id, updated, req.user?.id);
    res.json(updated);
  });
});

// DELETE /api/products/:id/image — retire l'image du produit.
router.delete('/:id/image', (req, res) => {
  const existing = db.prepare('SELECT id, image_url FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found' });
  unlinkLocalProductImage(existing.image_url);
  db.prepare("UPDATE products SET image_url = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(req.params.id);
  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  emitEntity('product', 'updated', req.params.id, updated, req.user?.id);
  res.json(updated);
});

// Une pièce ne se supprime que si plus rien ne la référence : nomenclature
// (elle-même assemblée, ou composant d'un autre produit) et envoi (une ligne de
// commande rattachée à un envoi). Sans ce garde-fou, la fiche disparaît de
// /products mais reste citée dans des BOM et des envois expédiés, qui affichent
// alors une pièce introuvable.
// Les achats ne sont plus un verrou : `purchases.product_id` a été droppée
// (migration 035), un achat ne cite plus aucune pièce.
function productDeleteBlockers(id) {
  const bom = db.prepare('SELECT COUNT(*) AS c FROM bom_items WHERE product_id = ? OR component_id = ?').get(id, id).c;
  const shipments = db.prepare(
    'SELECT COUNT(DISTINCT shipment_id) AS c FROM order_items WHERE product_id = ? AND shipment_id IS NOT NULL'
  ).get(id).c;
  return { bom, shipments };
}

function plural(n, one, many) { return `${n} ${n > 1 ? many : one}`; }

function blockersMessage(b) {
  const parts = [];
  if (b.bom) parts.push(plural(b.bom, 'ligne de nomenclature', 'lignes de nomenclature'));
  if (b.shipments) parts.push(plural(b.shipments, 'envoi', 'envois'));
  return `Pièce liée à ${parts.join(', ')} — suppression impossible.`;
}

// GET /api/products/:id/delete-check — ce qui empêche (ou non) la suppression.
router.get('/:id/delete-check', (req, res) => {
  const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found' });
  const blockers = productDeleteBlockers(req.params.id);
  const deletable = !blockers.bom && !blockers.shipments;
  res.json({ deletable, blockers, reason: deletable ? null : blockersMessage(blockers) });
});

// DELETE /api/products/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found' });
  const blockers = productDeleteBlockers(req.params.id);
  if (blockers.bom || blockers.shipments) {
    return res.status(409).json({ error: blockersMessage(blockers), blockers });
  }
  db.prepare("UPDATE products SET active=0, deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(req.params.id);
  emitEntity('product', 'deleted', req.params.id, { id: req.params.id }, req.user?.id);
  res.json({ message: 'Deleted' });
});

export default router;
