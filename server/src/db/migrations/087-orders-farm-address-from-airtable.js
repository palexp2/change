/**
 * « Adresse de la ferme » d'une commande : deux colonnes, une seule réalité —
 * `farm_address_id` (Boréal) et le miroir du lien Airtable « Adresse de la
 * ferme (pour coordonnées géographiques) ». Elles ne se suivaient pas : la
 * fiche montrait la ferme vide sur ~240 commandes dont Airtable connaît
 * pourtant la ferme. Demande de Charles (2026-09-23).
 *
 * Remplit `farm_address_id` depuis le miroir quand il est vide et que l'adresse
 * Airtable est connue localement. Rien n'est poussé : Airtable a déjà la valeur.
 */
export const id = '087-orders-farm-address-from-airtable'
export const description = 'orders.farm_address_id rempli depuis le lien Airtable « Adresse de la ferme »'

const MIRROR = 'adresse_de_la_ferme_pour_coordonnees_geographiques'

export function up(db) {
  const cols = new Set(db.pragma('table_info(orders)').map(c => c.name))
  if (!cols.has(MIRROR) || !cols.has('farm_address_id')) return { skipped: 'colonnes absentes' }
  const rows = db.prepare(`SELECT id, ${MIRROR} AS link FROM orders WHERE farm_address_id IS NULL AND ${MIRROR} IS NOT NULL AND ${MIRROR} <> ''`).all()
  const find = db.prepare('SELECT id FROM adresses WHERE airtable_id = ? OR id = ?')
  const set = db.prepare('UPDATE orders SET farm_address_id = ? WHERE id = ? AND farm_address_id IS NULL')
  let filled = 0
  for (const row of rows) {
    let ids
    try { ids = JSON.parse(row.link) } catch { ids = String(row.link).split(',') }
    const key = (Array.isArray(ids) ? ids : [ids]).map(v => String(v ?? '').trim()).find(Boolean)
    const addr = key && find.get(key, key)
    if (addr) filled += set.run(addr.id, row.id).changes
  }
  return { filled, candidates: rows.length }
}
