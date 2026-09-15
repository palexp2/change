/**
 * Conversations Instagram tenues dans ManyChat, copiées dans l'ERP pour que
 * Philippe les lise et y réponde sans changer d'outil.
 *
 * Le contact ManyChat porte son propre numéro, sans rapport avec celui
 * qu'Instagram donne à la même personne : le rapprochement avec une fiche de
 * prospect se fait par le nom d'usager, quand il est connu (il n'apparaît
 * qu'une fois que la personne a répondu).
 */
export const id = '059-manychat-threads'
export const description = 'Conversations et messages ManyChat'

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS manychat_threads (
      user_id TEXT PRIMARY KEY,
      ig_id TEXT,
      ig_username TEXT,
      full_name TEXT,
      status TEXT,
      optin INTEGER NOT NULL DEFAULT 0,
      subscribed_at TEXT,
      last_message_text TEXT,
      last_message_at TEXT,
      last_direction TEXT,
      last_incoming_at TEXT,
      prospect_id TEXT,
      messages_synced_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mc_threads_last ON manychat_threads(last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mc_threads_username ON manychat_threads(ig_username) WHERE ig_username IS NOT NULL;

    CREATE TABLE IF NOT EXISTS manychat_messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      text TEXT,
      kind TEXT,
      sent_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mc_messages_thread ON manychat_messages(user_id, sent_at);
  `)
}
