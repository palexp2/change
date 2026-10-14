/**
 * 131 — Abonnements de test interne.
 *
 * Charles, 2026-10-14 : 7 essais internes comptaient comme nouveaux
 * abonnements d'octobre. On marque les tests (is_test, raison, marquage
 * manuel prioritaire), on les marque tous dès maintenant, et on retire de la
 * base les mouvements de ces 7 essais d'octobre (demandé explicitement).
 */
import { detectTestReason, staff } from '../../services/subscriptionTestFlag.js'

export const id = '131-subscriptions-is-test'
export const description = 'Abonnements : marqueur « test interne » + retrait des 7 essais internes d\'octobre 2026'

const OCTOBER_TESTS = [
  'sub_1ULp53EO122sMsbJKoDnqR86', 'sub_1UOmdeEO122sMsbJya0Y4TAh', 'sub_1UQ5oQEO122sMsbJO8rn5IRS',
  'sub_1UQ6EDEO122sMsbJgS5iWAgm', 'sub_1UQ6PAEO122sMsbJALVMUgzJ', 'sub_1UQ6nyEO122sMsbJWydvIuvL',
  'sub_1UQAQCEO122sMsbJaPcfaafL',
]

export function up(db) {
  const cols = db.prepare('PRAGMA table_info(subscriptions)').all().map(c => c.name)
  if (!cols.includes('is_test')) db.exec('ALTER TABLE subscriptions ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0')
  if (!cols.includes('is_test_reason')) db.exec('ALTER TABLE subscriptions ADD COLUMN is_test_reason TEXT')
  if (!cols.includes('is_test_manual')) db.exec('ALTER TABLE subscriptions ADD COLUMN is_test_manual INTEGER NOT NULL DEFAULT 0')

  const people = staff(db)
  const rows = db.prepare(`
    SELECT s.id, s.customer_email, co.name AS company_name
    FROM subscriptions s LEFT JOIN companies co ON co.id = s.company_id
  `).all()
  const set = db.prepare('UPDATE subscriptions SET is_test=1, is_test_reason=? WHERE id=?')
  for (const r of rows) {
    const reason = detectTestReason({ customerEmail: r.customer_email, companyName: r.company_name }, people)
    if (reason) set.run(reason, r.id)
  }
  // Les 7 essais d'octobre sont des tests, quel que soit le résultat ci-dessus.
  const ph = OCTOBER_TESTS.map(() => '?').join()
  db.prepare(`UPDATE subscriptions SET is_test=1, is_test_manual=1, is_test_reason=COALESCE(is_test_reason,'test interne') WHERE stripe_id IN (${ph})`).run(...OCTOBER_TESTS)
  db.prepare(`DELETE FROM subscription_events WHERE subscription_id IN (SELECT id FROM subscriptions WHERE stripe_id IN (${ph}))`).run(...OCTOBER_TESTS)
}
