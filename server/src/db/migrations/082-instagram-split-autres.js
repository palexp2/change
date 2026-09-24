/**
 * « Autres » mélangeait deux choses qui n'appellent pas le même message : les
 * gens qui posent une vraie question et ceux qui ont seulement réagi à une
 * publication. On vide leur rangement pour qu'ils repassent au tri.
 */
export const id = '082-instagram-split-autres'
export const description = 'Sépare la pile « Autres » en « posent une question » et « ont commenté »'

export function up(db) {
  db.exec(`
    UPDATE instagram_prospects
    SET segment = NULL, segment_at = NULL, segment_source = NULL
    WHERE segment = 'autre' AND COALESCE(segment_source,'') <> 'manual'
  `)
}
