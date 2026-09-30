/**
 * 092 — Fusion de doublons d'entreprises (services/companyMerge.js).
 *
 * `company_merges` : une ligne par entreprise absorbée. `dropped_airtable_id`
 * sert d'alias au sync Airtable — un contact, une commande ou un projet encore
 * lié là-bas à l'ancienne fiche retombe sur celle gardée. `snapshot` garde la
 * fiche absorbée telle qu'elle était, `moved` le nombre de liens déplacés.
 *
 * `company_duplicate_dismissals` : paires marquées « pas un doublon », plus
 * jamais proposées (a_id < b_id).
 */
export const id = '092-company-merges'
export const description = 'companies : historique des fusions de doublons + paires écartées'

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_merges (
      id TEXT PRIMARY KEY,
      kept_id TEXT NOT NULL,
      dropped_id TEXT NOT NULL,
      dropped_airtable_id TEXT,
      dropped_name TEXT,
      snapshot TEXT,
      moved TEXT,
      merged_by TEXT,
      merged_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_company_merges_dropped ON company_merges(dropped_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_company_merges_dropped_at ON company_merges(dropped_airtable_id)')
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_duplicate_dismissals (
      a_id TEXT NOT NULL,
      b_id TEXT NOT NULL,
      dismissed_by TEXT,
      dismissed_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (a_id, b_id)
    )
  `)
}
