/**
 * 022 — la « Commande » d'un envoi devient un lien qu'on peut défaire.
 *
 * `shipments.order_id` était `NOT NULL` depuis la création de la table : un
 * envoi naissait forcément rattaché à une commande et ne pouvait plus s'en
 * détacher. Conséquences visibles :
 *   - la fiche envoi n'offrait aucun bouton « délier » (allowClear={false}) ;
 *   - le PATCH refusait `order_id: null` en 400 ;
 *   - et surtout, un envoi délié DANS AIRTABLE (« Commande lié » vidé) faisait
 *     échouer l'UPDATE du sync entrant sur la contrainte — le champ est
 *     bidirectionnel depuis 015, mais un seul des deux sens savait se vider.
 *
 * Le lien reste une FK (une commande inexistante est toujours refusée), il
 * devient seulement facultatif.
 *
 * Méthode : réécriture du DDL en place (`writable_schema`) plutôt que la
 * reconstruction en 12 étapes. SQLite ne sait pas retirer un NOT NULL par
 * ALTER, et le chemin classique (table_new + copie + DROP + RENAME) est ici
 * hostile : `order_items.shipment_id` référence `shipments`, donc le DROP
 * accumule des violations de FK différées que le RENAME ne solde pas (échec au
 * COMMIT), et il faudrait recréer index et triggers de journalisation. La
 * réécriture ne touche aucune page de données : index, triggers `chl_shipments_*`
 * et rowids sont préservés, et seul le texte du CREATE TABLE change.
 *
 * `schema_version` est incrémenté pour que le schéma soit relu ; la relecture
 * est forcée DANS la transaction (PRAGMA table_info + SELECT), si bien qu'un
 * DDL qui ne reparse pas fait échouer la migration et laisse la base intacte.
 */
export const id = '022-shipments-order-nullable'
export const description = 'envois : le lien « Commande » (order_id) devient facultatif'

export function up(db) {
  const col = db.prepare('PRAGMA table_info(shipments)').all().find(c => c.name === 'order_id')
  if (!col) throw new Error('shipments.order_id est absent de la table')
  if (col.notnull === 0) return { skipped: 'order_id déjà facultatif' }

  const cur = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='shipments'").get()?.sql
  if (!cur) throw new Error('DDL de shipments illisible')
  const next = cur.replace(/(\border_id\s+TEXT)\s+NOT\s+NULL/i, '$1')
  if (next === cur) throw new Error("NOT NULL introuvable dans le DDL de shipments.order_id — DDL inattendu, rien n'est modifié")

  const version = db.pragma('schema_version', { simple: true })
  db.unsafeMode(true)
  try {
    db.pragma('writable_schema = ON')
    db.prepare("UPDATE sqlite_master SET sql=? WHERE type='table' AND name='shipments'").run(next)
    db.pragma(`schema_version = ${version + 1}`)
  } finally {
    db.pragma('writable_schema = OFF')
    db.unsafeMode(false)
  }

  // Relecture du schéma : lève (et annule tout) si le DDL réécrit ne parse pas
  // ou si la contrainte est toujours là.
  const after = db.prepare('PRAGMA table_info(shipments)').all().find(c => c.name === 'order_id')
  if (!after || after.notnull !== 0) throw new Error('order_id est resté NOT NULL après réécriture du DDL')
  db.prepare('SELECT COUNT(*) AS c FROM shipments').get()

  return { ok: true }
}
