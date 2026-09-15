/**
 * 054 — Numéros de série d'une ligne de commande : UN seul champ, alimenté.
 *
 * Demande de l'utilisateur (2026-09-10) : « que le champ actuellement visible
 * soit le seul qui reste et que le nécessaire soit fait pour y ajouter les
 * numéros de série à l'avenir ; que le champ actuellement dans la corbeille
 * soit supprimé définitivement ».
 *
 * DEUX CHAMPS PORTAIENT LA MÊME IDÉE :
 *  - « # de série » (`order_items.de_serie`, champ Airtable « Numéros de série »
 *    de la ligne de commande, sens `both`) — celui que la fiche affiche. Il ne
 *    se remplit que depuis Airtable ;
 *  - « N° de série » (`serials`), champ NATIF — un ALIAS de jointure, jamais une
 *    colonne : la route des commandes le fabrique en lisant
 *    `serial_numbers.order_item_id`. Retiré de `tableDefs.js` le 2026-09-03, sa
 *    ligne `custom_fields` dormait à la corbeille (cf. variante « alias de JOIN »
 *    de 046-drop-return-items-product-send : rien à DROP, la ligne suffit).
 *
 * D'où le symptôme rapporté : un scan de prélèvement écrit bien
 * `serial_numbers.order_item_id`, mais la colonne visible lit Airtable, et le
 * mapping `serials.order_item_id ↔ « Items commande »` était resté en sens
 * « Airtable → Boréal » — `pushSerialOrderItem` (routes/orders.js) ne poussait
 * donc rien. Les deux faces s'ignoraient.
 *
 * CE QUE FAIT CETTE MIGRATION :
 *  1. sens `both` sur `serials / dyn:order_item_id` (recette 049) — le scan
 *     renvoie désormais le rattachement dans « Items commande », et Airtable
 *     reflète le lien sur la ligne de commande, qui revient au sync suivant dans
 *     « # de série ». `order_item_id` est déjà déclaré dans `linkColumns` du
 *     module `serials` : il n'y avait que le sens à poser.
 *  2. suppression DÉFINITIVE de la ligne `custom_fields` du champ natif
 *     « N° de série ». Aucun `ALTER TABLE` : la colonne n'existe pas.
 *
 * Garde-fous (renvoient `skipped`, jamais d'exception — sinon le démarrage
 * s'arrête) : champ déjà absent, champ ressorti de la corbeille, sens déjà
 * choisi par l'utilisateur.
 */
import db from '../database.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '054-order-items-serials-single-field'
export const description =
  'serials/order_item_id en bidirectionnel ; champ natif « N° de série » (order_items.serials) détruit'

const TABLE = 'order_items'
const FIELD = 'serials'
// Les vues et pastilles sont rangées sous le nom de la RESSOURCE passée à
// `DataTable table=`, pas sous celui de la table SQL (piège de 028).
const VIEW_TABLES = ['order_items', 'orders_items']

export function up(migrationDb) {
  const d = migrationDb || db
  const out = {}

  // ── 1. Sens du rattachement à une ligne de commande ────────────────────────
  const mapped = d.prepare(`
    SELECT id FROM airtable_field_mappings
     WHERE erp_table='serial_numbers' AND column_name='order_item_id' AND import_disabled IS NOT 1
  `).get()
  if (!mapped) {
    out.direction = 'sauté : order_item_id sans mapping Airtable actif'
  } else {
    const existing = d.prepare(
      "SELECT direction FROM airtable_field_directions WHERE module='serials' AND field_key='dyn:order_item_id'"
    ).get()
    if (existing) {
      out.direction = `déjà réglé (${existing.direction})`
    } else {
      d.prepare(`
        INSERT INTO airtable_field_directions (module, field_key, direction)
        VALUES ('serials', 'dyn:order_item_id', 'both')
      `).run()
      out.direction = 'both'
    }
  }

  // ── 2. Destruction du champ natif jumeau ──────────────────────────────────
  const field = d.prepare(
    `SELECT id, deleted_at FROM custom_fields WHERE erp_table=? AND column_name=?`
  ).get(TABLE, FIELD)
  if (!field) return { ...out, field: 'déjà absent' }
  if (!field.deleted_at) return { ...out, field: 'sauté : champ ressorti de la corbeille' }

  // Un lookup / rollup qui viserait l'alias serait vidé en silence.
  const dependent = d.prepare(
    `SELECT erp_table, name FROM custom_fields
      WHERE deleted_at IS NULL
        AND ((lookup_target_table=? AND lookup_target_column=?)
          OR (rollup_target_table=? AND rollup_target_column=?))`
  ).get(TABLE, FIELD, TABLE, FIELD)
  if (dependent) return { ...out, field: `sauté : champ calculé dépendant (${dependent.erp_table}.${dependent.name})` }

  d.prepare(`DELETE FROM custom_fields WHERE id=?`).run(field.id)
  try {
    d.prepare(`DELETE FROM airtable_field_defs WHERE erp_table=? AND column_name=?`).run(TABLE, FIELD)
  } catch { /* table héritée absente */ }

  // Vues sauvegardées et pastilles : retirer la colonne de leur disposition.
  let cleaned = 0
  for (const view of VIEW_TABLES) {
    const cfg = d.prepare('SELECT table_name, visible_columns FROM table_view_configs WHERE table_name=?').get(view)
    if (cfg?.visible_columns) {
      let cols
      try { cols = JSON.parse(cfg.visible_columns) } catch { cols = null }
      if (Array.isArray(cols) && cols.includes(FIELD)) {
        d.prepare('UPDATE table_view_configs SET visible_columns=? WHERE table_name=?')
          .run(JSON.stringify(cols.filter(c => c !== FIELD)), view)
        cleaned++
      }
    }
    for (const pill of d.prepare('SELECT id, filters FROM table_view_pills WHERE table_name=?').all(view)) {
      let filters
      try { filters = JSON.parse(pill.filters) } catch { continue }
      if (!Array.isArray(filters)) continue
      const kept = filters.filter(f => f?.field !== FIELD && f?.column !== FIELD)
      if (kept.length !== filters.length) {
        d.prepare('UPDATE table_view_pills SET filters=? WHERE id=?').run(JSON.stringify(kept), pill.id)
        cleaned++
      }
    }
  }

  // Disposition de fiche (`detail_field_configs.field_order` = JSON
  // [{ key, hidden }]) : retirer l'entrée du champ détruit.
  const layout = d.prepare('SELECT entity_type, field_order FROM detail_field_configs WHERE entity_type=?').get(TABLE)
  if (layout?.field_order) {
    let order
    try { order = JSON.parse(layout.field_order) } catch { order = null }
    if (Array.isArray(order) && order.some(f => f?.key === FIELD)) {
      d.prepare('UPDATE detail_field_configs SET field_order=? WHERE entity_type=?')
        .run(JSON.stringify(order.filter(f => f?.key !== FIELD)), TABLE)
      cleaned++
    }
  }

  regenerateView(TABLE)

  return { ...out, field: `${TABLE}.${FIELD} détruit`, cleaned }
}
