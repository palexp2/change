import { regenerateView } from '../../services/customFieldsView.js'

export const id = '080-orders-recent-shipment-date'
export const description = 'Commandes envoyées : utiliser la date affichée des envois et actualiser le cache'

export function up(db) {
  // « Date » des envois est un created_time (created_at). Le rollup lisait
  // shipped_at, un autre champ souvent vide, notamment pour ENV-1725 de
  // Black Creek. Garder le même champ de commande conserve les vues et tris.
  const result = db.prepare(`
    UPDATE custom_fields SET rollup_target_column='created_at',
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE erp_table='orders' AND column_name='cf_date_de_l_envoi_le_plus_recent'
      AND deleted_at IS NULL AND kind='rollup' AND rollup_agg='MAX'
      AND rollup_target_table='shipments' AND rollup_target_fk='order_id'
      AND rollup_target_column='shipped_at'
  `).run()
  if (result.changes) regenerateView('orders')

  // Les imports comme les éditions doivent transmettre le nouveau rollup
  // au navigateur, même sans écriture dans la commande elle-même.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chl_shipments_order_date_ins
    AFTER INSERT ON shipments
    BEGIN
      INSERT INTO change_log (table_name, record_id, change_type)
      SELECT 'orders', id, 'upsert' FROM orders WHERE id = NEW.order_id;
    END;
    CREATE TRIGGER IF NOT EXISTS chl_shipments_order_date_upd
    AFTER UPDATE OF created_at, shipped_at, order_id, deleted_at ON shipments
    WHEN OLD.created_at IS NOT NEW.created_at OR OLD.shipped_at IS NOT NEW.shipped_at
      OR OLD.order_id IS NOT NEW.order_id OR OLD.deleted_at IS NOT NEW.deleted_at
    BEGIN
      INSERT INTO change_log (table_name, record_id, change_type)
      SELECT 'orders', id, 'upsert' FROM orders WHERE id IN (OLD.order_id, NEW.order_id);
    END;
    CREATE TRIGGER IF NOT EXISTS chl_shipments_order_date_del
    AFTER DELETE ON shipments
    BEGIN
      INSERT INTO change_log (table_name, record_id, change_type)
      SELECT 'orders', id, 'upsert' FROM orders WHERE id = OLD.order_id;
    END;
  `)
  if (result.changes) {
    db.prepare(`INSERT INTO change_log (table_name, record_id, change_type)
      SELECT 'orders', id, 'upsert' FROM orders WHERE deleted_at IS NULL`).run()
  }
  return { corrected_fields: result.changes }
}
