/**
 * 097 — « Fermer le mois » : date à laquelle un rapprochement préparé par le robot
 * a été terminé par Charles dans QuickBooks (détectée, jamais cliquée par Boréal).
 */
export const id = '097-bank-qb-reconcile-closed-at'
export const description = 'bank_qb_reconcile_runs.closed_at : rapprochement préparé puis terminé dans QuickBooks'

export function up(db) {
  db.exec('ALTER TABLE bank_qb_reconcile_runs ADD COLUMN closed_at TEXT')
}
