import { v4 as uuidv4 } from 'uuid'

// Crée une ligne `purchases` (achat produit) par item du PO qui référence un produit existant.
// Les lignes libres (sans product_id) sont ignorées: la table purchases est indexée par produit.
// Retourne la liste des ids créés.
export function insertPurchasesFromPo(db, po, { supplierCompanyId = null, to = '' } = {}) {
  const purchaseIds = []
  const insert = db.prepare(`
    INSERT INTO purchases
      (id, product_id, supplier, supplier_company_id, reference, order_date,
       qty_ordered, qty_received, unit_cost, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'Commandé', ?)
  `)
  const note = `Créé automatiquement depuis PO ${po.po_number}${to ? ` envoyé à ${to}` : ''}.`
  const productExists = db.prepare('SELECT 1 FROM products WHERE id = ?')
  db.transaction(() => {
    for (const it of po.items || []) {
      if (!it.product_id) continue
      if (!productExists.get(it.product_id)) continue
      const id = uuidv4()
      insert.run(
        id,
        it.product_id,
        po.supplier || null,
        supplierCompanyId,
        po.po_number,
        po.date,
        Number(it.qty) || 0,
        Number(it.rate) || 0,
        note,
      )
      purchaseIds.push(id)
    }
  })()
  return purchaseIds
}
