import db from '../db/database.js'
import { applyCustomFieldDefaults } from '../routes/custom-fields.js'

// Défauts des champs personnalisés d'un article de commande neuf (ex. « Type
// de document » = Installation, réglé dans la configuration du champ). Une
// ligne de remplacement n'hérite pas du type de document par défaut : elle
// prend « Remplacement ».
export function applyOrderItemDefaults(itemId) {
  const item = db.prepare('SELECT item_type FROM order_items WHERE id=?').get(itemId)
  if (!item) return
  const replacement = item.item_type === 'Remplacement'
  applyCustomFieldDefaults('order_items', itemId, {
    skip: replacement ? ['cf_type_de_document'] : [],
  })
  // Colonne née d'Airtable, absente d'une base neuve.
  if (replacement && db.prepare('PRAGMA table_info(order_items)').all().some(c => c.name === 'cf_type_de_document')) {
    db.prepare("UPDATE order_items SET cf_type_de_document = 'Remplacement' WHERE id = ? AND (cf_type_de_document IS NULL OR cf_type_de_document = '')")
      .run(itemId)
  }
}
