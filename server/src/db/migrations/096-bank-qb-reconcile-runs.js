/**
 * 096 — Passages du robot « Rapprocher » QuickBooks (services/qbReconcileRobot.js).
 *
 * Une ligne par passage : la Différence lue à l'écran, le nombre de coches
 * posées, ce qui n'a pas trouvé sa ligne (des deux côtés), la capture, et si le
 * rapprochement a bien été enregistré pour plus tard (jamais terminé). La page
 * /rapprochement affiche le dernier passage de chaque compte.
 */
export const id = '096-bank-qb-reconcile-runs'
export const description = 'bank_qb_reconcile_runs : résultat de chaque passage du robot « Rapprocher » QuickBooks'

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_qb_reconcile_runs (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES bank_accounts(id),
      ok INTEGER NOT NULL DEFAULT 0,
      statement_date TEXT,
      ending_balance REAL,
      difference REAL,
      checked INTEGER DEFAULT 0,
      already_checked INTEGER DEFAULT 0,
      saved INTEGER DEFAULT 0,
      resumed INTEGER DEFAULT 0,
      unmatched_boreal TEXT,           -- JSON [{ id, date, amount, label }]
      unmatched_qb TEXT,               -- JSON [{ date, amount, label }]
      screenshot TEXT,                 -- nom de fichier dans uploads/qb-reconcile
      error TEXT,
      needs_session INTEGER DEFAULT 0,
      result TEXT,                     -- JSON complet (trace comprise)
      run_by TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_bank_qb_reconcile_runs_account ON bank_qb_reconcile_runs(account_id, created_at)')
}
