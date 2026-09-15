/**
 * Messages Instagram écrits d'avance, puis envoyés tout seuls.
 *
 * Le brouillon n'est pas un champ de la fiche de prospect : une même personne
 * peut en recevoir plusieurs au fil du temps, et chacun porte son propre état
 * (écrit, en file, retenu, à revoir, parti, refusé). D'où une table à part.
 *
 * `status` :
 *   draft   — écrit, pas encore en file
 *   queued  — partira tout seul à `scheduled_at`
 *   review  — ne partira jamais sans un clic de Philippe
 *   held    — retenu à la main
 *   sent    — parti
 *   failed  — refusé par ManyChat/Instagram (la raison est dans `error`)
 *   dropped — écarté
 */
export const id = '062-instagram-drafts'
export const description = 'Brouillons de messages Instagram et leur file d’envoi'

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS instagram_drafts (
      id TEXT PRIMARY KEY,
      prospect_id TEXT NOT NULL,
      manychat_user_id TEXT,
      ig_username TEXT,
      text TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      review_reason TEXT,
      instructions TEXT,
      model TEXT,
      generated_at TEXT,
      scheduled_at TEXT,
      sent_at TEXT,
      error TEXT,
      edited INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ig_drafts_status ON instagram_drafts(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_ig_drafts_prospect ON instagram_drafts(prospect_id);
    -- Un seul brouillon vivant par personne : on ne veut pas que deux passages
    -- de rédaction fabriquent deux messages qui partiraient tous les deux.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ig_drafts_open
      ON instagram_drafts(prospect_id)
      WHERE status IN ('draft','queued','review','held');
  `)
}
