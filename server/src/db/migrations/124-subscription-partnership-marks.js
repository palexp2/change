/**
 * 124 — Couples abonnement/contact déjà poussés vers HubSpot par
 * l'automatisation « Programme partenaire → HubSpot » (2026-10-08).
 */
export const id = '124-subscription-partnership-marks'
export const description = 'subscription_partnership_marks : un envoi HubSpot par couple abonnement/contact'

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscription_partnership_marks (
      subscription_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      detail TEXT,
      at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (subscription_id, contact_id)
    )
  `)
}
