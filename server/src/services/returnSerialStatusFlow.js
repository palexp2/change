// « Réception d'un retour → statut du # de série » en blocs (Charles, 2026-10-14),
// repris de l'automatisation système sys_return_item_received, qui ne fait plus
// que les instructions et les alertes Slack.
import db from '../db/database.js'

export const RETURN_SERIAL_FLOW_ID = 'auto_return_serial_status'

const WARRANTY = ['Retour de garantie avec échange différé', 'Retour de garantie avec échange immédiat']
const RECONDITION = ["Le client à changé d'idée", "Fin d'abonnement", 'Erreur de commande', "Retour d'équipement de courtoisie"]

const branch = (reasons, status) => ({
  type: 'update',
  when: { conjunction: 'AND', rules: [{ column: 'return_reason', op: 'in', value: reasons }, { column: 'serial_id', op: 'not_null' }] },
  config: { table: 'serial_numbers', record_id: '{{serial_id}}', fields: [{ column: 'status', value: status }] },
})

/**
 * Crée une fois l'automatisation et y reporte les articles déjà reçus, pour
 * qu'aucun # de série ne soit réécrit rétroactivement.
 */
export function seedReturnSerialStatusFlow() {
  if (db.prepare('SELECT 1 FROM automations WHERE id = ?').get(RETURN_SERIAL_FLOW_ID)) return
  const tc = {
    erp_table: 'return_items', fire_on: 'per_record_once',
    conditions: { conjunction: 'AND', rules: [{ column: 'received_by', op: 'not_null' }, { column: 'received_at', op: 'not_null' }] },
  }
  const steps = [{ id: 'garantie', ...branch(WARRANTY, 'À analyser') }, { id: 'recond', ...branch(RECONDITION, 'À reconditionner') }]
  db.transaction(() => {
    db.prepare(`INSERT INTO automations (id, name, description, trigger_type, trigger_config, action_type, action_config, script, active, kind, group_name)
      VALUES (?, ?, ?, 'field_rule', ?, 'steps', ?, '', 1, 'field_rule', 'Expédition & retours')`).run(
      RETURN_SERIAL_FLOW_ID, 'Réception d’un retour : statut du # de série',
      'Quand un article de retour est reçu, son # de série passe à « À analyser » (garantie) ou « À reconditionner ».',
      JSON.stringify(tc), JSON.stringify({ steps }))
    db.prepare(`INSERT OR IGNORE INTO automation_rule_fires (automation_id, record_table, record_id)
      SELECT ?, 'return_items', id FROM return_items
      WHERE received_by IS NOT NULL AND received_by != '' AND received_at IS NOT NULL AND received_at != ''`).run(RETURN_SERIAL_FLOW_ID)
  })()
}
