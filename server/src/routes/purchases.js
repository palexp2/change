import { Router } from 'express'
import { newRecordId } from '../utils/recordId.js'
import db from '../db/database.js'
import { readRelation } from '../services/customFieldsView.js'
import { requireAuth } from '../middleware/auth.js'
import { emitEntity } from '../services/realtimeEmitters.js'
import { writeBackRecord } from '../services/airtableWriteback.js'
import { logSync } from '../services/syncLog.js'
import { buildExternalLinks } from '../services/externalLinks.js'
import { parsePage } from '../utils/pagination.js'
import { buildPartialUpdate } from '../utils/partialUpdate.js'

const router = Router()
router.use(requireAuth)

// Attache les liens profonds vers le record source (Airtable « achats »).
function withExternalLinks(purchase) {
  if (!purchase) return purchase
  return { ...purchase, external_links: buildExternalLinks({ airtableModule: 'achats', airtableId: purchase.airtable_id }) }
}

// Filet pour le write-back ERP → Airtable lancé en fire-and-forget. writeBackRecord
// trace déjà ses propres échecs internes dans sync_log ; ce wrapper garantit qu'AUCUNE
// rejection résiduelle (throw inattendu hors de son try) ne soit avalée par un simple
// console.error — sinon l'achat garde son airtable_id en DB mais le champ Airtable
// n'est jamais mis à jour, 2-way sync rompu, sans aucune trace ni alerte durable.
// Aligné sur traceAirtablePush de shipments.js.
function traceAirtablePush(promise, trigger, recordId) {
  return promise.catch(e => {
    console.error(`${trigger} achats ${recordId} (async):`, e.message)
    logSync('achats', trigger, { status: 'error', error: `${recordId}: ${e.message}` })
  })
}

// Génère la prochaine référence d'achat interne ERP : LIA-ERP-1, LIA-ERP-2, …
// Séquence globale incrémentale, sans padding. Le segment « ERP » distingue
// volontairement les achats créés dans l'ERP des LIA-xxx synchronisés d'Airtable.
// Robuste aux trous : MAX(seq existante) + 1.
function nextErpPurchaseReference() {
  const rows = db.prepare("SELECT reference FROM purchases WHERE reference LIKE 'LIA-ERP-%'").all()
  let max = 0
  for (const { reference } of rows) {
    const m = /^LIA-ERP-(\d+)$/.exec(reference || '')
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return `LIA-ERP-${max + 1}`
}

const PURCHASE_STATUSES = ['Commandé', 'Reçu partiellement', 'Reçu', 'Annulé']

// POST / — crée un achat INTERNE (≠ Airtable). Étape 4 « Priorité d'assemblage »
// et formulaire « Nouvel achat » de /purchases.
// Seuls product_id et qty_ordered sont requis. Tout le reste a un défaut déduit :
// supplier / supplier_company_id / unit_cost (depuis le produit), order_date =
// maintenant (ISO UTC Z), status='Commandé', reference = LIA-ERP-n générée. Le
// formulaire peut surcharger chacun de ces défauts.
router.post('/', (req, res) => {
  const { product_id, qty_ordered, notes } = req.body
  if (!product_id) return res.status(400).json({ error: 'product_id is required' })
  const qty = parseInt(qty_ordered, 10)
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'qty_ordered must be a positive integer' })

  const product = db.prepare('SELECT id, supplier, supplier_company_id, unit_cost FROM products WHERE id = ?').get(product_id)
  if (!product) return res.status(404).json({ error: 'Product not found' })

  const blank = v => v === '' || v === undefined || v === null

  const status = blank(req.body.status) ? 'Commandé' : String(req.body.status)
  if (!PURCHASE_STATUSES.includes(status)) return res.status(400).json({ error: 'status invalide' })

  let unitCost = product.unit_cost || 0
  if (!blank(req.body.unit_cost)) {
    const n = parseFloat(req.body.unit_cost)
    if (Number.isNaN(n)) return res.status(400).json({ error: 'unit_cost doit être un nombre' })
    unitCost = n
  }

  // Fournisseur : l'entreprise choisie dans le formulaire l'emporte sur celle du
  // produit, et son nom repeuple la colonne texte `supplier` (affichée partout
  // où l'achat n'est pas lié).
  let supplierCompanyId = product.supplier_company_id || null
  let supplier = product.supplier || null
  if (!blank(req.body.supplier_company_id)) {
    supplierCompanyId = String(req.body.supplier_company_id)
    const company = db.prepare('SELECT name FROM companies WHERE id = ?').get(supplierCompanyId)
    if (!company) return res.status(400).json({ error: 'supplier_company_id inconnu' })
    supplier = company.name
  }
  if (!blank(req.body.supplier)) supplier = String(req.body.supplier).trim()

  const orderDate = blank(req.body.order_date) ? null : String(req.body.order_date)
  const receivedDate = blank(req.body.received_date) ? null : String(req.body.received_date)
  const emplacement = blank(req.body.emplacement) ? null : String(req.body.emplacement).trim()
  const refOverride = blank(req.body.reference) ? null : String(req.body.reference).trim()

  // Génération de la référence + insertion dans une même transaction (évite les
  // collisions de séquence si deux créations arrivent quasi simultanément).
  const id = newRecordId()
  const created = db.transaction(() => {
    const reference = refOverride || nextErpPurchaseReference()
    db.prepare(`
      INSERT INTO purchases (id, product_id, supplier, supplier_company_id, reference, order_date, received_date, qty_ordered, unit_cost, status, emplacement, notes)
      VALUES (?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?, ?, ?, ?, ?, ?)
    `).run(id, product_id, supplier, supplierCompanyId, reference, orderDate, receivedDate, qty, unitCost, status, emplacement, notes || null)
    return db.prepare('SELECT * FROM purchases WHERE id = ?').get(id)
  })()

  emitEntity('purchase', 'created', id, created, req.user?.id)
  res.status(201).json(created)
})

router.get('/', (req, res) => {
  const { status, product_id } = req.query
  const { page, limit, limitVal, offset } = parsePage(req.query, 50)
  let where = 'WHERE 1=1'
  const params = []

  if (status) { where += ' AND p.status = ?'; params.push(status) }
  if (product_id) { where += ' AND p.product_id = ?'; params.push(product_id) }

  const total = db.prepare(`SELECT COUNT(*) as c FROM purchases p ${where}`).get(...params).c
  const purchases = db.prepare(`
    SELECT p.*, pr.image_url as product_image,
           c.name as supplier_company_name
    FROM ${readRelation('purchases')} p
    LEFT JOIN products pr ON p.product_id = pr.id
    LEFT JOIN companies c ON p.supplier_company_id = c.id
    ${where}
    ORDER BY p.order_date DESC, p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: purchases, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/:id', (req, res) => {
  const purchase = db.prepare(`
    SELECT p.*, pr.image_url as product_image,
           c.name as supplier_company_name
    FROM ${readRelation('purchases')} p
    LEFT JOIN products pr ON p.product_id = pr.id
    LEFT JOIN companies c ON p.supplier_company_id = c.id
    WHERE p.id = ?
  `).get(req.params.id)
  if (!purchase) return res.status(404).json({ error: 'Not found' })
  res.json(withExternalLinks(purchase))
})

// Colonnes éditables via PATCH. Toute autre clé du body est ignorée.
const PATCHABLE_FIELDS = new Set([
  'status',
  'qty_ordered',
  'qty_received',
  'unit_cost',
  'order_date',
  'received_date',
  'reference',
  'supplier',
  'supplier_company_id',
  'emplacement',
  'notes',
])

router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM purchases WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })

  const body = req.body || {}
  const present = k => k in body && body[k] !== '' && body[k] != null
  for (const key of ['qty_ordered', 'qty_received']) {
    if (present(key) && Number.isNaN(parseInt(body[key], 10))) return res.status(400).json({ error: `${key} doit être un entier` })
  }
  if (present('unit_cost') && Number.isNaN(parseFloat(body.unit_cost))) return res.status(400).json({ error: 'unit_cost doit être un nombre' })
  const toInt = v => (v === '' || v == null ? null : parseInt(v, 10))
  const { setClause, values, cols: changedColumns } = buildPartialUpdate(body, {
    allowed: [...PATCHABLE_FIELDS],
    coerce: { qty_ordered: toInt, qty_received: toInt, unit_cost: v => (v === '' || v == null ? null : parseFloat(v)) },
  })
  if (!setClause) return res.status(400).json({ error: 'Aucun champ modifiable fourni' })

  db.prepare(`UPDATE purchases SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(...values, req.params.id)

  const updated = db.prepare(`
    SELECT p.*, pr.image_url as product_image,
           c.name as supplier_company_name
    FROM ${readRelation('purchases')} p
    LEFT JOIN products pr ON p.product_id = pr.id
    LEFT JOIN companies c ON p.supplier_company_id = c.id
    WHERE p.id = ?
  `).get(req.params.id)
  emitEntity('purchase', 'updated', req.params.id, updated, req.user?.id)

  // Write-back ERP → Airtable (pilote « achats »). Asynchrone, non bloquant :
  // l'édition ERP réussit même si Airtable est indisponible. La garde anti-boucle
  // empêche le webhook de retour de ré-écrire la valeur dans l'ERP.
  if (updated?.airtable_id) {
    traceAirtablePush(writeBackRecord('achats', req.params.id, changedColumns), 'erp-writeback', req.params.id)
  }

  res.json(withExternalLinks(updated))
})

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM purchases WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare('DELETE FROM purchases WHERE id = ?').run(req.params.id)
  emitEntity('purchase', 'deleted', req.params.id, { id: req.params.id }, req.user?.id)
  res.json({ success: true })
})

export default router
