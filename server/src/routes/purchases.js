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
import { getWritableCustomColumns, refusedAirtablePullKeys, AIRTABLE_PULL_EDIT_ERROR } from '../services/customFieldWritability.js'
import { describeLinkedPurchases, expenseLinesByPurchase } from '../services/purchaseLinkAudit.js'

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

// POST / — crée un achat INTERNE (≠ Airtable), depuis le formulaire
// « Nouvel achat » de /purchases.
//
// Il n'y a plus AUCUN champ requis : produit, référence, dates, quantité
// commandée, prix unitaire et notes ont vu leur colonne droppée sur demande
// (migration 035), la quantité reçue à son tour (036). Ce qu'un achat porte
// encore en natif : le fournisseur (`supplier_company_id`) et l'emplacement. Le
// reste se saisit dans les champs personnalisés de la table (/champs/purchases).
router.post('/', (req, res) => {
  const blank = v => v === '' || v === undefined || v === null

  let supplierCompanyId = null
  if (!blank(req.body.supplier_company_id)) {
    supplierCompanyId = String(req.body.supplier_company_id)
    const company = db.prepare('SELECT name FROM companies WHERE id = ?').get(supplierCompanyId)
    if (!company) return res.status(400).json({ error: 'supplier_company_id inconnu' })
  }

  const emplacement = blank(req.body.emplacement) ? null : String(req.body.emplacement).trim()

  const id = newRecordId()
  db.prepare(`
    INSERT INTO purchases (id, supplier_company_id, emplacement)
    VALUES (?, ?, ?)
  `).run(id, supplierCompanyId, emplacement)
  const created = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id)

  emitEntity('purchase', 'created', id, created, req.user?.id)
  res.status(201).json(created)
})

// Lecture d'un achat : la vue `purchases_v` (champs personnalisés compris) plus
// le nom de l'entreprise fournisseur. Le JOIN vers `products` est tombé avec
// `product_id` — il n'y a plus d'image de produit sur un achat.
const SELECT_PURCHASE = `
  SELECT p.*, c.name as supplier_company_name
  FROM ${readRelation('purchases')} p
  LEFT JOIN companies c ON p.supplier_company_id = c.id
`

router.get('/', (req, res) => {
  const { page, limit, limitVal, offset } = parsePage(req.query, 50)

  const total = db.prepare('SELECT COUNT(*) as c FROM purchases').get().c
  const purchases = db.prepare(`
    ${SELECT_PURCHASE}
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limitVal, offset)

  res.json({ data: purchases, total, page: parseInt(page), limit: parseInt(limit) })
})

// Achats désignés par les lignes d'une dépense (codes LIA) : date de commande, « À
// recevoir » ou non à la date de la dépense, autres dépenses qui désignent le même achat. Affiché à côté de
// chaque ligne dans « Modifier la dépense ».
router.get('/lia-links', (req, res) => {
  const refs = String(req.query.refs || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 100)
  const date = /^\d{4}-\d{2}-\d{2}/.test(String(req.query.date || '')) ? String(req.query.date).slice(0, 10) : null
  res.json(describeLinkedPurchases({ refs, expenseDate: date, excludeTxnKey: req.query.txn ? String(req.query.txn) : null }))
})

// Lignes de dépense (factures fournisseurs) reliées à chaque achat + prix unitaire
// payé qui en découle. `?ids=a,b` restreint ; sans ids : tous les achats reliés.
router.get('/expense-lines', (req, res) => {
  const ids = req.query.ids ? String(req.query.ids).split(',').map(s => s.trim()).filter(Boolean) : null
  res.json(expenseLinesByPurchase({ ids }))
})

router.get('/:id', (req, res) => {
  const purchase = db.prepare(`${SELECT_PURCHASE} WHERE p.id = ?`).get(req.params.id)
  if (!purchase) return res.status(404).json({ error: 'Not found' })
  res.json(withExternalLinks(purchase))
})

// Colonnes éditables via PATCH. Toute autre clé du body est ignorée.
const PATCHABLE_FIELDS = new Set([
  'supplier_company_id',
  'emplacement',
])

router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM purchases WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })

  const body = req.body || {}
  // Champs personnalisés : seuls ceux que l'ERP écrit (règle unique de
  // customFieldWritability) ; un champ Airtable en import seul → 400 explicite.
  if (refusedAirtablePullKeys('purchases', body).length > 0) {
    return res.status(400).json({ error: AIRTABLE_PULL_EDIT_ERROR })
  }
  const customCols = getWritableCustomColumns('purchases').map(c => c.column_name)
  // Réception complète : refusée tant qu'aucune facture n'est liée à l'achat
  // (l'effacer reste permis).
  const received = body.cf_date_de_reception_complete
  if (received != null && received !== '') {
    const info = expenseLinesByPurchase({ ids: [req.params.id] })[req.params.id]
    if (!info?.lines?.length && !info?.airtable_links?.length) {
      return res.status(400).json({ error: "Liez d'abord la facture avant d'inscrire la date de réception complète" })
    }
  }
  const { setClause, values, cols: changedColumns } = buildPartialUpdate(body, {
    allowed: [...PATCHABLE_FIELDS, ...customCols],
  })
  if (!setClause) return res.status(400).json({ error: 'Aucun champ modifiable fourni' })

  db.prepare(`UPDATE purchases SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(...values, req.params.id)

  const updated = db.prepare(`${SELECT_PURCHASE} WHERE p.id = ?`).get(req.params.id)
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
