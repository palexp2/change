/**
 * Ce qu'une personne a FAIT, pas seulement d'où elle vient.
 *
 * « Dans l'audience ManyChat » ne dit rien à qui doit décider s'il vaut la
 * peine d'écrire. ManyChat sait, lui : le commentaire déclencheur avec son
 * texte et le lien de la publication, le lien cliqué, le message reçu. On
 * range ce geste sur la fiche, avec son lien quand il existe.
 */
export const id = '061-prospect-capture-activity'
export const description = 'Geste de captation et son lien, sur la fiche et sur les messages'

export function up(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(instagram_prospects)').all().map(c => c.name))
  if (!cols.has('capture_label')) db.exec('ALTER TABLE instagram_prospects ADD COLUMN capture_label TEXT')
  if (!cols.has('capture_url')) db.exec('ALTER TABLE instagram_prospects ADD COLUMN capture_url TEXT')

  const mcols = new Set(db.prepare('PRAGMA table_info(manychat_messages)').all().map(c => c.name))
  if (!mcols.has('link_url')) db.exec('ALTER TABLE manychat_messages ADD COLUMN link_url TEXT')
}
