/**
 * 075 — Sur une carte, l'état d'une transaction ne se devine pas.
 *
 * La migration 074 avait posé « complété » sur toute transaction sans état
 * connu. Sur un compte de banque, c'est vrai par nature : la ligne est au
 * relevé, donc elle est passée. Sur une CARTE, non : le portail distingue
 * « En attente » (l'achat n'est pas encore porté au relevé) et « Autorisée »,
 * et c'est cette distinction que Michel lit dans le fichier de suivi. La
 * supposer a mis « Autorisée » sur des achats encore en attente.
 *
 * On efface donc l'état supposé des cartes. Il se remplira tout seul au
 * prochain import : la colonne « Statut » de l'export du portail est désormais
 * lue, et un import qui retrouve une ligne déjà en base met son état à jour.
 */
import db from '../database.js'

export const id = '075-card-bank-state-unknown'
export const description = "Cartes : l'état « complété » supposé est effacé, il vient maintenant du document déposé"

export function up(migrationDb) {
  const d = migrationDb || db
  const res = d.prepare(`
    UPDATE bank_transactions SET bank_state = NULL
    WHERE bank_state = 'complete'
      AND account_id IN (SELECT id FROM bank_accounts WHERE kind = 'card')
  `).run()
  return { cleared: res.changes }
}
