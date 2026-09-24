/**
 * 073 — Revenus perçus d'avance : le compte 23900 est celui des DÉPÔTS.
 *
 * La première version de la page étalait les abonnements dans le temps et
 * proposait Dr 23900 / Cr 41000. C'était faux : un abonnement encaissé crédite
 * directement 41000 au paiement (services/quickbooks.js), il ne passe jamais
 * par 23900. Le compte ne porte que l'argent des commandes payées non encore
 * expédiées. Aucune écriture n'a été envoyée — les deux tables de l'ancienne
 * mécanique sont vides et s'en vont.
 *
 * À leur place : la trace des corrections envoyées depuis la page (libération
 * passée deux fois, passif jamais libéré).
 */
import db from '../database.js'

export const id = '073-deferred-deposit-corrections'
export const description =
  "Revenus perçus d'avance : corrections du compte 23900 ; retrait de l'étalement des abonnements"

export function up(migrationDb) {
  const d = migrationDb || db
  d.exec(`
    CREATE TABLE IF NOT EXISTS deferred_deposit_corrections (
      id         TEXT PRIMARY KEY,
      group_key  TEXT NOT NULL,
      amount_cad REAL NOT NULL DEFAULT 0,
      memo       TEXT,
      txn_date   TEXT,
      lines      TEXT NOT NULL DEFAULT '[]',
      qb_je_id   TEXT,
      pushed_at  TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_defdep_corr_group ON deferred_deposit_corrections(group_key);
  `)

  // Prudence : on ne jette que ce qui est vide. Une ligne écrite entre-temps
  // vaut plus que la propreté du schéma.
  let dropped = 0
  for (const table of ['deferred_revenue_recognitions', 'deferred_revenue_drafts']) {
    try {
      const n = d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
      if (n === 0) { d.exec(`DROP TABLE ${table}`); dropped += 1 }
    } catch { /* table absente : rien à faire */ }
  }
  return { dropped }
}
