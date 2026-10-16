/**
 * 141 — « Issue GitHub » passe du retour à ses ARTICLES.
 *
 * Demande de Pierre-Alexandre Papillon (2026-10-15) : le lien vers l'issue
 * GitHub qualifie un article (un appareil, un problème), pas le retour entier.
 * La 139 l'avait posé sur `returns` le même jour ; il naît ici sur
 * `return_items` (champ natif URL, pas d'Airtable, comme `cf_traite`) et
 * quitte `returns`.
 *
 * Valeurs déjà saisies sur un retour : recopiées sur chacun de ses articles
 * qui n'en ont pas, AVANT le drop (0 au moment de l'écriture).
 *
 * Défensive : garde-fous en `skipped` (une exception arrêterait le démarrage).
 */
import { newRecordId } from '../../utils/recordId.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '141-retours-issue-github-to-items'
export const description = 'Issue GitHub : champ des articles de retour (retiré du retour)'

const COLUMN = 'cf_issue_github'
const FROM = 'returns'
const TO = 'return_items'

export function up(d) {
  // 1. Le champ sur les articles.
  const itemCols = new Set(d.pragma(`table_xinfo(${TO})`).map(c => c.name))
  if (!itemCols.has(COLUMN)) d.exec(`ALTER TABLE ${TO} ADD COLUMN ${COLUMN} TEXT`)
  const field = d.prepare('SELECT id FROM custom_fields WHERE erp_table=? AND column_name=?').get(TO, COLUMN)
  if (field) {
    d.prepare(`UPDATE custom_fields SET deleted_at=NULL, kind='data', type='url' WHERE id=?`).run(field.id)
  } else {
    const order = d.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM custom_fields WHERE erp_table=?').get(TO).n
    d.prepare(`INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind, sort_order, source)
               VALUES (?,?,?,?,'url','data',?,'native')`)
      .run(newRecordId(), TO, 'Issue GitHub', COLUMN, order)
  }
  regenerateView(TO)

  // 2. Report puis retrait côté retour.
  const retCols = new Set(d.pragma(`table_info(${FROM})`).map(c => c.name))
  if (!retCols.has(COLUMN)) return { added: `${TO}.${COLUMN}`, skipped: `${FROM}.${COLUMN} déjà absente` }
  const copied = d.prepare(`
    UPDATE ${TO} SET ${COLUMN} = (SELECT r.${COLUMN} FROM ${FROM} r WHERE r.id = ${TO}.return_id)
    WHERE (${COLUMN} IS NULL OR ${COLUMN} = '')
      AND return_id IN (SELECT id FROM ${FROM} WHERE ${COLUMN} IS NOT NULL AND ${COLUMN} != '')
  `).run().changes
  // Un retour avec un lien mais sans article perdrait sa valeur : on s'arrête.
  const orphan = d.prepare(`
    SELECT COUNT(*) AS n FROM ${FROM} r
    WHERE r.${COLUMN} IS NOT NULL AND r.${COLUMN} != ''
      AND NOT EXISTS (SELECT 1 FROM ${TO} ri WHERE ri.return_id = r.id)
  `).get().n
  if (orphan) return { added: `${TO}.${COLUMN}`, copied, skipped: `${orphan} retour(s) sans article portent un lien` }

  d.exec(`DROP VIEW IF EXISTS ${FROM}_v`)
  d.exec(`ALTER TABLE ${FROM} DROP COLUMN [${COLUMN}]`)
  d.prepare('DELETE FROM custom_fields WHERE erp_table=? AND column_name=?').run(FROM, COLUMN)
  regenerateView(FROM)
  return { added: `${TO}.${COLUMN}`, copied, dropped: `${FROM}.${COLUMN}` }
}
