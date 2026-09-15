/**
 * Fusionne les fiches en double nées de la première récolte ManyChat.
 *
 * ManyChat ne donne jamais l'identifiant Instagram d'une personne, seulement
 * son nom d'usager ; les fiches issues des commentaires sont, elles, classées
 * par identifiant. La première récolte a donc recréé une seconde fiche pour
 * les gens déjà connus. On garde la plus ancienne — celle qui porte l'historique
 * de commentaires et la case « contacté » — et on lui transmet ce que la fiche
 * ManyChat apportait.
 */
export const id = '060-merge-manychat-duplicates'
export const description = 'Fusionne les fiches de prospects dédoublées par nom d’usager'

export function up(db) {
  const dups = db.prepare(`
    SELECT lower(ig_username) u, COUNT(*) n
    FROM instagram_prospects
    WHERE deleted_at IS NULL AND ig_username IS NOT NULL
    GROUP BY u HAVING n > 1
  `).all()
  if (!dups.length) return

  const rowsFor = db.prepare(`
    SELECT * FROM instagram_prospects
    WHERE deleted_at IS NULL AND lower(ig_username) = ?
    ORDER BY created_at
  `)
  for (const d of dups) {
    const [keep, ...drops] = rowsFor.all(d.u)
    for (const drop of drops) {
      db.prepare(`
        UPDATE instagram_prospects SET
          manychat_subscriber_id = COALESCE(?, manychat_subscriber_id),
          manychat_url = COALESCE(manychat_url, ?),
          manychat_tags = COALESCE(manychat_tags, ?),
          full_name = COALESCE(full_name, ?),
          contacted = CASE WHEN contacted = 1 OR ? = 1 THEN 1 ELSE 0 END,
          dm_sent = CASE WHEN dm_sent = 1 OR ? = 1 THEN 1 ELSE 0 END,
          replied = CASE WHEN replied = 1 OR ? = 1 THEN 1 ELSE 0 END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
      `).run(
        drop.manychat_subscriber_id, drop.manychat_url, drop.manychat_tags, drop.full_name,
        drop.contacted, drop.dm_sent, drop.replied, keep.id,
      )
      db.prepare('UPDATE instagram_prospect_events SET prospect_id = ? WHERE prospect_id = ?').run(keep.id, drop.id)
      db.prepare('UPDATE manychat_threads SET prospect_id = ? WHERE prospect_id = ?').run(keep.id, drop.id)
      db.prepare(`
        UPDATE instagram_prospects
        SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
      `).run(drop.id)
    }
  }
}
