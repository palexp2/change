// Abonnements de test interne : repérés automatiquement pour ne pas polluer
// le MRR (Charles, 2026-10-14 — 7 essais internes comptés comme nouveaux
// abonnements en octobre). Un abonnement marqué :
//   - n'enregistre plus de mouvement (recordEvent l'ignore) ;
//   - est exclu des mouvements affichés et de la projection de trésorerie.
// Un marquage posé à la main (is_test_manual=1) n'est jamais écrasé.
import db from '../db/database.js'

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

// Employés réels : comptes actifs, hors comptes de test E2E et du robot.
export function staff(conn = db) {
  return conn.prepare(`SELECT name, email FROM users WHERE deleted_at IS NULL`).all()
    .filter(u => u.name && !/^e2e\b/i.test(u.name) && norm(u.name) !== 'claude')
    .map(u => {
      const parts = norm(u.name).split(/[\s-]+/).filter(Boolean)
      return { full: norm(u.name), first: parts[0], last: parts[parts.length - 1], email: norm(u.email) }
    })
}

/** Raison courte si l'abonnement est un test interne, sinon null. */
export function detectTestReason({ customerEmail, companyName }, people = staff()) {
  const email = norm(customerEmail)
  const local = email.split('@')[0] || ''
  const name = norm(companyName)
  if (email.endsWith('@orisha.io')) return 'courriel @orisha.io'
  if (/\btest/.test(local) || /\btest\b/.test(name)) return '« test » dans le nom'
  for (const p of people) {
    if (name && name === p.full) return `entreprise = ${p.full}`
    if (email && email === p.email) return `courriel de ${p.full}`
    if (p.first && p.last && p.first !== p.last && local.includes(p.first) && local.includes(p.last)) {
      return `courriel de ${p.full}`
    }
  }
  return null
}

const rowStmt = () => db.prepare(`
  SELECT s.id, s.customer_email, s.is_test, s.is_test_reason, s.is_test_manual, co.name AS company_name
  FROM subscriptions s LEFT JOIN companies co ON co.id = s.company_id
  WHERE s.id = ?
`)

function apply(row, people) {
  if (!row || row.is_test_manual) return !!row?.is_test
  const reason = detectTestReason({ customerEmail: row.customer_email, companyName: row.company_name }, people)
  const flag = reason ? 1 : 0
  if (flag !== (row.is_test || 0) || reason !== row.is_test_reason) {
    db.prepare('UPDATE subscriptions SET is_test=?, is_test_reason=? WHERE id=?').run(flag, reason, row.id)
  }
  return !!flag
}

/** Recalcule le marquage d'un abonnement ; renvoie true s'il est un test. */
export function refreshTestFlag(subscriptionId) {
  try {
    return apply(rowStmt().get(subscriptionId), staff())
  } catch (e) {
    // Base sans les colonnes (tests en mémoire) : jamais bloquant.
    console.warn('[subscriptionTestFlag]', e.message)
    return false
  }
}

/** Recalcule tous les abonnements (fin de sync Stripe). */
export function refreshAllTestFlags() {
  const people = staff()
  const stmt = rowStmt()
  let n = 0
  for (const id of db.prepare('SELECT id FROM subscriptions').pluck().all()) {
    if (apply(stmt.get(id), people)) n++
  }
  return n
}
