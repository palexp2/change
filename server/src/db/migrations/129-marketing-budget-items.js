/**
 * 129 — Budget marketing : lignes détaillées (fournisseur / événement × mois).
 *
 * L'ancien fichier « Annual Marketing budget » prévoyait le budget ligne par
 * ligne (Luke, EFAO, PASA…) et portait du réel saisi à la main avant que Boréal
 * ne lise QuickBooks. Charles, 2026-10-13 : le reprendre dans Boréal. Ces lignes
 * s'ajoutent au budget par compte (marketing_budget_lines) et au réel des
 * dépenses validées ; le Google Sheet miroir les affiche une par rangée.
 */
export const id = '129-marketing-budget-items'
export const description = 'Budget marketing : lignes détaillées reprises du fichier annuel'

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketing_budget_items (
      id TEXT PRIMARY KEY,
      acctnum TEXT NOT NULL,
      label TEXT NOT NULL,
      month TEXT NOT NULL,
      budget REAL NOT NULL DEFAULT 0,
      real REAL NOT NULL DEFAULT 0,
      source TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_budget_item ON marketing_budget_items(acctnum, label, month) WHERE deleted_at IS NULL`)
}
