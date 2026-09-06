/**
 * 018 — Signets du menu de gauche, par utilisateur.
 *
 * Une liste JSON ordonnée `[{ "to": "/champs/shipments", "label": "…" }, …]` :
 * les pages qu'un utilisateur épingle sous l'icône du tableau de bord, dans le
 * rail. C'est une préférence perso au même titre que `nav_hidden` / `nav_order`,
 * d'où sa place sur `users` plutôt qu'une table à part.
 */
export const id = '018-nav-bookmarks'
export const description = 'users.nav_bookmarks — pages épinglées dans le menu de gauche'

export function up(db) {
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name)
  if (cols.includes('nav_bookmarks')) return { added: false }
  db.exec("ALTER TABLE users ADD COLUMN nav_bookmarks TEXT DEFAULT '[]'")
  return { added: true }
}
