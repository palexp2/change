/**
 * Une sortie d'argent sans pièce justificative doit exister, même quand on ne
 * sait pas à qui elle est payée.
 *
 * Jusqu'ici, `refreshInvoiceNeeds()` abandonnait toute transaction dont le
 * libellé du relevé ne désignait aucun fournisseur connu (`if (!hit) continue`).
 * Ces sorties-là — « CPC SCP », « WWW.CANADIANTIRE.CA », « PREMIER FARNELL » —
 * n'apparaissaient donc nulle part comme facture manquante : ni dans la liste
 * de collecte, ni ailleurs. C'est précisément l'angle mort que le bouton
 * « Factures manquantes » doit couvrir.
 *
 * On ouvre donc le vocabulaire des statuts à `sans_fournisseur`. SQLite ne sait
 * pas modifier une contrainte CHECK : la table est reconstruite à l'identique,
 * contrainte élargie, contenu et index repris.
 */
import db from '../database.js'

export const id = '078-invoice-needs-sans-fournisseur'
export const description = "Factures manquantes : une sortie au fournisseur non reconnu a droit à son statut"

export function up(migrationDb) {
  const d = migrationDb || db
  const exists = d.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='invoice_needs'"
  ).get()
  if (!exists) return { skipped: 'table absente' }

  const sql = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='invoice_needs'").get().sql
  if (sql.includes('sans_fournisseur')) return { skipped: 'déjà élargie' }

  d.exec(`
    CREATE TABLE invoice_needs_new (
      id TEXT PRIMARY KEY,
      bank_txn_id TEXT NOT NULL REFERENCES bank_transactions(id),
      scraper_account_id TEXT REFERENCES scraper_accounts(id),
      vendor_profile_id TEXT REFERENCES vendor_profiles(id),
      amount REAL,
      currency TEXT,
      txn_date TEXT,
      status TEXT NOT NULL DEFAULT 'en_attente'
        CHECK(status IN ('en_attente','trouvee','introuvable','ambigue','devise_differente','sans_collecteur','sans_fournisseur')),
      sale_receipt_id TEXT REFERENCES sale_receipts(id),
      attempts INTEGER DEFAULT 0,
      last_attempt_at TEXT,
      note TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO invoice_needs_new
      SELECT id, bank_txn_id, scraper_account_id, vendor_profile_id, amount, currency,
             txn_date, status, sale_receipt_id, attempts, last_attempt_at, note,
             created_at, updated_at
      FROM invoice_needs;
    DROP TABLE invoice_needs;
    ALTER TABLE invoice_needs_new RENAME TO invoice_needs;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_needs_txn ON invoice_needs(bank_txn_id);
    CREATE INDEX IF NOT EXISTS idx_invoice_needs_account ON invoice_needs(scraper_account_id, status);
  `)
  return { rebuilt: d.prepare('SELECT COUNT(*) n FROM invoice_needs').get().n }
}
