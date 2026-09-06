/**
 * 008 — les prospects Instagram ne se purgent pas.
 *
 * Le registre des miroirs a été rempli avec `purge_orphans = 1` par défaut,
 * alors que la fonction historique `syncInstagramProspects` ne purge RIEN, et
 * pour une bonne raison : l'ERP est la source de vérité des prospects (la fiche
 * naît de l'appel de ManyChat), et effacer une fiche ferait perdre la mémoire
 * du DM déjà envoyé — donc rouvrirait la porte à un second contact.
 *
 * Tant qu'`instagram` restait sur le moteur historique, le drapeau ne servait à
 * personne. Le moteur unique, lui, l'applique : sans cette correction, sa
 * première exécution supprimerait les prospects absents d'Airtable.
 */
export const id = '008-instagram-no-purge'
export const description = 'instagram : purge_orphans = 0 dans le registre des miroirs'

export function up(db) {
  const r = db.prepare("UPDATE airtable_mirrors SET purge_orphans=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='instagram'").run()
  return { mirrors_updated: r.changes }
}
