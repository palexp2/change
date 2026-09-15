// Une seule instruction SQLite réserve le prochain numéro, y compris lorsque
// plusieurs connexions créent des bons simultanément. Ne jamais supprimer ces
// réservations : un PDF téléchargé peut déjà circuler chez un fournisseur.
export function reservePurchaseOrderNumber(db, productId) {
  const row = db.prepare(`
    INSERT INTO purchase_order_numbers (number, product_id)
    SELECT COALESCE(MAX(number), 999) + 1, ? FROM purchase_order_numbers
    RETURNING number
  `).get(productId)
  return String(row.number)
}

export function resolvePurchaseOrderNumber(db, productId, value) {
  const number = String(value ?? '').trim()
  if (!number) return reservePurchaseOrderNumber(db, productId)

  if (/^[1-9]\d*$/.test(number) && db.prepare(`
    SELECT 1 FROM purchase_order_numbers WHERE number = ? AND product_id = ?
  `).get(number, productId)) return number

  const error = new Error('Numéro de bon de commande invalide. Rouvrez le bon pour obtenir un numéro automatique.')
  error.status = 400
  throw error
}
