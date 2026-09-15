/**
 * Une fiche de prospect Instagram ne savait décrire qu'un commentateur : texte
 * du commentaire, publication commentée, nombre de commentaires. Quelqu'un
 * capté parce qu'il a réagi à une story, écrit en privé, ou simplement parce
 * qu'il est dans l'audience ManyChat n'a rien de tout ça — sa fiche s'affichait
 * donc vide, sans qu'on puisse dire d'où elle venait.
 *
 * On ajoute de quoi qualifier la captation, sans toucher à une seule colonne
 * existante : l'historique reste lisible tel quel.
 */
export const id = '057-instagram-prospect-capture'
export const description = "Origine de captation et dernière activité sur les fiches de prospects Instagram"

const COLUMNS = [
  // Nature de la PREMIÈRE captation — écrite à la création, jamais réécrite,
  // comme `source`. C'est elle qui porte la pastille dans la liste.
  ['capture_kind', 'TEXT'],
  // Dernière activité, toutes natures confondues : une fiche sans commentaire
  // a quand même une date qui bouge.
  ['last_event_kind', 'TEXT'],
  ['last_event_at', 'TEXT'],
  // Étiquettes ManyChat (séparées par des virgules) : souvent la seule
  // information qualifiante d'un contact qui n'a pas écrit un mot.
  ['manychat_tags', 'TEXT'],
  // Lien direct vers la fiche dans ManyChat, quand il est stable.
  ['manychat_url', 'TEXT'],
]

export function up(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(instagram_prospects)').all().map(c => c.name))
  for (const [name, type] of COLUMNS) {
    if (!existing.has(name)) db.exec(`ALTER TABLE instagram_prospects ADD COLUMN ${name} ${type}`)
  }
  // Tout l'historique vient du commentaire : rien d'autre n'existait.
  db.exec(`UPDATE instagram_prospects SET capture_kind = 'comment' WHERE capture_kind IS NULL`)
  db.exec(`
    UPDATE instagram_prospects
    SET last_event_kind = 'comment',
        last_event_at = COALESCE(last_comment_at, first_comment_at)
    WHERE last_event_at IS NULL
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ig_prospect_mcsid
    ON instagram_prospects(manychat_subscriber_id) WHERE manychat_subscriber_id IS NOT NULL
  `)
}
