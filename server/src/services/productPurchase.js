import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { parseFiniteNumber } from '../utils/validateNumbers.js'
import { readRelation } from './customFieldsView.js'
import { createInAirtable } from './airtableWriteback.js'
import { computedAirtableFieldNames } from './airtableFieldTypes.js'
import { getFrozenColumns } from './airtableFrozenColumns.js'
import { logSync } from './syncLog.js'

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }) }

function getProduct(id) {
  const product = db.prepare(`SELECT p.*, c.name AS supplier_company_name FROM products p
    LEFT JOIN companies c ON c.id=p.supplier_company_id WHERE p.id=?`).get(id)
  if (!product) fail('Produit introuvable', 404)
  return product
}

export function productPurchasePrefill(productId) {
  const product = getProduct(productId)
  // Les achats Airtable lient la table Fournisseurs, pas la table Entreprises.
  const suppliers = db.prepare(`SELECT v.airtable_id AS id, v.name, v.qb_vendor_id,
    (SELECT c.id FROM companies c WHERE lower(trim(c.name))=lower(trim(v.name)) LIMIT 1) AS company_id
    FROM airtable_vendor_links v WHERE v.name IS NOT NULL ORDER BY v.name`).all()
  const normalize = value => String(value || '').trim().toLowerCase()
  const primary = suppliers.find(s => normalize(s.name) === normalize(product.supplier_company_name))
    || suppliers.find(s => normalize(s.name) === normalize(product.supplier))
  const last = db.prepare(`SELECT supplier_vendor_name, supplier_qb_vendor_id FROM ${readRelation('purchases')}
    WHERE instr(COALESCE(nom_de_la_piece, ''), ?) > 0
       OR instr(COALESCE(nom_de_la_piece, ''), ?) > 0
    ORDER BY COALESCE(date_de_commande, created_at) DESC, created_at DESC LIMIT 1`)
    .get(product.airtable_id || product.id, product.id)
  const previous = last && suppliers.find(s =>
    (last.supplier_qb_vendor_id && s.qb_vendor_id === last.supplier_qb_vendor_id)
    || normalize(s.name) === normalize(last.supplier_vendor_name))
  return { suppliers, supplier_id: primary?.id || previous?.id || '', quantity: product.order_qty > 0 ? product.order_qty : 1 }
}

// Relit les mappings de l'interface : aucune colonne historique supprimée
// n'est recréée, et les libellés Airtable restent configurables.
function purchaseFields() {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE module='achats'").get()
  if (!config?.base_id || !config?.table_id) fail('La synchronisation Airtable des achats n’est pas configurée.')
  const mappings = db.prepare(`SELECT * FROM airtable_field_mappings
    WHERE erp_table='purchases' AND import_disabled IS NOT 1`).all()
  const physical = new Set(db.prepare('PRAGMA table_info(purchases)').all().map(c => c.name))
  const frozen = getFrozenColumns('purchases')
  const computed = computedAirtableFieldNames(config.base_id, config.table_id)
  const fields = {}
  for (const [key, column, label] of [
    ['product', 'nom_de_la_piece', 'Nom de la pièce'],
    ['quantity', 'quantite_commande', 'Quantité commandé'],
    ['date', 'date_de_commande', 'Date de commande'],
    ['notes', 'notes_2', 'Notes'],
    ['supplier', 'fournisseur', 'Fournisseur'],
  ]) {
    const mapping = mappings.find(m => m.column_name === column) || mappings.find(m => m.airtable_field_name === label)
    if (!mapping || !physical.has(mapping.column_name) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(mapping.column_name)
      || frozen.has(mapping.column_name) || computed.has(mapping.airtable_field_name)) {
      fail(`Le champ « ${label} » doit être configuré pour les achats.`)
    }
    fields[key] = mapping
  }
  return fields
}

export function createProductPurchase(productId, body) {
  const product = getProduct(productId)
  const quantity = parseFiniteNumber(body.quantity)
  if (quantity === null || quantity <= 0) fail('La quantité doit être supérieure à zéro.')
  if (body.notes != null && typeof body.notes !== 'string') fail('La note doit être du texte.')
  const supplier = db.prepare('SELECT * FROM airtable_vendor_links WHERE airtable_id=?').get(String(body.supplier_id || ''))
  if (!supplier) fail('Choisissez un fournisseur.')
  if (!product.airtable_id) fail('Ce produit doit être lié à Airtable avant d’ajouter un achat.')
  const fields = purchaseFields()
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? body.date : new Date().toISOString().slice(0, 10)
  const values = {
    product: JSON.stringify([product.airtable_id]), quantity,
    date, notes: (body.notes || '').trim(),
    supplier: JSON.stringify([supplier.airtable_id]),
  }
  const company = db.prepare('SELECT id FROM companies WHERE lower(trim(name))=lower(trim(?)) LIMIT 1').get(supplier.name)
  const id = newRecordId()
  const columns = Object.values(fields).map(f => f.column_name)
  db.prepare(`INSERT INTO purchases (id, supplier_company_id, supplier_vendor_name, supplier_qb_vendor_id,
    ${columns.map(c => `"${c}"`).join(', ')}) VALUES (?, ?, ?, ?, ${columns.map(() => '?').join(', ')})`)
    .run(id, company?.id || null, supplier.name, supplier.qb_vendor_id, ...Object.keys(fields).map(k => values[k]))
  return id
}

export async function syncProductPurchase(productId, purchaseId) {
  const product = getProduct(productId)
  const row = db.prepare(`SELECT * FROM ${readRelation('purchases')} WHERE id=?`).get(purchaseId)
  let links = []
  try { links = JSON.parse(row?.nom_de_la_piece || '[]') } catch {}
  if (!row || !Array.isArray(links) || !links.some(id => id === product.id || id === product.airtable_id)) fail('Achat introuvable pour ce produit', 404)
  if (row.airtable_id) return { status: 'success' }
  try {
    const fields = purchaseFields()
    const initialFields = Object.fromEntries(Object.entries(fields).map(([key, field]) => [
      field.airtable_field_name,
      ['product', 'supplier'].includes(key) ? JSON.parse(row[field.column_name]) : row[field.column_name],
    ]))
    const result = await createInAirtable('achats', purchaseId, { initialFields })
    if (result.ok) return { status: 'success' }
    if (result.error) return { status: 'error', error: result.error }
    throw new Error(result.skipped || 'Synchronisation impossible')
  } catch (error) {
    logSync('achats', 'erp-create', { status: 'error', error: `${purchaseId}: ${error.message}` })
    return { status: 'error', error: error.message }
  }
}

// Une ligne de PO sans product_id (ligne vide, libellé retapé) est rattachée au
// catalogue si son libellé ou son SKU désigne une seule pièce, sans ambiguïté.
function matchCatalogProduct(label) {
  const key = String(label || '').trim().toLowerCase()
  if (!key) return null
  const rows = db.prepare(`SELECT id FROM products WHERE deleted_at IS NULL AND (
    lower(trim(COALESCE(manufacturier, ''))) = ? OR lower(trim(COALESCE(name_fr, ''))) = ?
    OR lower(trim(COALESCE(name_en, ''))) = ? OR lower(trim(COALESCE(sku, ''))) = ?) LIMIT 2`).all(key, key, key, key)
  return rows.length === 1 ? rows[0].id : null
}

// Envoi d'un PO → un achat par ligne liée au catalogue, poussé vers Airtable
// comme depuis la section Achats de la fiche. Le courriel est déjà parti :
// rien ici ne doit faire échouer la réponse, chaque ligne rend son verdict.
export async function createPurchasesFromPo(po, mainProductId) {
  const purchaseIds = []
  const skipped = { no_product: 0, zero_qty: 0, already_created: 0, not_linked: 0, no_supplier: 0, error: 0 }
  const errors = []
  let mainSupplier = ''
  try { mainSupplier = productPurchasePrefill(mainProductId).supplier_id } catch {}
  const note = `PO ${po.po_number}`
  // Achats déjà nés d'un envoi précédent de ce même PO (renvoi du courriel).
  const previous = db.prepare(`SELECT nom_de_la_piece FROM ${readRelation('purchases')}
    WHERE trim(COALESCE(notes_2, '')) = ?`).all(note).map(r => r.nom_de_la_piece || '')
  for (const item of po.items || []) {
    const productId = item.product_id || matchCatalogProduct(item.product)
    const product = productId && db.prepare('SELECT id, airtable_id FROM products WHERE id=? AND deleted_at IS NULL').get(productId)
    if (!product) { skipped.no_product++; continue }
    if (!(Number(item.qty) > 0)) { skipped.zero_qty++; continue }
    if (!product.airtable_id) { skipped.not_linked++; continue }
    if (previous.some(links => links.includes(product.airtable_id))) { skipped.already_created++; continue }
    let supplierId = mainSupplier
    if (!supplierId) { try { supplierId = productPurchasePrefill(product.id).supplier_id } catch {} }
    if (!supplierId) { skipped.no_supplier++; continue }
    try {
      const id = createProductPurchase(product.id, { quantity: item.qty, supplier_id: supplierId, notes: note, date: po.date })
      const airtable = await syncProductPurchase(product.id, id)
      if (airtable.status === 'error') errors.push(airtable.error)
      purchaseIds.push(id)
    } catch (error) {
      skipped.error++
      errors.push(error.message)
    }
  }
  return { purchase_ids: purchaseIds, purchases_skipped: skipped, purchases_errors: [...new Set(errors)] }
}

export function readProductPurchase(id) {
  return db.prepare(`SELECT p.*, c.name AS supplier_company_name FROM ${readRelation('purchases')} p
    LEFT JOIN companies c ON c.id=p.supplier_company_id WHERE p.id=?`).get(id)
}
