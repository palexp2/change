/**
 * 014 — Description libre d'un champ.
 *
 * Un champ (perso OU natif personnalisé — les deux vivent dans `custom_fields`,
 * les natifs sous kind='native') peut porter un texte d'aide : provenance,
 * unité, règle de calcul. Il s'affiche en infobulle derrière un petit « ? »
 * gris à côté du titre de la colonne dans tous les DataTables, exactement
 * comme les descriptions déjà codées en dur dans tableDefs.js (que celle-ci
 * remplace quand elle est renseignée).
 *
 * NULL / vide = pas de description.
 */
export const id = '014-custom-field-description'
export const description = "custom_fields.description — texte d'aide affiché en infobulle dans l'en-tête de colonne"

export function up(db) {
  const cols = db.prepare('PRAGMA table_info(custom_fields)').all().map(c => c.name)
  if (cols.includes('description')) return { added: false }
  db.exec('ALTER TABLE custom_fields ADD COLUMN description TEXT')
  return { added: true }
}
