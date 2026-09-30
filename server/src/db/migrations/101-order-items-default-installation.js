/**
 * 101 — « Type de document » d'un article de commande : Installation par défaut.
 *
 * Marque le choix « Installation » comme défaut du champ (réglable ensuite
 * depuis la configuration du champ) et complète les articles vides des
 * commandes pas encore envoyées. Les lignes de remplacement ne sont pas
 * touchées ; l'historique envoyé non plus.
 */

export const id = '101-order-items-default-installation'
export const description = 'Type de document des articles de commande : Installation par défaut'

export function up(db) {
  const field = db.prepare(
    "SELECT id, options FROM custom_fields WHERE erp_table='order_items' AND column_name='cf_type_de_document' AND deleted_at IS NULL"
  ).get()
  if (!field?.options) return
  let opts
  try { opts = JSON.parse(field.options) } catch { return }
  const choice = opts?.choices?.find(c => c.label === 'Installation')
  if (!choice) return
  if (!opts.default_id) {
    opts.default_id = choice.id
    db.prepare("UPDATE custom_fields SET options=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
      .run(JSON.stringify(opts), field.id)
  }
  db.prepare(`
    UPDATE order_items SET cf_type_de_document = 'Installation'
    WHERE (cf_type_de_document IS NULL OR cf_type_de_document = '')
      AND COALESCE(item_type, '') <> 'Remplacement'
      AND order_id IN (SELECT id FROM orders WHERE deleted_at IS NULL AND COALESCE(status, '') <> 'Envoyé')
  `).run()
}
