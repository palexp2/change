/**
 * 069 — Retours : « Statut » redevient un statut, et la vue « En transit » filtre.
 *
 * ── Le signalement ────────────────────────────────────────────────────────
 * « Dans la liste des retours, il y a beaucoup plus de retours en transit que
 * dans Airtable » (/retours?vue=bor7SvqpqO3cOYEXU). Airtable en compte 12, la
 * vue « En transit » de Boréal en affichait 479 — c'est-à-dire TOUS les
 * retours. Deux causes cumulées :
 *
 *  1. la pill « En transit » (comme « À analyser » et « À traiter ») n'a jamais
 *     eu de condition : `filters = []` = aucun filtre = tout passe ;
 *  2. le champ « Statut » de la table Retours avait été réglé en ROLLUP
 *     ARRAYUNIQUE de `return_items.return_reason` : il affichait les RAISONS du
 *     retour (« Retour de garantie avec échange immédiat »…), jamais un statut.
 *     Il n'y avait donc rien sur quoi filtrer.
 *
 * ── Ce que « En transit » veut dire ───────────────────────────────────────
 * Le champ Airtable `Status` (fld7DFZqu5IN0ijUe) est une FORMULE :
 *
 *   IF(Items retour = "", "Aucun item à retourner",
 *   IF(Nombre d'items à recevoir > 0, "En transit",
 *   IF(Nombre d'items à analyser > 0, "À analyser", "Analyse complétée")))
 *
 * « Nombre d'items à recevoir » est un COUNT conditionnel des items liés dont
 * la date de réception est vide — condition reproduite à l'identique ici.
 *
 * La branche « À analyser », elle, n'est PAS reprise : les conditions d'un champ
 * COUNT ne sont pas exposées par l'API de métadonnées d'Airtable, et les données
 * ne permettent pas de les retrouver (au 2026-09-15, 158 retours ont un item
 * reçu sans date d'analyse, et Airtable n'en déclare qu'UN « À analyser »).
 * Boréal range donc ce retour-là sous « Analyse complétée ». C'est assumé : le
 * signalement porte sur « En transit », dont le compte est exact (11 = 11), et
 * inventer une condition en ferait un troisième comportement, différent des
 * deux autres.
 *
 * Boréal a tout ce qu'il faut pour le calculer lui-même : `return_items` est
 * mirroité avec sa `received_at`. Statut calculé plutôt qu'importé = juste dès
 * qu'un item est reçu, sans attendre le sync complet quotidien (une formule
 * Airtable qui change parce qu'un ENFANT a bougé ne modifie pas le record
 * parent, donc les webhooks ne la rapatrieraient pas).
 *
 * ── Comment ───────────────────────────────────────────────────────────────
 * Un rollup n'agrège qu'une colonne, jamais une expression, et une formule ne
 * sait pas faire de sous-requête. Même montage que « $ heures rég. » des paies
 * (2026-09-06) : la condition descend dans la table enfant sous forme de
 * COLONNE GÉNÉRÉE (rien n'est stocké, aucune écriture à changer), le parent en
 * fait la somme, et le statut est une formule sur cette somme.
 *
 *   return_items.item_a_recevoir  (généré)  1 si non reçu, sinon 0
 *   returns.cf_nb_items           (rollup)  COUNT des items du retour
 *   returns.cf_items_a_recevoir   (rollup)  SUM des items non reçus
 *   returns.cf_statut             (formule) Aucun item / En transit / Analyse complétée
 *
 * Vérifié sur les 479 retours du 2026-09-15 : 11 « En transit », 5 « Aucun item
 * à retourner », le reste « Analyse complétée » — les mêmes que dans Airtable.
 */
import { newRecordId } from '../../utils/recordId.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '069-retours-statut-en-transit'
export const description =
  'Retours : statut calculé (En transit = items non reçus) et vue « En transit » filtrée'

const PARENT = 'returns'
const CHILD = 'return_items'
const GEN_COLUMN = 'item_a_recevoir'
const COUNT_COLUMN = 'cf_nb_items'
const ROLLUP_COLUMN = 'cf_items_a_recevoir'
const STATUT_COLUMN = 'cf_statut'
// Libellés repris d'Airtable au caractère près : c'est la référence de l'équipe.
// Un rollup SUM/COUNT est ramené à 0 quand rien n'est lié (coalesce dans la
// vue) : c'est le COMPTE d'items, pas la somme, qui distingue « aucun item ».
const STATUT_FORMULA =
  `IF(${COUNT_COLUMN} = 0, "Aucun item à retourner", ` +
  `IF(${ROLLUP_COLUMN} > 0, "En transit", "Analyse complétée"))`

// Les deux compteurs du retour, dans l'ordre d'affichage souhaité.
const ROLLUPS = [
  { column: COUNT_COLUMN, name: "Nombre d'items", agg: 'COUNT', target: null },
  { column: ROLLUP_COLUMN, name: 'Items à recevoir', agg: 'SUM', target: GEN_COLUMN },
]

export function up(d) {
  const report = {}

  // 1. La condition « pas encore reçu », dans la table enfant.
  //    PRAGMA table_xinfo (et non table_info) : les colonnes générées sont
  //    invisibles à table_info.
  const childCols = new Set(d.pragma(`table_xinfo(${CHILD})`).map(c => c.name))
  if (!childCols.has(GEN_COLUMN)) {
    d.exec(`ALTER TABLE ${CHILD} ADD COLUMN ${GEN_COLUMN} INTEGER ` +
      `GENERATED ALWAYS AS (CASE WHEN received_at IS NULL OR received_at = '' THEN 1 ELSE 0 END) VIRTUAL`)
    report.generated_column = `${CHILD}.${GEN_COLUMN}`
  }

  // 2. Les compteurs d'items, visibles dans /champs/retours : ce sont eux qui
  //    expliquent le statut, ils ne doivent pas rester cachés dans du SQL.
  report.rollups = []
  for (const r of ROLLUPS) {
    const existing = d.prepare(
      `SELECT id FROM custom_fields WHERE erp_table=? AND column_name=?`
    ).get(PARENT, r.column)
    if (existing) {
      d.prepare(`UPDATE custom_fields SET deleted_at=NULL, kind='rollup', type='number',
                   rollup_target_table=?, rollup_target_fk=?, rollup_target_column=?,
                   rollup_agg=?, result_type='number', view_error=NULL,
                   updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
                 WHERE id=?`).run(CHILD, 'return_id', r.target, r.agg, existing.id)
      report.rollups.push(`${r.column} (réactivé)`)
      continue
    }
    const order = d.prepare(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM custom_fields WHERE erp_table=?`
    ).get(PARENT).n
    d.prepare(`INSERT INTO custom_fields
        (id, erp_table, name, column_name, type, kind, sort_order, source,
         rollup_target_table, rollup_target_fk, rollup_target_column, rollup_agg, result_type)
      VALUES (?,?,?,?,'number','rollup',?, 'native', ?,?,?,?, 'number')`)
      .run(newRecordId(), PARENT, r.name, r.column, order, CHILD, 'return_id', r.target, r.agg)
    report.rollups.push(`${PARENT}.${r.column}`)
  }

  // 3. « Statut » : rollup des raisons → formule de statut.
  const statut = d.prepare(
    `SELECT id, kind FROM custom_fields WHERE erp_table=? AND column_name=? AND deleted_at IS NULL`
  ).get(PARENT, STATUT_COLUMN)
  if (statut) {
    d.prepare(`UPDATE custom_fields SET kind='formula', type='text', formula_expr=?,
                 result_type='text', options=NULL, view_error=NULL,
                 rollup_target_table=NULL, rollup_target_fk=NULL,
                 rollup_target_column=NULL, rollup_agg=NULL,
                 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id=?`).run(STATUT_FORMULA, statut.id)
    report.statut = `formule (était ${statut.kind})`
  } else {
    report.statut = 'champ absent — non recréé'
  }

  // 4. La vue « En transit » filtre enfin. On ne touche qu'une pill SANS aucune
  //    condition : si quelqu'un en a posé une depuis, elle reste sienne.
  const pill = d.prepare(
    `SELECT id, filters FROM table_view_pills WHERE table_name='retours' AND lower(label)='en transit'`
  ).get()
  if (pill) {
    let rules = []
    try {
      const raw = JSON.parse(pill.filters || '[]')
      rules = Array.isArray(raw) ? raw : (Array.isArray(raw?.rules) ? raw.rules : [])
    } catch { rules = [] }
    if (!rules.length) {
      d.prepare('UPDATE table_view_pills SET filters=? WHERE id=?').run(
        JSON.stringify({
          conjunction: 'AND',
          rules: [{ field: STATUT_COLUMN, op: 'equals', value: 'En transit' }],
        }),
        pill.id
      )
      report.pill = pill.id
    } else {
      report.pill = 'déjà filtrée — inchangée'
    }
  }

  // regenerateView lit la connexion principale : la vue est reconstruite à
  // partir des définitions qu'on vient d'écrire dans la même transaction.
  regenerateView(PARENT)
  return report
}
