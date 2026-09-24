/**
 * La liste Instagram ne savait pas dire CE QUE la personne demande.
 *
 * Trois demandes très différentes arrivent par le même tuyau : celle qui a
 * écrit « coach », celle qui fait pousser des fleurs, et celle qui s'est
 * abonnée sans rien dire. Chacune appelle un message différent, donc chacune
 * doit avoir sa pile.
 *
 * On range aussi les robots : détectés, ils quittent la liste pour de bon, et
 * un nom d'usager écarté ne peut plus revenir par une lecture suivante.
 */
export const id = '081-instagram-segments'
export const description = 'Type de demande, verdict robot et liste des comptes écartés (Instagram)'

const COLUMNS = [
  // 'coach' | 'fleurs' | 'abonne' | 'autre' | 'robot' | 'story'
  ['segment', 'TEXT'],
  // 'ai' | 'rule' | 'manual' — un choix humain ne se fait jamais écraser.
  ['segment_source', 'TEXT'],
  ['segment_at', 'TEXT'],
  // Ce que la lecture automatique a retenu contre la fiche, pour pouvoir
  // expliquer une suppression.
  ['bot_score', 'INTEGER'],
  ['bot_reason', 'TEXT'],
]

export function up(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(instagram_prospects)').all().map(c => c.name))
  for (const [name, type] of COLUMNS) {
    if (!cols.has(name)) db.exec(`ALTER TABLE instagram_prospects ADD COLUMN ${name} ${type}`)
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ig_prospect_segment ON instagram_prospects(segment) WHERE deleted_at IS NULL`)

  // Un robot écarté ne doit pas réapparaître à la lecture suivante : la clé de
  // dédoublonnage ne protège que les fiches vivantes.
  db.exec(`
    CREATE TABLE IF NOT EXISTS instagram_blocked (
      ig_username TEXT PRIMARY KEY,
      reason TEXT,
      score INTEGER,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `)
}
