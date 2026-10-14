/**
 * 127 — Prospects Instagram : une réponse publique AUTOMATIQUE ne vaut pas contact.
 *
 * La lecture des commentaires rangeait « déjà traité » (contacted_source =
 * 'public_reply') quiconque avait une réponse de notre compte sous son
 * commentaire — y compris la réponse instantanée d'un robot. Résultat : 81
 * personnes des semaines 40-41 (dont tous les « partner ») cachées à Philippe
 * alors que personne ne leur avait parlé (Charles, 2026-10-10).
 *
 * On rouvre celles dont la « réponse » est arrivée moins de 5 minutes après le
 * commentaire. `notified_at` n'est pas touché : elles ne repartent pas dans la
 * liste Slack, elles réapparaissent dans la page Instagram.
 */
export const id = '127-instagram-auto-reply-not-contacted'
export const description = 'Prospects Instagram : réponse publique instantanée ≠ contacté'

export function up(db) {
  db.prepare(`
    UPDATE instagram_prospects
    SET contacted = 0, contacted_source = NULL, contacted_at = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE contacted = 1 AND contacted_source = 'public_reply'
      AND first_comment_at IS NOT NULL AND contacted_at IS NOT NULL
      AND (julianday(contacted_at) - julianday(first_comment_at)) * 86400 < 300
  `).run()
}
