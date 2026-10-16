/**
 * 139 — Retours : champ « Issue GitHub » (lien modifiable).
 *
 * Demande de Pierre-Alexandre Papillon (2026-10-15, /retours?vue=bor7SvqpqO3cOYEXU).
 * Lien vers l'issue GitHub du retour, saisi dans la fiche ou dès le formulaire
 * « Nouveau retour » de la fiche entreprise. Champ natif (pas d'Airtable) :
 * il apparaît seul dans la carte de champs de la fiche et dans /champs/retours.
 */
import { newRecordId } from '../../utils/recordId.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '139-retours-issue-github'
export const description = 'Retours : champ URL « Issue GitHub » (cf_issue_github)'

const TABLE = 'returns'
const COLUMN = 'cf_issue_github'

export function up(d) {
  const cols = new Set(d.pragma(`table_xinfo(${TABLE})`).map(c => c.name))
  if (!cols.has(COLUMN)) d.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} TEXT`)
  const field = d.prepare('SELECT id FROM custom_fields WHERE erp_table=? AND column_name=?').get(TABLE, COLUMN)
  if (field) {
    d.prepare(`UPDATE custom_fields SET deleted_at=NULL, kind='data', type='url' WHERE id=?`).run(field.id)
  } else {
    const order = d.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM custom_fields WHERE erp_table=?').get(TABLE).n
    d.prepare(`INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind, sort_order, source)
               VALUES (?,?,?,?,'url','data',?,'native')`)
      .run(newRecordId(), TABLE, 'Issue GitHub', COLUMN, order)
  }
  regenerateView(TABLE)
  return { column: COLUMN }
}
