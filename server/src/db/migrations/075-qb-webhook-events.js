/**
 * 075 — Journal des avis instantanés de QuickBooks.
 *
 * Intuit rejoue un avis pendant plusieurs jours tant qu'il n'a pas reçu un 200,
 * et regroupe plusieurs entités dans un même appel : sans clé d'idempotence, une
 * saisie en lot ferait repartir la même vérification des dizaines de fois.
 *
 * La table sert AUSSI de journal visible (« dernier avis reçu il y a X ») : sans
 * elle, un jeton régénéré chez Intuit ferait tomber les avis en 401 silencieux
 * et personne ne s'en apercevrait — la page repasserait simplement à la
 * détection horaire, sans le dire.
 */
import db from '../database.js'

export const id = '075-qb-webhook-events'
export const description =
  "Journal d'idempotence des avis QuickBooks (entité, opération, compte touché, verdict)"

export function up(migrationDb) {
  const d = migrationDb || db
  d.exec(`
    CREATE TABLE IF NOT EXISTS qb_webhook_events (
      id            TEXT PRIMARY KEY,   -- sha1(realm|entité|id|opération|lastUpdated)
      realm_id      TEXT,
      entity        TEXT NOT NULL,
      entity_id     TEXT NOT NULL,
      operation     TEXT NOT NULL,      -- Create | Update | Delete | Void | Merge | Emailed
      last_updated  TEXT,
      account_ids   TEXT,               -- comptes ERP touchés, séparés par des virgules
      status        TEXT NOT NULL DEFAULT 'recu',   -- recu | traite | ignore | erreur
      note          TEXT,
      received_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      handled_at    TEXT
    )
  `)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_qb_webhook_events_received ON qb_webhook_events(received_at DESC)`)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_qb_webhook_events_entity ON qb_webhook_events(entity, entity_id)`)

  // Le classeur Google ne se remplit plus tout seul depuis que la lecture du
  // fichier est coupée : c'est Boréal qui l'écrit, et quelqu'un le consulte
  // encore. `default_active` du seed ne touche que les insertions — il faut
  // basculer la ligne existante une fois.
  d.prepare(`
    UPDATE automations SET active = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = 'sys_trx_sheet_mirror' AND deleted_at IS NULL
  `).run()
}
