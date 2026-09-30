import db from '../db/database.js'
import { applyCustomFieldDefaults } from '../routes/custom-fields.js'

// Défauts des champs personnalisés d'un article de commande neuf (ex. « Type
// de document » = Installation, réglé dans la configuration du champ). Une
// ligne de remplacement n'hérite pas du type de document par défaut.
export function applyOrderItemDefaults(itemId) {
  const item = db.prepare('SELECT item_type FROM order_items WHERE id=?').get(itemId)
  if (!item) return
  applyCustomFieldDefaults('order_items', itemId, {
    skip: item.item_type === 'Remplacement' ? ['cf_type_de_document'] : [],
  })
}
