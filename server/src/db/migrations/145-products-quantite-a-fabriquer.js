/**
 * 145 — Pièces : champ « À fabriquer », calculé par Boréal.
 *
 * Demande de Charles (2026-10-16) : voir dans la table combien fabriquer pour
 * atteindre le seuil minimal. Même règle que l'étape « Production » de la
 * priorité d'assemblage : produit Fabriqué → max(0, seuil min. produits finis
 * − sera disponible), arrondi au supérieur ; vide sinon. Écrit par
 * services/dynamicThresholdWatcher.js. Champ natif (pas d'Airtable).
 */
import { newRecordId } from '../../utils/recordId.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '145-products-quantite-a-fabriquer'
export const description = 'Pièces : champ « À fabriquer » calculé par Boréal'

const T = 'products'
const COLUMN = 'quantite_a_fabriquer'

export function up(d) {
  const cols = new Set(d.pragma(`table_xinfo(${T})`).map(c => c.name))
  if (!cols.has(COLUMN)) d.exec(`ALTER TABLE ${T} ADD COLUMN ${COLUMN} INTEGER`)
  const field = d.prepare('SELECT id FROM custom_fields WHERE erp_table=? AND column_name=?').get(T, COLUMN)
  if (field) {
    d.prepare(`UPDATE custom_fields SET deleted_at=NULL, kind='data', type='number', decimals=0 WHERE id=?`).run(field.id)
  } else {
    const order = d.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM custom_fields WHERE erp_table=?').get(T).n
    d.prepare(`INSERT INTO custom_fields (id, erp_table, name, column_name, type, decimals, kind, sort_order, source)
               VALUES (?,?,?,?,'number',0,'data',?,'native')`)
      .run(newRecordId(), T, 'À fabriquer', COLUMN, order)
  }
  regenerateView(T)
  return { added: `${T}.${COLUMN}` }
}
