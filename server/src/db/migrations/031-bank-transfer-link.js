/**
 * 031 — Virement interne : les deux lignes bancaires d'un même mouvement.
 *
 * Un transfert entre deux comptes d'Orisha (BNC CAD → MasterCard, Venn USD →
 * BNC CAD…) produit DEUX lignes de relevé, une sortie et une entrée, dans deux
 * comptes différents. Jusqu'ici l'ERP n'avait aucun moyen de dire qu'elles sont
 * le même mouvement : chacune restait « à traiter » en attendant une facture
 * qui n'existera jamais.
 *
 * `transfer_txn_id` porte le lien, croisé (chaque ligne pointe l'autre).
 * On ne réutilise PAS `matched_type` : un virement n'est pas un document, et
 * élargir sa contrainte CHECK demanderait de reconstruire la table.
 *
 * `transfer_amount` ne sert qu'au cas multidevise, où les deux montants
 * diffèrent : c'est le montant que l'utilisateur déclare avoir transféré.
 */
import db from '../database.js'

export const id = '031-bank-transfer-link'
export const description =
  'bank_transactions.transfer_txn_id / transfer_amount — appariement des deux lignes d\'un virement interne'

export function up(migrationDb) {
  const d = migrationDb || db
  const cols = new Set(d.pragma('table_info(bank_transactions)').map(c => c.name))
  const added = []

  if (!cols.has('transfer_txn_id')) {
    d.exec('ALTER TABLE bank_transactions ADD COLUMN transfer_txn_id TEXT')
    added.push('transfer_txn_id')
  }
  if (!cols.has('transfer_amount')) {
    d.exec('ALTER TABLE bank_transactions ADD COLUMN transfer_amount REAL')
    added.push('transfer_amount')
  }
  d.exec('CREATE INDEX IF NOT EXISTS idx_bank_txn_transfer ON bank_transactions(transfer_txn_id)')

  return added.length ? { added } : { skipped: 'colonnes déjà présentes' }
}
