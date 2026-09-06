/**
 * 003 — Retire `automations.table_id`, référence pendante vers base_tables.
 *
 * Ce que la migration 002 a appris à ses dépens. Supprimer `base_tables` a cassé
 * tout INSERT sur `automations`, et donc le démarrage du serveur, avec
 * « no such table: main.base_tables ». La cause : la table `automations` EN BASE
 * porte une colonne `table_id TEXT REFERENCES base_tables(id)` — vestige du
 * moteur de tables générique — que le DDL de schema.js ne déclare pas. Comme
 * `foreign_keys = ON` (db/database.js), SQLite résout la table cible d'une clé
 * étrangère au moment du `prepare`, pas de l'exécution : la simple préparation
 * de l'INSERT échoue, avant même qu'une ligne soit écrite.
 *
 * Deux enseignements, tous deux appliqués :
 *
 *  1. `PRAGMA foreign_key_check` ne détecte PAS ce cas. Il vérifie les valeurs
 *     orphelines, pas les cibles manquantes — il répondait « 0 violation » sur
 *     une base pourtant incapable d'écrire dans `automations`. Le contrôle qui
 *     manquait est désormais dans db/schemaDrift.js (`danglingReferences`), qui
 *     relit le DDL de chaque table à la recherche d'un `REFERENCES` vers une
 *     table absente.
 *
 *  2. Chercher un nom de table dans les sources ne suffit pas à conclure qu'elle
 *     est morte. `base_tables` n'apparaissait dans aucun fichier de server/src ni
 *     client/src — la dépendance vivait dans le SCHÉMA de la base, pas dans le
 *     code. Avant tout DROP TABLE : chercher aussi les `REFERENCES` dans
 *     sqlite_master.
 *
 * La colonne est bien morte : 0 valeur non nulle, aucune occurrence dans les
 * sources, aucun index ni vue ni trigger dessus. `ALTER TABLE … DROP COLUMN`
 * est disponible (SQLite 3.45.3).
 */

export const id = '003-drop-automations-table-id'
export const description = 'Retire automations.table_id (REFERENCES base_tables, table supprimée en 002)'

export function up(db) {
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='automations'").get()?.sql
  if (!ddl) return
  const cols = db.prepare('PRAGMA table_info(automations)').all().map(c => c.name)
  if (!cols.includes('table_id')) return

  // Refus de supprimer une colonne qui porterait encore de la donnée : la
  // migration doit échouer bruyamment plutôt que jeter des valeurs en silence.
  const used = db.prepare('SELECT COUNT(*) AS n FROM automations WHERE table_id IS NOT NULL').get().n
  if (used > 0) {
    throw new Error(`automations.table_id porte ${used} valeur(s) non nulle(s) — suppression refusée, à trancher à la main`)
  }

  db.exec('ALTER TABLE automations DROP COLUMN table_id')
}
