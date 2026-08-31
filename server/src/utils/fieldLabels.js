import db from '../db/database.js'

// Unicité des libellés de champs d'une table.
//
// Un même libellé sur deux colonnes rend l'interface ambiguë (sélecteurs de
// champs, filtres, formules, mapping Airtable désignent tous le champ par son
// nom affiché). Une seule source définit ces libellés depuis l'unification :
// `custom_fields.name` — pour les champs personnalisés comme pour le renommage
// d'un champ natif (kind='native', voir la migration dans db/schema.js).
// Les champs natifs non renommés vivent côté client (tableDefs.js) : le serveur
// ne les connaît pas, la page de configuration des champs fait donc le contrôle
// complet avant d'appeler l'API — ici on garde le filet côté serveur sur ce que
// la DB sait, pour que l'API reste cohérente hors de cette page.

function norm(label) {
  return String(label || '').trim().toLowerCase()
}

// Retourne le libellé en conflit (tel qu'enregistré) ou null si disponible.
// `exclude` : { customFieldId, fieldId } — l'entrée en cours de modification.
export function findLabelConflict(erpTable, label, exclude = {}) {
  const target = norm(label)
  if (!target) return null

  const cfs = db.prepare(
    `SELECT id, name, column_name FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL`
  ).all(erpTable)
  for (const f of cfs) {
    if (exclude.customFieldId && f.id === exclude.customFieldId) continue
    // Un override porte le nom de la colonne : renommer un champ perso par
    // cette voie ne doit pas entrer en conflit avec lui-même.
    if (exclude.fieldId && f.column_name === exclude.fieldId) continue
    if (norm(f.name) === target) return f.name
  }

  return null
}

// Message d'erreur uniforme (réponse 409).
export function labelConflictError(label) {
  return `Un autre champ de cette table s'appelle déjà « ${label} » — les noms de champs doivent être uniques`
}
