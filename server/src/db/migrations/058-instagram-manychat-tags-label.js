/**
 * La colonne créée dans Airtable s'appelle « Tags Manychat » (c minuscule) ;
 * le code visait « Tags ManyChat ». Airtable est sensible à la casse et
 * refusait l'écriture entière de la fiche (UNKNOWN_FIELD_NAME), pas seulement
 * ce champ. On aligne le nom stocké sur ce qui existe réellement.
 *
 * Le complément additif du field_map au démarrage n'aurait pas corrigé la
 * valeur : il n'ajoute que les clés absentes.
 */
export const id = '058-instagram-manychat-tags-label'
export const description = "Aligne le nom du champ Airtable « Tags Manychat » sur la colonne réelle"

export function up(db) {
  const row = db.prepare("SELECT field_map FROM airtable_module_config WHERE module='instagram'").get()
  if (!row?.field_map) return
  let map
  try { map = JSON.parse(row.field_map) } catch { return }
  if (map.manychat_tags !== 'Tags ManyChat') return
  map.manychat_tags = 'Tags Manychat'
  db.prepare("UPDATE airtable_module_config SET field_map=? WHERE module='instagram'").run(JSON.stringify(map))
}
