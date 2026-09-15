/**
 * Revenus perçus d'avance — constatation mensuelle.
 *
 * Deux tables :
 *   - `deferred_revenue_recognitions` : une ligne par (facture, mois constaté).
 *     Sa présence MARQUE la ligne comme constatée pour ce mois — un second
 *     passage sur le même mois ne la repropose plus. Aucun contrôle
 *     d'idempotance côté QuickBooks : c'est ce registre qui fait foi.
 *   - `deferred_revenue_drafts` : le brouillon d'écriture du mois (une ligne
 *     par client, ou une seule ligne agrégée), modifiable avant l'envoi.
 *     Le push vers QB reste une action humaine explicite.
 */
export const id = '067-deferred-revenue-recognition'
export const description = "Revenus perçus d'avance : registre des constatations mensuelles + brouillon d'écriture"

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deferred_revenue_recognitions (
      id               TEXT PRIMARY KEY,
      facture_id       TEXT NOT NULL,
      month            TEXT NOT NULL,
      amount_cad       REAL NOT NULL DEFAULT 0,
      amount_native    REAL,
      currency         TEXT,
      exchange_rate    REAL,
      fx_source        TEXT,
      deferral_acctnum TEXT,
      revenue_acctnum  TEXT,
      source           TEXT NOT NULL DEFAULT 'auto',
      note             TEXT,
      qb_je_id         TEXT,
      pushed_at        TEXT,
      created_by       TEXT,
      created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at       TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_defrev_rec_unique
      ON deferred_revenue_recognitions(facture_id, month) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_defrev_rec_month
      ON deferred_revenue_recognitions(month);

    CREATE TABLE IF NOT EXISTS deferred_revenue_drafts (
      id               TEXT PRIMARY KEY,
      month            TEXT NOT NULL,
      aggregated       INTEGER NOT NULL DEFAULT 0,
      txn_date         TEXT,
      memo             TEXT,
      lines            TEXT NOT NULL DEFAULT '[]',
      deferral_acctnum TEXT,
      qb_je_id         TEXT,
      pushed_at        TEXT,
      created_by       TEXT,
      created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at       TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_defrev_draft_month
      ON deferred_revenue_drafts(month) WHERE deleted_at IS NULL;
  `)
}
