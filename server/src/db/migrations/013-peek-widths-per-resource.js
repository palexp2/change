/**
 * 013 — La largeur du side-peek devient une préférence PAR RESSOURCE.
 *
 * `users.peek_width` ne mémorisait qu'un seul nombre : la dernière largeur
 * choisie s'appliquait à tous les panneaux. Or une commande (tableau
 * d'articles, colonnes de prix) et un contact n'ont pas besoin de la même
 * place. On passe donc à une carte `{ "<ressource>": <px> }` —
 * `{"orders":1100,"contacts":560}` — stockée en JSON dans `peek_widths`.
 *
 * `peek_width` n'est pas supprimée : elle reste lue comme largeur de repli
 * pour les ressources dont l'utilisateur n'a encore rien choisi, ce qui évite
 * que tout le monde retrouve d'un coup les largeurs par défaut du registre.
 * Plus personne ne l'écrit.
 */
export const id = '013-peek-widths-per-resource'
export const description = 'users.peek_widths — largeur du side-peek mémorisée par ressource'

export function up(db) {
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name)
  if (cols.includes('peek_widths')) return { added: false }
  db.exec('ALTER TABLE users ADD COLUMN peek_widths TEXT')
  return { added: true }
}
