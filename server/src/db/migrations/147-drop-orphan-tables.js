/**
 * 147 — Suppression de 14 tables que plus aucun code ne lit (audit du 2026-10-17).
 *
 * Chaque nom a été cherché dans server/src, client/src, e2e, standalone, shared,
 * les scripts d'ops et les mémoires de l'agent : seule la définition dans
 * schema.js (retirée en même temps) et le manifeste généré les citaient encore.
 * Restes de fonctionnalités retirées :
 *   ai_usage_events, ai_model_prices        page « Coûts IA » (retirée 2026-10-15)
 *   rd_sheet_sync_state                     synchro Drive de la feuille de temps (2026-10-07)
 *   contract_events, contract_acceptances   journal/acceptations de l'ancien outil Contrats
 *                                           (remplacé par les pages avec acceptation, 2026-10-09 ;
 *                                           la table `contracts` reste : redirection des anciens liens)
 *   page_events                             journal en arrière-plan des pages avec acceptation (2026-10-09)
 *   record_comments                         fil de commentaires jamais branché côté client
 *   email_relance_overrides, email_relance_drafts
 *                                           page « Relances qualification » (retirée 2026-10-14)
 *   agent_tasks                             file de l'agent, remplacée par agent-tasks.json
 *   base_interactions (+ _links, _attachments), base_connector_configs
 *                                           moteur générique abandonné (suite de la migration 002)
 * Aucune table vivante ne porte de REFERENCES vers l'une d'elles.
 */

export const id = '147-drop-orphan-tables'
export const description = 'Supprime 14 tables orphelines (Coûts IA, relances qualification, synchro feuille RSDE, journal Contrats, commentaires, moteur générique)'

// Ordre significatif : les tables portant un REFERENCES vers base_interactions partent avant elle.
const DEAD_TABLES = [
  'base_interaction_attachments',
  'base_interaction_links',
  'base_interactions',
  'base_connector_configs',
  'agent_tasks',
  'record_comments',
  'email_relance_overrides',
  'email_relance_drafts',
  'page_events',
  'rd_sheet_sync_state',
  'ai_usage_events',
  'ai_model_prices',
  'contract_events',
  'contract_acceptances',
]

export function up(db) {
  for (const t of DEAD_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`)
}
