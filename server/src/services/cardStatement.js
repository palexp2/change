// Montant d'un paiement de carte de crédit, lu sur le relevé de la carte.
//
// POURQUOI. Le paiement pré-programmé de la Mastercard n'a pas de montant fixe :
// il règle le relevé de la période précédente. Tant qu'on ne le savait pas, la
// projection du solde y mettait une moyenne des derniers paiements — 3 969 $ là
// où le relevé annonçait 5 296 $. Or le rapprochement bancaire contient déjà
// chaque achat porté à la carte : il suffit des bonnes dates de début et de fin
// de période pour obtenir le montant exact (demande de Charles, 12 sept. 2026).
//
// PÉRIODE. Le relevé ferme le `closeDay` du mois, et le paiement tombe au début
// du mois suivant : un paiement du 5 octobre règle donc la période du 15 août au
// 14 septembre. Vérifié sur les vrais paiements du compte : 1 724,69 $ (4 sept.)
// et 1 072,86 $ (4 août) retrouvés au cent près.
//
// PRUDENCE. Une période encore ouverte ne peut que grossir : le montant lu sert
// alors de plancher, jamais de vérité — l'appelant garde la plus grande des deux
// valeurs (lue / estimée). Sous-estimer une sortie est l'erreur qui coûte un
// découvert.
import db from '../db/database.js'

// Le virement mensuel pré-programmé règle le relevé PRÉCÉDENT : il ne fait pas
// partie de la période qu'on additionne. Un remboursement ponctuel fait en cours
// de période (« PAIEMENT RECU MERCI ») réduit au contraire ce qui restera à
// payer — il compte. C'est cette distinction qui fait tomber le calcul juste au
// cent près sur les derniers mois.
const SCHEDULED_PAYMENT_RE = /paiement\s+transfert/i

const r2 = n => Math.round(n * 100) / 100
const iso = d => d.toISOString().slice(0, 10)

// Période du relevé réglé par un paiement daté `paymentDate`.
// Bornes exclusive au début, inclusive à la fin : from < date <= to.
export function statementPeriod(paymentDate, closeDay) {
  const d = new Date(`${String(paymentDate).slice(0, 10)}T12:00:00Z`)
  const raw = Number(closeDay)
  if (!(raw >= 1) || Number.isNaN(d.getTime())) return null
  const day = Math.min(28, Math.round(raw))
  // Paiement du 5 octobre, clôture le 14 → relevé fermé le 14 SEPTEMBRE.
  const endMonth = d.getUTCMonth() - (d.getUTCDate() > day ? 0 : 1)
  const to = new Date(Date.UTC(d.getUTCFullYear(), endMonth, day))
  const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 1, day))
  return { from: iso(from), to: iso(to) }
}

// Relevé de carte déjà lu dans le Drive pour ce paiement : le solde imprimé EST
// le montant prélevé. On retient le relevé dont l'échéance tombe juste après la
// date du paiement (observé : 1 à 4 jours après le prélèvement).
export function storedStatementFor({ accountName, paymentDate }) {
  const d = String(paymentDate || '').slice(0, 10)
  if (!accountName || !d) return null
  const shift = (iso, n) => {
    const x = new Date(`${iso}T12:00:00Z`)
    x.setUTCDate(x.getUTCDate() + n)
    return x.toISOString().slice(0, 10)
  }
  return db.prepare(`
    SELECT statement_date, due_date, balance FROM card_statements
    WHERE account_name = ? AND balance IS NOT NULL
      AND due_date >= ? AND due_date <= ?
    ORDER BY due_date LIMIT 1
  `).get(accountName, shift(d, -3), shift(d, 15)) || null
}

// Montant du paiement de carte. Le relevé fait foi ; à défaut (relevé du mois
// pas encore déposé dans le Drive), on additionne les achats de la période.
export function statementAmount({ accountName, closeDay, paymentDate, today = new Date() }) {
  const stored = storedStatementFor({ accountName, paymentDate })
  if (stored) {
    return {
      amount: r2(Math.abs(Number(stored.balance))),
      from: null,
      to: stored.statement_date,
      closed: true,
      source: 'releve',
      lines: null,
    }
  }
  return computedStatementAmount({ accountName, closeDay, paymentDate, today })
}

// Somme des achats portés à la carte sur la période (remboursements déduits).
export function computedStatementAmount({ accountName, closeDay, paymentDate, today = new Date() }) {
  const period = statementPeriod(paymentDate, closeDay)
  if (!period || !accountName) return null
  const account = db.prepare(
    'SELECT id FROM bank_accounts WHERE name = ? AND deleted_at IS NULL'
  ).get(accountName)
  if (!account) return null
  const rows = db.prepare(`
    SELECT description, amount FROM bank_transactions
    WHERE account_id = ? AND deleted_at IS NULL AND txn_date > ? AND txn_date <= ?
  `).all(account.id, period.from, period.to)
  const charges = rows.filter(t => !SCHEDULED_PAYMENT_RE.test(t.description || ''))
  if (!charges.length) return null
  const amount = r2(Math.abs(charges.reduce((s, t) => s + Number(t.amount || 0), 0)))
  return {
    amount,
    from: period.from,
    to: period.to,
    // Période encore ouverte : le montant peut encore monter.
    closed: period.to < iso(today),
    source: 'achats',
    lines: charges.length,
  }
}
