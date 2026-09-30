/**
 * 098 — BNC USD : le compte QuickBooks principal est 10021 « Compte USD BNC »,
 * pas 10020 « Compte USD Banque Nationale » (son parent).
 *
 * `bank_accounts.qb_account_id` peut porter plusieurs comptes QB séparés par
 * virgule ; le PREMIER est celui où l'ERP écrit. Il valait '234,168' (10020
 * d'abord) — toute écriture BNC USD partait donc sur le compte parent, alors
 * que la comptabilité tient le détail dans 10021.
 */
export const id = '098-bnc-usd-main-qb-account-10021'
export const description = "BNC USD : écrire dans 10021 (Compte USD BNC) plutôt que 10020"

export function up(db) {
  db.prepare(`UPDATE bank_accounts SET qb_account_id='168,234' WHERE qb_account_id='234,168'`).run()
}
