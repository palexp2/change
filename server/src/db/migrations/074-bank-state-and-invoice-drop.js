/**
 * 074 — L'état d'une ligne à la banque, et les factures déposées au relevé.
 *
 * 1. `bank_transactions.bank_state` : « complété », « en attente », « autorisé ».
 *    L'information existait dans le fichier de suivi (colonne Statut des
 *    onglets Venn) et chez Plaid (`pending`), mais elle était soit collée au
 *    libellé, soit réduite à une petite horloge sur la date. Elle devient une
 *    donnée à part entière, remplie pour TOUTE transaction.
 *
 * 2. `bank_statement_uploads.document_kind` / `sale_receipt_id` : un fichier
 *    déposé sur l'écran de rapprochement n'est pas toujours un relevé. Quand la
 *    lecture reconnaît une facture, elle part à l'extraction de données ; ces
 *    deux colonnes en gardent la trace.
 */
import db from '../database.js'

export const id = '074-bank-state-and-invoice-drop'
export const description =
  "État bancaire (complété / en attente / autorisé) sur chaque transaction ; factures déposées au relevé routées vers l'extraction"

export function up(migrationDb) {
  const d = migrationDb || db
  const addColumn = (table, decl, name) => {
    const has = d.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?`).get(table, name).n
    if (!has) d.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`)
  }

  addColumn('bank_transactions', 'bank_state TEXT', 'bank_state')
  addColumn('bank_statement_uploads', 'document_kind TEXT', 'document_kind')
  addColumn('bank_statement_uploads', 'sale_receipt_id TEXT', 'sale_receipt_id')

  // Reprise de l'historique. Ce que Plaid tenait pour en attente l'est ; le
  // reste est passé au compte. Les lignes venues du fichier de suivi portent
  // leur statut à la fin du libellé (« … — Pending ») : c'est la seule trace
  // qu'on en ait, on la lit plutôt que de laisser la colonne vide.
  const pending = d.prepare(`
    UPDATE bank_transactions SET bank_state = 'en_attente'
    WHERE bank_state IS NULL AND (COALESCE(pending, 0) = 1
      OR description LIKE '%— Pending' OR description LIKE '%- Pending')
  `).run().changes
  const authorized = d.prepare(`
    UPDATE bank_transactions SET bank_state = 'autorise'
    WHERE bank_state IS NULL AND (description LIKE '%— Authorized' OR description LIKE '%- Authorized'
      OR description LIKE '%— Autorisé' OR description LIKE '%- Autorisé')
  `).run().changes
  const complete = d.prepare(`
    UPDATE bank_transactions SET bank_state = 'complete' WHERE bank_state IS NULL
  `).run().changes

  return { pending, authorized, complete }
}
