/**
 * Le compte QuickBooks d'un compte bancaire ERP.
 *
 * `bank_accounts.qb_account_id` peut porter PLUSIEURS comptes QB séparés par
 * virgule quand la comptabilité a scindé le compte (BNC USD = 10021 sous son
 * parent 10020). Convention unique du dépôt : **le premier de la liste est
 * celui où l'ERP écrit** ; les suivants ne servent qu'à retrouver une écriture
 * déjà passée (services/bankQbLink.js les interroge tous).
 *
 * Une liste à virgules n'est donc jamais une raison de renoncer à proposer un
 * compte de paiement — c'est le premier segment qu'on prend.
 */
export function mainQbAccount(account) {
  const raw = typeof account === 'string' ? account : account?.qb_account_id
  if (!raw) return null
  return String(raw).split(',')[0].trim() || null
}

export function allQbAccounts(account) {
  const raw = typeof account === 'string' ? account : account?.qb_account_id
  if (!raw) return []
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean)
}
