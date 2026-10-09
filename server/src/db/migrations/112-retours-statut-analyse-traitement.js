/**
 * 112 — Retours : statut En retour / À analyser / À traiter / Traité / Analysé.
 *
 * Demande de Pierre-Alexandre Papillon (2026-10-05, /retours?vue=bor7SvqpqO3cOYEXU).
 * La formule « Statut » avait été réduite à `1` : aucune vue ne filtrait plus.
 *
 *   - « En retour »  : au moins un article à recevoir ;
 *   - « À analyser » : tout est reçu, au moins un article à analyser ;
 *   - « À traiter »  : rien à analyser, au moins un article de fin
 *                      d'abonnement / changement d'idée / erreur de commande
 *                      pas encore coché « Traité » ;
 *   - « Traité »     : tous ces articles-là sont cochés ;
 *   - « Analysé »    : sinon (garanties analysées, équipement de courtoisie).
 *
 * Un article est « à analyser » s'il n'a ni date d'analyse ni analyste, et que
 * sa raison n'est pas l'une des quatre qui ne s'analysent pas (fin
 * d'abonnement, changement d'idée, erreur de commande, courtoisie). L'analyste
 * compte : les 135 articles d'avant 2024 sans raison ont tous un « Analysé
 * par » mais pas de date.
 *
 * Même montage que 069 : la condition vit dans une colonne générée de
 * return_items, le retour en fait la somme (rollup), le statut est une formule.
 * Le « Traité » est un nouveau champ case à cocher PAR ARTICLE ; il est
 * pré-coché sur les articles des retours déjà marqués « Traité » au niveau du
 * retour (champ « Statut de traitement »).
 */
import { newRecordId } from '../../utils/recordId.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '112-retours-statut-analyse-traitement'
export const description =
  'Retours : statut En retour / À analyser / À traiter / Traité / Analysé, case « Traité » par article'

const PARENT = 'returns'
const CHILD = 'return_items'
const TRAITE = 'cf_traite'

const sqlList = arr => `(${arr.map(s => `'${s.replace(/'/g, "''")}'`).join(', ')})`
// Libellés tels qu'en base (« à changé » avec l'accent, comme les choix du champ).
const A_TRAITER = ["Fin d'abonnement", "Le client à changé d'idée", 'Erreur de commande']
const SANS_ANALYSE = [...A_TRAITER, "Retour d'équipement de courtoisie"]
const empty = c => `(${c} IS NULL OR ${c} = '')`

const GENERATED = [
  { column: 'item_a_analyser', expr:
    `CASE WHEN COALESCE(return_reason, '') NOT IN ${sqlList(SANS_ANALYSE)} ` +
    `AND ${empty('date_d_analyse')} AND ${empty('analyzed_by')} THEN 1 ELSE 0 END` },
  { column: 'item_traitable', expr:
    `CASE WHEN return_reason IN ${sqlList(A_TRAITER)} THEN 1 ELSE 0 END` },
  { column: 'item_a_traiter', expr:
    `CASE WHEN return_reason IN ${sqlList(A_TRAITER)} AND COALESCE(${TRAITE}, 0) = 0 THEN 1 ELSE 0 END` },
]

const ROLLUPS = [
  { column: 'cf_items_a_analyser', name: 'Items à analyser', target: 'item_a_analyser' },
  { column: 'cf_items_traitables', name: 'Items à traitement', target: 'item_traitable' },
  { column: 'cf_items_a_traiter', name: 'Items à traiter', target: 'item_a_traiter' },
]

const STATUT_FORMULA =
  'IF(cf_nb_items = 0, "Aucun item à retourner", ' +
  'IF(cf_items_a_recevoir > 0, "En retour", ' +
  'IF(cf_items_a_analyser > 0, "À analyser", ' +
  'IF(cf_items_a_traiter > 0, "À traiter", ' +
  'IF(cf_items_traitables > 0, "Traité", "Analysé")))))'

const nextOrder = (d, table) =>
  d.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM custom_fields WHERE erp_table=?`).get(table).n

export function up(d) {
  const report = {}

  // 1. Case « Traité » par article.
  const childCols = () => new Set(d.pragma(`table_xinfo(${CHILD})`).map(c => c.name))
  if (!childCols().has(TRAITE)) d.exec(`ALTER TABLE ${CHILD} ADD COLUMN ${TRAITE} INTEGER`)
  const field = d.prepare(`SELECT id FROM custom_fields WHERE erp_table=? AND column_name=?`).get(CHILD, TRAITE)
  if (field) {
    d.prepare(`UPDATE custom_fields SET deleted_at=NULL, kind='data', type='checkbox' WHERE id=?`).run(field.id)
  } else {
    d.prepare(`INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind, sort_order, source)
               VALUES (?,?,?,?,'checkbox','data',?,'native')`)
      .run(newRecordId(), CHILD, 'Traité', TRAITE, nextOrder(d, CHILD))
  }
  report.backfill = d.prepare(`
    UPDATE ${CHILD} SET ${TRAITE} = 1
    WHERE return_reason IN ${sqlList(A_TRAITER)} AND COALESCE(${TRAITE}, 0) = 0
      AND return_id IN (SELECT id FROM ${PARENT} WHERE cf_traite = 'Traité')
  `).run().changes

  // 2. Conditions par article (colonnes générées : rien de stocké).
  const cols = childCols()
  for (const g of GENERATED) {
    if (cols.has(g.column)) continue
    d.exec(`ALTER TABLE ${CHILD} ADD COLUMN ${g.column} INTEGER GENERATED ALWAYS AS (${g.expr}) VIRTUAL`)
  }

  // 3. Compteurs du retour, visibles dans /champs/retours.
  for (const r of ROLLUPS) {
    const existing = d.prepare(`SELECT id FROM custom_fields WHERE erp_table=? AND column_name=?`).get(PARENT, r.column)
    if (existing) {
      d.prepare(`UPDATE custom_fields SET deleted_at=NULL, kind='rollup', type='number',
                   rollup_target_table=?, rollup_target_fk='return_id', rollup_target_column=?,
                   rollup_agg='SUM', result_type='number', view_error=NULL WHERE id=?`)
        .run(CHILD, r.target, existing.id)
      continue
    }
    d.prepare(`INSERT INTO custom_fields
        (id, erp_table, name, column_name, type, kind, sort_order, source,
         rollup_target_table, rollup_target_fk, rollup_target_column, rollup_agg, result_type)
      VALUES (?,?,?,?,'number','rollup',?,'native',?,'return_id',?,'SUM','number')`)
      .run(newRecordId(), PARENT, r.name, r.column, nextOrder(d, PARENT), CHILD, r.target)
  }

  // 4. Le statut.
  report.statut = d.prepare(`UPDATE custom_fields SET kind='formula', type='text', formula_expr=?,
                 result_type='text', options=NULL, view_error=NULL,
                 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE erp_table=? AND column_name='cf_statut' AND deleted_at IS NULL`)
    .run(STATUT_FORMULA, PARENT).changes

  // 5. Vues : « En transit » (vidée) → « En retour » ; « À traiter » visait
  //    l'ancien libellé « En transit », il filtre désormais sur le statut.
  const pills = d.prepare(`SELECT id, label, filters FROM table_view_pills WHERE table_name='retours'`).all()
  const rulesOf = p => { try { const f = JSON.parse(p.filters || '[]'); return Array.isArray(f) ? f : (f?.rules || []) } catch { return [] } }
  const setFilter = (p, label, value) => d.prepare('UPDATE table_view_pills SET label=?, filters=? WHERE id=?').run(
    label, JSON.stringify({ conjunction: 'AND', rules: [{ field: 'cf_statut', op: 'equals', value }] }), p.id)
  report.pills = []
  for (const p of pills) {
    const l = p.label.toLowerCase()
    if (l === 'en transit' && !rulesOf(p).length) { setFilter(p, 'En retour', 'En retour'); report.pills.push(p.id) }
    if (l === 'à traiter' && rulesOf(p).some(r => r.value === 'En transit')) { setFilter(p, p.label, 'À traiter'); report.pills.push(p.id) }
  }

  regenerateView(CHILD)
  regenerateView(PARENT)
  return report
}
