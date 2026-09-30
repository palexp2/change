// « Fermer le mois » (Charles, 2026-09-27) : il clique « Terminer » dans QuickBooks
// une fois par mois, au début du mois. Le robot prépare chaque compte au fil des
// relevés (services/qbReconcileRobot.js) ; ici on compte ce qui attend sa
// fermeture — pastille sur l'onglet Rapprochement — et on reconnaît seul ce qu'il
// a fermé, pour que la pastille retombe à zéro.
import db from '../db/database.js'

const ZERO = 0.005

// Dernier passage de chaque compte qui a laissé une Différence nulle, pas encore fermé.
function pendingRuns() {
  return db.prepare(`
    SELECT r.id, r.account_id, r.statement_date, r.created_at, r.result, a.name AS account_name
    FROM bank_qb_reconcile_runs r
    JOIN bank_accounts a ON a.id = r.account_id AND a.deleted_at IS NULL
    WHERE r.ok = 1 AND r.statement_date IS NOT NULL AND ABS(COALESCE(r.difference, 1)) < ${ZERO}
      AND r.closed_at IS NULL
      AND r.created_at = (SELECT MAX(created_at) FROM bank_qb_reconcile_runs r2
                          WHERE r2.account_id = r.account_id AND r2.statement_date IS NOT NULL AND r2.ok = 1)
    ORDER BY a.name
  `).all()
}

// Préparée à l'appel : la colonne naît d'une migration, après le chargement des modules.
const closeRun = { run: (id) => db.prepare("UPDATE bank_qb_reconcile_runs SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id) }

// Un passage plus récent du robot a lu dans QuickBooks une « date de fin du
// dernier relevé » au moins égale : ce relevé-là est fermé.
function closedPerRobot(run) {
  const later = db.prepare(`
    SELECT result FROM bank_qb_reconcile_runs WHERE account_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 5
  `).all(run.account_id, run.created_at)
  return later.some((r) => {
    try { const end = JSON.parse(r.result || '{}').qb_last_end; return end && end >= run.statement_date } catch { return false }
  })
}

// La pastille s'allume au début du mois qui suit le relevé (le mois est fini) et
// reste allumée jusqu'à ce que le compte soit terminé dans QuickBooks — pas de
// date limite (Charles, 2026-09-27).
export function inCloseWindow(statementDate, today = new Date()) {
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montreal', year: 'numeric', month: '2-digit' }).format(today).slice(0, 7)
  return String(statementDate).slice(0, 7) < month
}

export function monthCloseStatus() {
  const ready = []
  for (const run of pendingRuns()) {
    if (closedPerRobot(run)) { closeRun.run(run.id); continue }
    ready.push({ account_id: run.account_id, account_name: run.account_name, statement_date: run.statement_date })
  }
  return { count: ready.length, badge_count: ready.filter((r) => inCloseWindow(r.statement_date)).length, ready }
}

/**
 * Passage de la vérification QuickBooks : toutes les écritures du compte jusqu'à
 * la date du relevé sont « R » (rapprochées) dans le grand livre → fermé.
 * @param {string} accountId
 * @param {Array<{date: string, cleared: string|null}>} ledger  écritures QB du compte
 */
export function detectClosedFromLedger(accountId, ledger) {
  const run = pendingRuns().find((r) => r.account_id === accountId)
  if (!run || !Array.isArray(ledger)) return false
  const upTo = ledger.filter((e) => e.date && e.date <= run.statement_date)
  if (!upTo.length || !upTo.some((e) => e.date.slice(0, 7) === run.statement_date.slice(0, 7))) return false
  if (!upTo.every((e) => e.cleared === 'R')) return false
  closeRun.run(run.id)
  return true
}
