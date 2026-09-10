/**
 * 047 — Journal des problèmes d'opérations.
 *
 * Les incidents du quotidien (une pièce manquante à l'assemblage, un colis
 * parti au mauvais endroit, une étiquette illisible) se racontaient à l'oral ou
 * dans un fil Slack : rien ne permettait de dire combien de fois un problème
 * s'est reproduit, ni s'il a fini par être corrigé. D'où une table à part, une
 * ligne par problème constaté, avec son secteur, sa gravité et son correctif.
 *
 * `resolved_at` n'est pas saisi : la route le pose quand le statut passe à
 * « Résolu » et l'efface s'il en ressort (voir db/recordRegistry.js).
 */
import db from '../database.js'

export const id = '047-ops-issues'
export const description =
  "ops_issues — journal des problèmes d'opérations (secteur, gravité, statut, correctif)"

export function up(migrationDb) {
  const d = migrationDb || db
  d.exec(`
    CREATE TABLE IF NOT EXISTS ops_issues (
      id          TEXT PRIMARY KEY,
      occurred_at TEXT,
      title       TEXT NOT NULL,
      area        TEXT,
      severity    TEXT,
      status      TEXT NOT NULL DEFAULT 'Ouvert',
      description TEXT,
      resolution  TEXT,
      reported_by TEXT REFERENCES users(id),
      resolved_at TEXT,
      created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at  TEXT
    )
  `)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_ops_issues_status
            ON ops_issues(status) WHERE deleted_at IS NULL`)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_ops_issues_occurred
            ON ops_issues(occurred_at) WHERE deleted_at IS NULL`)
  return { created: ['ops_issues'] }
}
