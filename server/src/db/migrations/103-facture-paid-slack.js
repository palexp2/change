/**
 * 103 — Alerte Slack « une facture a été payée » : journal des décisions.
 *
 * change_log ne garde pas l'ancienne valeur : le watcher ne sait pas si une
 * facture vient de PASSER à « Payé » ou l'était déjà. Une ligne par facture
 * tranchée (notifiée, ignorée) dit qu'elle ne doit plus être regardée.
 *
 * Les factures déjà payées au moment de la migration sont inscrites
 * « backfill » : elles ne déclenchent jamais d'alerte, même touchées par un
 * sync plus tard.
 */

export const id = '103-facture-paid-slack'
export const description = 'Crée facture_paid_notifications et y inscrit les factures déjà payées'

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS facture_paid_notifications (
      facture_id TEXT PRIMARY KEY,
      outcome TEXT NOT NULL,          -- 'sent' | 'skipped' | 'backfill' | 'error'
      reason TEXT,
      decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  const info = db.prepare(`
    INSERT OR IGNORE INTO facture_paid_notifications (facture_id, outcome, reason)
    SELECT id, 'backfill', 'déjà payée à la mise en service'
      FROM factures WHERE status IN ('Payé', 'Payée')
  `).run()
  return { backfilled: info.changes }
}
