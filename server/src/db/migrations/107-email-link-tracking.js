/**
 * 107 — Suivi des liens des courriels envoyés depuis Boréal.
 *
 * Chaque lien d'un courriel envoyé passe par /api/track/click/:id
 * (services/emailTracking.js) : email_links garde l'adresse d'origine,
 * email_clicks une ligne par clic. email_tracked marque les courriels partis
 * avec le suivi, pour que leur fiche dans le fil affiche « 0 ouverture » plutôt
 * que rien — amorcée avec les envois d'avant qui portaient déjà le pixel.
 */

export const id = '107-email-link-tracking'
export const description = 'Suivi des clics sur les liens des courriels envoyés'

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_links (
      id TEXT PRIMARY KEY,
      email_id TEXT NOT NULL,
      url TEXT NOT NULL,
      label TEXT,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_email_links_email ON email_links(email_id, position);
    CREATE TABLE IF NOT EXISTS email_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id TEXT NOT NULL,
      email_id TEXT NOT NULL,
      clicked_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_email_clicks_link ON email_clicks(link_id, clicked_at);
    CREATE INDEX IF NOT EXISTS idx_email_clicks_email ON email_clicks(email_id);
    CREATE TABLE IF NOT EXISTS email_tracked (
      email_id TEXT PRIMARY KEY,
      tracked_at TEXT NOT NULL
    );
  `)
  try { db.exec('ALTER TABLE emails ADD COLUMN click_count INTEGER DEFAULT 0') } catch { /* déjà là */ }
  db.exec(`
    INSERT OR IGNORE INTO email_tracked (email_id, tracked_at)
      SELECT e.id, COALESCE(i.timestamp, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) FROM emails e
      LEFT JOIN interactions i ON i.id = e.interaction_id
      WHERE e.first_opened_at IS NOT NULL
        OR e.body_html LIKE '%/api/track/email/%' OR e.body_html LIKE '%/api/email-tracking/%'
        OR e.id IN (SELECT email_id FROM soumission_sends)
  `)
}
