import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { emitEntity } from '../services/realtimeEmitters.js'
import { writeBackRecord } from '../services/airtableWriteback.js'
import { logSync } from '../services/syncLog.js'
import { buildExternalLinks } from '../services/externalLinks.js'

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

// POST / — crée un achat INTERNE (≠ Airtable). Étape 4 « Priorité d'assemblage ».
// Champs auto : supplier (depuis le produit), order_date = maintenant (ISO UTC Z),
// status='Commandé', reference = LIA-ERP-n générée, unit_cost (depuis le produit).
router.post('/', (req, res) => {
  const { product_id, qty_ordered, notes } = req.body
  if (!product_id) return res.status(400).json({ error: 'product_id is required' })
  const qty = parseInt(qty_ordered, 10)
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'qty_ordered must be a positive integer' })

  const product = db.prepare('SELECT id, supplier, supplier_company_id, unit_cost FROM products WHERE id = ?').get(product_id)
  if (!product) return res.status(404).json({ error: 'Product not found' })

  // Génération de la référence + insertion dans une même transaction (évite les
  // collisions de séquence si deux créations arrivent quasi simultanément).
  const id = uuidv4()
  const created = db.transaction(() => {
    const reference = nextErpPurchaseReference()
    db.prepare(`
      INSERT INTO purchases (id, product_id, supplier, supplier_company_id, reference, order_date, qty_ordered, unit_cost, status, notes)
      VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, 'Commandé', ?)
    `).run(id, product_id, product.supplier || null, product.supplier_company_id || null, reference, qty, product.unit_cost || 0, notes || null)
    return db.prepare('SELECT * FROM purchases WHERE id = ?').get(id)
  })()

  emitEntity('purchase', 'created', id, created, req.user?.id)
  res.status(201).json(created)
})

router.get('/', (req, res) => {
  const { status, product_id, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  let where = 'WHERE 1=1'
  const params = []

  if (status) { where += ' AND p.status = ?'; params.push(status) }
  if (product_id) { where += ' AND p.product_id = ?'; params.push(product_id) }

  const total = db.prepare(`SELECT COUNT(*) as c FROM purchases p ${where}`).get(...params).c
  const purchases = db.prepare(`
    SELECT p.*, pr.name_fr as product_name, pr.sku, pr.image_url as product_image,
           c.name as supplier_company_name
    FROM purchases p
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
    SELECT p.*, pr.name_fr as product_name, pr.sku, pr.image_url as product_image,
           c.name as supplier_company_name
    FROM purchases p
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
  'expected_date',
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

  const updates = []
  const params = []
  const changedColumns = []
  for (const [key, raw] of Object.entries(req.body || {})) {
    if (!PATCHABLE_FIELDS.has(key)) continue
    changedColumns.push(key)
    let value = raw
    if (value === '' || value === undefined) value = null
    if (['qty_ordered', 'qty_received'].includes(key) && value !== null) {
      const n = parseInt(value, 10)
      if (Number.isNaN(n)) return res.status(400).json({ error: `${key} doit être un entier` })
      value = n
    }
    if (key === 'unit_cost' && value !== null) {
      const n = parseFloat(value)
      if (Number.isNaN(n)) return res.status(400).json({ error: 'unit_cost doit être un nombre' })
      value = n
    }
    updates.push(`${key} = ?`)
    params.push(value)
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Aucun champ modifiable fourni' })

  updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
  params.push(req.params.id)
  db.prepare(`UPDATE purchases SET ${updates.join(', ')} WHERE id = ?`).run(...params)

  const updated = db.prepare(`
    SELECT p.*, pr.name_fr as product_name, pr.sku, pr.image_url as product_image,
           c.name as supplier_company_name
    FROM purchases p
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
