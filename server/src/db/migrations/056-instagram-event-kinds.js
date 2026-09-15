/**
 * Élargit les natures d'événement d'un prospect Instagram.
 *
 * Jusqu'ici une fiche ne pouvait naître que d'un commentaire, d'un message
 * privé envoyé ou d'une réponse. ManyChat, lui, connaît des gens captés
 * autrement : une réaction à une story, un message privé reçu, ou simplement
 * « cette personne est dans notre audience ». Ces natures étaient refusées deux
 * fois — par une liste en dur côté code, et par la contrainte CHECK de cette
 * table.
 *
 * SQLite ne sait pas modifier un CHECK : il faut reconstruire la table. Le
 * littéral correspondant de schema.js est mis à jour en parallèle pour qu'une
 * base neuve (tests, poste neuf) naisse avec le même schéma que la production.
 */
export const id = '056-instagram-event-kinds'
export const description = 'Ouvre instagram_prospect_events aux natures follow / story_reaction / dm_in / contact'

export function up(db) {
  // Base neuve : schema.js a déjà créé la table avec le CHECK à jour, il n'y a
  // rien à reconstruire. On le vérifie plutôt que de le supposer.
  const ddl = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='instagram_prospect_events'"
  ).get()?.sql || ''
  if (!ddl) return
  if (ddl.includes("'contact'")) return

  db.exec(`
    CREATE TABLE instagram_prospect_events_new (
      id TEXT PRIMARY KEY,
      prospect_id TEXT REFERENCES instagram_prospects(id),
      event_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('comment','dm_sent','reply','follow','story_reaction','dm_in','contact')),
      payload TEXT,
      occurred_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO instagram_prospect_events_new (id, prospect_id, event_key, kind, payload, occurred_at, created_at)
      SELECT id, prospect_id, event_key, kind, payload, occurred_at, created_at FROM instagram_prospect_events;
    DROP TABLE instagram_prospect_events;
    ALTER TABLE instagram_prospect_events_new RENAME TO instagram_prospect_events;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ig_event_key ON instagram_prospect_events(event_key);
    CREATE INDEX IF NOT EXISTS idx_ig_event_prospect ON instagram_prospect_events(prospect_id, kind);
  `)
}
