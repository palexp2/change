// « Nouveau projet → entreprise en Quote Sent » en blocs (Pierre-Alexandre
// Papillon, 2026-10-14) : l'entreprise d'un projet qui n'est pas encore à
// « Quote Sent » ou au-delà y passe. Une phase vide compte comme antérieure.
import db from '../db/database.js'

export const PROJECT_COMPANY_PHASE_FLOW_ID = 'auto_project_company_quote_sent'

// Phases à ne jamais rétrograder ; tout le reste (vide compris) est antérieur.
const AT_OR_AFTER = ['Quote Sent', 'Customer', 'Not a Client Anymore', 'Others']

/**
 * Crée une fois l'automatisation et y reporte les projets existants, pour
 * qu'aucune entreprise ne soit réécrite rétroactivement.
 */
export function seedProjectCompanyPhaseFlow() {
  if (db.prepare('SELECT 1 FROM automations WHERE id = ?').get(PROJECT_COMPANY_PHASE_FLOW_ID)) return
  const tc = {
    erp_table: 'projects', fire_on: 'per_record_once',
    conditions: { conjunction: 'AND', rules: [{ column: 'company_id', op: 'not_null' }] },
  }
  const steps = [
    { id: 'entreprise', type: 'find', config: {
      table: 'companies', limit: 1, stop_if_none: true,
      conditions: [{ column: 'id', op: 'eq', value: '{{company_id}}' }, { column: 'lifecycle_phase', op: 'not_in', value: AT_OR_AFTER }],
    } },
    { id: 'phase', type: 'update', config: {
      table: 'companies', record_id: '{{etape1.id}}', fields: [{ column: 'lifecycle_phase', value: 'Quote Sent' }],
    } },
  ]
  db.transaction(() => {
    db.prepare(`INSERT INTO automations (id, name, description, trigger_type, trigger_config, action_type, action_config, script, active, kind, group_name)
      VALUES (?, ?, ?, 'field_rule', ?, 'steps', ?, '', 1, 'field_rule', 'Ventes')`).run(
      PROJECT_COMPANY_PHASE_FLOW_ID, 'Nouveau projet : entreprise en Quote Sent',
      'Quand un projet est lié à une entreprise dont la phase est antérieure à « Quote Sent », elle passe à « Quote Sent ».',
      JSON.stringify(tc), JSON.stringify({ steps }))
    db.prepare(`INSERT OR IGNORE INTO automation_rule_fires (automation_id, record_table, record_id)
      SELECT ?, 'projects', id FROM projects WHERE company_id IS NOT NULL AND company_id != ''`).run(PROJECT_COMPANY_PHASE_FLOW_ID)
  })()
}
