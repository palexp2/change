/** Suppression définitive du champ « Coût unitaire actuel » des articles. */
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '068-drop-order-items-unit-cost'
export const description = 'Articles : suppression définitive du coût unitaire actuel et de son import Airtable'

export function up(d) {
  const dependent = d.prepare(`
    SELECT erp_table, name FROM custom_fields WHERE deleted_at IS NULL AND (
      (lookup_target_table='order_items' AND lookup_target_column='unit_cost') OR
      (rollup_target_table='order_items' AND rollup_target_column='unit_cost') OR
      (erp_table='order_items' AND kind='formula' AND formula_expr LIKE '%unit_cost%')
    )
  `).get()
  if (dependent) throw new Error(`Champ dépendant à adapter : ${dependent.erp_table}.${dependent.name}`)

  if (d.pragma('table_info(order_items)').some(c => c.name === 'unit_cost')) {
    // Conserver le repli historique des articles déjà rattachés à un envoi,
    // sans écraser aucun coût gelé. Les futurs envois lisent le coût produit.
    d.exec(`UPDATE order_items SET shipped_unit_cost=unit_cost
      WHERE shipment_id IS NOT NULL AND shipped_unit_cost IS NULL AND unit_cost > 0`)
    d.exec('DROP VIEW IF EXISTS order_items_v')
    d.exec('ALTER TABLE order_items DROP COLUMN unit_cost')
  }

  d.prepare("DELETE FROM custom_fields WHERE erp_table='order_items' AND column_name='unit_cost'").run()
  if (d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='airtable_field_defs'").get()) {
    d.prepare("DELETE FROM airtable_field_defs WHERE erp_table='order_items' AND column_name='unit_cost'").run()
  }
  d.prepare(`INSERT INTO purged_fields (erp_table, column_name, label, dropped)
    VALUES ('order_items', 'unit_cost', 'Coût unitaire actuel', 1)
    ON CONFLICT(erp_table, column_name) DO UPDATE SET dropped=1`).run()

  // Garder l'exclusion dans le registre : les syncs ne doivent pas recréer le champ.
  d.prepare(`UPDATE airtable_field_mappings SET import_disabled=1
    WHERE erp_table='order_items' AND column_name='unit_cost'`).run()
  d.prepare(`DELETE FROM airtable_field_directions
    WHERE module='order_items' AND field_key IN ('unit_cost', 'dyn:unit_cost')`).run()
  d.prepare(`UPDATE airtable_field_map SET state='excluded', direction='none',
    erp_column=NULL, core_key=NULL, decided_by='user',
    exclude_reason='Champ ERP supprimé définitivement (migration 068)',
    decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE mirror_id='order_items' AND
      (core_key='unit_cost' OR erp_column='unit_cost' OR field_name='Coût unitaire actuel')`).run()
  for (const row of d.prepare('SELECT rowid AS _rowid, field_map_items FROM airtable_orders_config').all()) {
    const map = JSON.parse(row.field_map_items || '{}')
    delete map.unit_cost
    d.prepare('UPDATE airtable_orders_config SET field_map_items=? WHERE rowid=?').run(JSON.stringify(map), row._rowid)
  }

  // Dispositions, tris et filtres sauvegardés : retirer les références au champ.
  for (const table of ['table_view_configs', 'table_view_pills', 'detail_field_configs']) {
    const scope = table === 'detail_field_configs' ? 'entity_type' : 'table_name'
    for (const row of d.prepare(`SELECT rowid AS _rowid, * FROM ${table}
      WHERE ${scope} IN ('order_items', 'orders_items')`).all()) {
      const patch = {}
      for (const key of ['visible_columns', 'sort', 'default_sort', 'filters', 'color_rules', 'column_widths', 'footer_aggregations', 'field_order']) {
        if (!row[key]) continue
        const value = JSON.parse(row[key])
        const cleaned = cleanLayout(value)
        if (JSON.stringify(value) !== JSON.stringify(cleaned)) patch[key] = JSON.stringify(cleaned)
      }
      if (row.group_by === 'unit_cost') patch.group_by = null
      const keys = Object.keys(patch)
      if (keys.length) d.prepare(`UPDATE ${table} SET ${keys.map(k => `${k}=?`).join(',')} WHERE rowid=?`)
        .run(...Object.values(patch), row._rowid)
    }
  }
  regenerateView('order_items')
  return { dropped: 'order_items.unit_cost' }
}

function cleanLayout(value) {
  if (Array.isArray(value)) return value
    .filter(item => item !== 'unit_cost' && !['field', 'column', 'id', 'key'].some(k => item?.[k] === 'unit_cost'))
    .map(cleanLayout)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'unit_cost')
    .map(([key, item]) => [key, cleanLayout(item)]))
  return value
}
