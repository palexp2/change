// « Projet vendu → #notif-de-ventes » en blocs (Pierre-Alexandre Papillon,
// 2026-10-15) : un projet dont le champ « Vendu » passe à « Oui » publie
// « Nouvelle vente : » suivi du lien vers sa fiche dans Boréal. (Le statut
// natif reste « Ouvert » partout : c'est « Vendu », miroir Airtable, qui fait foi.)
import db from '../db/database.js'

export const PROJECT_WON_SLACK_FLOW_ID = 'auto_project_won_slack'

/**
 * Crée une fois l'automatisation et y reporte les projets déjà gagnés, pour
 * qu'aucune ancienne vente ne soit annoncée rétroactivement.
 */
export function seedProjectWonSlackFlow() {
  // 1re version (même jour) déclenchait sur status = 'Gagné', jamais atteint.
  db.prepare(`DELETE FROM automations WHERE id = ? AND trigger_config LIKE '%"status"%'`).run(PROJECT_WON_SLACK_FLOW_ID)
  if (db.prepare('SELECT 1 FROM automations WHERE id = ?').get(PROJECT_WON_SLACK_FLOW_ID)) return
  const tc = {
    erp_table: 'projects', fire_on: 'per_record_once',
    conditions: { conjunction: 'AND', rules: [{ column: 'cf_vendu', op: 'eq', value: 'Oui' }] },
  }
  const steps = [
    { id: 'slack', type: 'slack', config: { channel: '#notif-de-ventes', text: 'Nouvelle vente : {{lien_fiche}}' } },
  ]
  db.transaction(() => {
    db.prepare(`INSERT INTO automations (id, name, description, trigger_type, trigger_config, action_type, action_config, script, active, kind, group_name)
      VALUES (?, ?, ?, 'field_rule', ?, 'steps', ?, '', 1, 'field_rule', 'Ventes')`).run(
      PROJECT_WON_SLACK_FLOW_ID, 'Projet vendu : annonce Slack',
      'Quand le champ « Vendu » d’un projet passe à « Oui », publie « Nouvelle vente : » et le lien du projet dans #notif-de-ventes.',
      JSON.stringify(tc), JSON.stringify({ steps }))
    db.prepare(`INSERT OR IGNORE INTO automation_rule_fires (automation_id, record_table, record_id)
      SELECT ?, 'projects', id FROM projects WHERE cf_vendu = 'Oui'`).run(PROJECT_WON_SLACK_FLOW_ID)
  })()
}
