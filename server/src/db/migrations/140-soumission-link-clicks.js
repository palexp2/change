/**
 * 140 — Soumissions : journal des clics sur les boutons « S'abonner » /
 * « Acheter » du PDF (/erp/pay/soumission/:id/:kind).
 *
 * Demande de Pierre-Alexandre Papillon (2026-10-15, /pipeline) : voir les clics
 * dans l'historique des envois d'une soumission. Une ligne par clic, tenue que
 * les automatisations soient actives ou non ; amorcée avec les clics déjà
 * journalisés par l'automatisation « note au fil ».
 */

export const id = '140-soumission-link-clicks'
export const description = 'Soumissions : journal des clics S’abonner / Acheter du PDF'

export function up(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS soumission_link_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      soumission_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      clicked_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_soumission_link_clicks ON soumission_link_clicks(soumission_id, clicked_at);
  `)
  const r = d.prepare(`
    INSERT INTO soumission_link_clicks (soumission_id, kind, clicked_at)
    SELECT json_extract(trigger_data, '$.soumission_id'), json_extract(trigger_data, '$.kind'), created_at
    FROM automation_logs
    WHERE automation_id = 'sys_soumission_link_click' AND status = 'success'
      AND json_extract(trigger_data, '$.soumission_id') IS NOT NULL
      AND json_extract(trigger_data, '$.kind') IS NOT NULL
  `).run()
  return { backfilled: r.changes }
}
