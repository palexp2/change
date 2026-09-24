// ── Remboursement de la marge de crédit : capital + intérêts ────────────────
// Le fichier de suivi le dit ligne par ligne : « Remboursement automatique
// /de EOP:19 686,89 $ » sort 19 686,89 $ du compte courant, dont 19 000 $ de
// capital (le solde de la marge recule d'autant) et 686,89 $ d'intérêts
// (demande de Charles, 2026-09-19 : « ajoute ce type de détection »).
//
// Un seul débit au relevé, deux comptes à l'écriture : on propose la coupe
// toute faite, le capital sur la marge et les intérêts en charge.
import db from '../db/database.js'

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const money = (n) => `${n.toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`

// Le total annoncé dans le libellé (« …EOP:19 686,89$ »), en dollars.
export function totalFromLabel(text) {
  const m = /(\d[\d\s\u00a0\u202f.,]*)\s*\$/.exec(String(text || ''))
  if (!m) return null
  const raw = m[1].replace(/[\s\u00a0\u202f]/g, '')
  // « 19 686,89 » (virgule décimale) ou « 19,686.89 » (virgule de milliers).
  const normalized = raw.lastIndexOf(',') > raw.lastIndexOf('.')
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw.replace(/,/g, '')
  const n = Number(normalized)
  return Number.isFinite(n) && n > 0 ? round2(n) : null
}

const isMarginAccount = (name) => /marge/i.test(String(name || ''))

// La ligne de la marge qui correspond à ce débit du compte courant.
function marginLineFor(txn) {
  const out = Math.abs(Number(txn.amount) || 0)
  const rows = db.prepare(`
    SELECT t.*, a.name AS account_name
    FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
    WHERE t.deleted_at IS NULL AND t.amount < 0
      AND t.txn_date BETWEEN date(?, '-3 day') AND date(?, '+3 day')
      AND a.name LIKE '%arge%'
  `).all(txn.txn_date, txn.txn_date)
  for (const r of rows) {
    const principal = Math.abs(Number(r.amount) || 0)
    const interest = r.interest_cad != null
      ? round2(r.interest_cad)
      : round2((totalFromLabel(r.description) || 0) - principal)
    if (interest <= 0) continue
    if (Math.abs(principal + interest - out) <= 0.02) return { principal, interest, line: r }
  }
  return null
}

// Le compte de charge où les intérêts de la marge sont allés la dernière fois :
// une habitude, pas une devinette — s'il n'y en a pas, la part reste à remplir.
export function lastInterestAccount(marginQbAccountId) {
  const rows = db.prepare(`
    SELECT lines FROM achats_fournisseurs
    WHERE lines IS NOT NULL AND quickbooks_id IS NOT NULL
    ORDER BY date_achat DESC, created_at DESC LIMIT 40
  `).all()
  for (const r of rows) {
    let parts
    try { parts = JSON.parse(r.lines || 'null') } catch { continue }
    if (!Array.isArray(parts) || parts.length !== 2) continue
    const capital = parts.find((p) => String(p?.account_id) === String(marginQbAccountId))
    const other = parts.find((p) => String(p?.account_id) !== String(marginQbAccountId))
    if (capital && other?.account_id) return String(other.account_id)
  }
  return null
}

/**
 * La coupe proposée pour un débit qui rembourse la marge, ou `null`.
 * @returns {{ total, principal, interest, reason, lines: [{expense_account_id, amount, description}] }|null}
 */
export function marginRepaymentSplit(txn, account) {
  if (!txn || !(Number(txn.amount) < 0)) return null
  // La ligne de la marge elle-même n'est pas une dépense : c'est l'autre bout.
  if (isMarginAccount(account?.name)) return null
  const hit = marginLineFor(txn)
  if (!hit) return null

  const marginAccount = db.prepare(`
    SELECT name, qb_account_id FROM bank_accounts WHERE id=?
  `).get(hit.line.account_id)
  const marginQb = String(marginAccount?.qb_account_id || '').split(',')[0].trim() || null
  if (!marginQb) return null

  return {
    total: round2(hit.principal + hit.interest),
    principal: hit.principal,
    interest: hit.interest,
    reason: `${marginAccount.name} : ${money(hit.principal)} de capital et ${money(hit.interest)} d'intérêts`,
    lines: [
      { expense_account_id: marginQb, amount: hit.principal, description: 'Remboursement de capital' },
      { expense_account_id: lastInterestAccount(marginQb) || '', amount: hit.interest, description: 'Intérêts' },
    ],
  }
}
