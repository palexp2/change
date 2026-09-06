import { newRecordId } from '../utils/recordId.js'

// Crée les « achats » (table `purchases`, page /purchases) correspondant à un PO
// qui vient d'être envoyé au fournisseur. Règles :
//
//  • une ligne libre (sans product_id) ou un product_id inconnu ne peut pas
//    devenir un achat — la table est indexée par produit : ignorée et comptée ;
//  • plusieurs lignes du même produit sont FUSIONNÉES en un seul achat
//    (quantités additionnées, coût unitaire = moyenne pondérée) : deux achats du
//    même produit pour un même PO seraient des doublons à la réception ;
//  • quantité ≤ 0 → rien n'est commandé, donc pas d'achat ;
//  • coût unitaire absent du PO → repli sur le coût unitaire du produit, comme
//    la création d'achat interne (POST /api/purchases) ;
//  • renvoi du même PO (2e courriel, reprise après erreur) → les achats déjà
//    créés pour cette référence et ce produit ne sont pas recréés : le PDF peut
//    repartir deux fois, l'achat non.
//
// Retourne { ids, skipped: { no_product, zero_qty, already_created } }.
export function insertPurchasesFromPo(db, po, { supplierCompanyId = null, to = '' } = {}) {
  const skipped = { no_product: 0, zero_qty: 0, already_created: 0 }
  const productRow = db.prepare('SELECT id, unit_cost FROM products WHERE id = ?')

  // 1. Regroupement des lignes du PO par produit.
  const byProduct = new Map()
  for (const it of po.items || []) {
    const product = it.product_id ? productRow.get(it.product_id) : null
    if (!product) { skipped.no_product++; continue }
    const qty = Number(it.qty) || 0
    const rate = Number(it.rate) || 0
    const agg = byProduct.get(product.id) || { product, qty: 0, amount: 0 }
    agg.qty += qty
    agg.amount += qty * rate
    byProduct.set(product.id, agg)
  }

  // 2. Achats déjà créés pour cette référence de PO (garde anti-doublon au renvoi).
  const alreadyCreated = new Set(
    po.po_number
      ? db.prepare('SELECT product_id FROM purchases WHERE reference = ?').all(po.po_number).map(r => r.product_id)
      : []
  )

  const insert = db.prepare(`
    INSERT INTO purchases
      (id, product_id, supplier, supplier_company_id, reference, order_date,
       qty_ordered, qty_received, unit_cost, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'Commandé', ?)
  `)
  const note = `Créé automatiquement depuis PO ${po.po_number}${to ? ` envoyé à ${to}` : ''}.`
  const ids = []
  db.transaction(() => {
    for (const [productId, agg] of byProduct) {
      if (agg.qty <= 0) { skipped.zero_qty++; continue }
      if (alreadyCreated.has(productId)) { skipped.already_created++; continue }
      const unitCost = agg.amount > 0
        ? Math.round((agg.amount / agg.qty) * 10000) / 10000
        : (Number(agg.product.unit_cost) || 0)
      const id = newRecordId()
      insert.run(
        id,
        productId,
        po.supplier || null,
        supplierCompanyId,
        po.po_number,
        po.date,
        agg.qty,
        unitCost,
        note,
      )
      ids.push(id)
    }
  })()
  return { ids, skipped }
}
