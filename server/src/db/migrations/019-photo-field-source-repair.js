/**
 * 019 — réparation : « Photo » des employés reste un champ créé dans l'ERP.
 *
 * Le champ perso « Photo » (employees.cf_photo) a été créé ici puis mappé sur le
 * champ Airtable du même nom. Une version intermédiaire de la route de mapping
 * repassait `custom_fields.source` à 'airtable' à cette occasion — or `source`
 * dit d'où vient la DÉFINITION du champ, pas qui écrit sa valeur, et les fiches
 * n'affichent que les champs 'native' (useExtraCustomFields) : la photo
 * disparaissait de la fiche employé, le seul endroit où on veut la voir.
 *
 * La route ne fait plus ça (la lecture seule vient du mapping actif, cf.
 * services/customFieldWritability.js) ; il reste à remettre la ligne d'aplomb.
 *
 * Idempotent : ne touche que cette colonne, et seulement si elle est encore
 * marquée 'airtable'.
 */
export const id = '019-photo-field-source-repair'
export const description = "employees.cf_photo : source remise à 'native'"

export function up(db) {
  const row = db.prepare(
    `SELECT id, source FROM custom_fields
      WHERE erp_table='employees' AND column_name='cf_photo' AND deleted_at IS NULL`
  ).get()
  if (!row) return { skipped: 'champ Photo absent' }
  if (row.source !== 'airtable') return { skipped: `source déjà « ${row.source} »` }

  db.prepare("UPDATE custom_fields SET source='native' WHERE id=?").run(row.id)
  return { repaired: 'employees.cf_photo' }
}
