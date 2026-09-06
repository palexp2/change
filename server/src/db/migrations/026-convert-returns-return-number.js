/**
 * 026 — « N° de retour » (Retours) : le natif meurt, un champ personnalisé le remplace.
 *
 * `returns.return_number` était une colonne NATIVE au sens le plus rigide du
 * terme : déclarée dans `schema.js`, codée en dur dans `tableDefs.js`, donc ni
 * renommable, ni convertible, ni supprimable depuis `/champs/retours`. Demande :
 * « convertis-le en champ personnalisé et supprime définitivement le champ
 * natif. Drop column. »
 *
 * Contrairement à 025 (où le champ personnalisé jumeau existait DÉJÀ et portait
 * la même donnée), il n'y avait ici aucun homonyme : les 476 numéros — « RMA-144 »,
 * identifiant principal d'un retour — ne vivaient que dans la colonne native. La
 * conversion doit donc CRÉER le champ, transporter les valeurs, et seulement
 * ensuite détruire le natif.
 *
 * D'où vient la donnée. « # de retour » (fldyyRvng3bBjMyhR) est une FORMULE
 * Airtable, tirée par le field_map « cœur » du miroir `retours`
 * (CORE_PLANS.retours dans services/airtableMirrorEngine.js). Le champ reste donc
 * en import seul, exactement comme `orders.order_number` — même forme d'adoption
 * (`kind:'data'`, `source:'airtable'`, cf. services/nativeFieldConversions.js).
 * Le plan cœur est repointé sur la colonne survivante dans le même mouvement :
 * sans ça le sync suivant écrirait dans une colonne disparue.
 *
 * Ordre d'opérations (cf. 023 / 025) :
 *   1. création de la colonne d'accueil `n_de_retour` (slug du libellé, comme
 *      les 38 autres champs Airtable de la table) et report des 476 valeurs ;
 *   2. garde-fou : on ne DROP que si le report est complet — une valeur perdue
 *      ici est un retour qu'on ne sait plus nommer ;
 *   3. ligne `custom_fields` qui prend possession de la colonne ;
 *   4. DROP VIEW returns_v — SQLite refuse le DROP COLUMN tant qu'une vue
 *      référence la table (la vue n'existe pas aujourd'hui, mais la migration ne
 *      doit pas dépendre de ça) ;
 *   5. ALTER TABLE returns DROP COLUMN return_number ;
 *   6. registres qui décrivaient le natif ;
 *   7. `airtable_field_map` repointé : le champ Airtable reste mis en miroir,
 *      simplement vers `n_de_retour`. Le supprimer le renverrait dans les champs
 *      « sans décision » du miroir ;
 *   8. vues enregistrées — ici on RENOMME au lieu de retirer (025 retirait, le
 *      champ disparaissait vraiment) : les deux vues de `/retours` affichent
 *      `return_number` en première colonne, les vider les amputerait de leur
 *      colonne principale ;
 *   9. regenerateView('returns').
 *
 * Pas de `purged_fields` : le champ n'est pas supprimé, il change de porteur.
 * Une pierre tombale sur `return_number` ferait taire un champ bien vivant.
 *
 * Défensive : chaque garde-fou renvoie `skipped` au lieu de lever — une
 * exception arrêterait le démarrage du serveur.
 */
import { v4 as uuidv4 } from 'uuid'
import db from '../database.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '026-convert-returns-return-number'
export const description = 'returns.return_number droppée — « N° de retour » devient le champ personnalisé n_de_retour'

const TABLE = 'returns'
const OLD = 'return_number'
const NEW = 'n_de_retour'
const LABEL = 'N° de retour'
const MIRROR = 'retours'
// Les vues sauvegardées sont rangées sous la clé de VUE (`retours`), pas sous le
// nom de la table SQL — mais on balaie les deux, une vue mal rangée existerait
// sans que rien ne le signale.
const VIEW_KEYS = [MIRROR, TABLE]

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = () => new Set(d.pragma(`table_info(${TABLE})`).map(c => c.name))
  if (!cols().has(OLD)) return { skipped: 'colonne déjà absente' }

  // 1. Colonne d'accueil. Elle peut déjà exister si une exécution précédente
  // s'est arrêtée sur un garde-fou.
  if (!cols().has(NEW)) d.exec(`ALTER TABLE ${TABLE} ADD COLUMN [${NEW}] TEXT`)

  // Les deux colonnes se contredisent-elles ? Ce serait un arbitrage humain
  // (laquelle garde-t-on ?), pas une conversion automatique.
  const { n: divergent } = d.prepare(
    `SELECT COUNT(*) AS n FROM ${TABLE}
      WHERE TRIM(COALESCE([${OLD}],'')) != ''
        AND TRIM(COALESCE([${NEW}],'')) != ''
        AND TRIM([${OLD}]) != TRIM([${NEW}])`
  ).get()
  if (divergent) return { skipped: `${divergent} retour(s) où les deux colonnes divergent — arbitrage manuel requis` }

  const carried = d.prepare(
    `UPDATE ${TABLE} SET [${NEW}] = TRIM([${OLD}])
      WHERE TRIM(COALESCE([${OLD}],'')) != '' AND TRIM(COALESCE([${NEW}],'')) = ''`
  ).run().changes

  // 2. On ne détruit la source qu'une fois la copie prouvée complète.
  const { n: unmoved } = d.prepare(
    `SELECT COUNT(*) AS n FROM ${TABLE}
      WHERE TRIM(COALESCE([${OLD}],'')) != '' AND TRIM(COALESCE([${NEW}],'')) = ''`
  ).get()
  if (unmoved) return { skipped: `${unmoved} valeur(s) non reportée(s) — DROP annulé` }

  // 3. Le champ personnalisé qui prend possession de la colonne. `sort_order`
  // explicitement NULL : le DEFAULT 0 ferait remonter le champ en tête de
  // tableau. Une ligne déjà présente (rejeu, ou décision de l'utilisateur) est
  // laissée telle quelle.
  const existing = d.prepare(
    `SELECT id FROM custom_fields WHERE erp_table=? AND column_name=?`
  ).get(TABLE, NEW)
  let created = false
  if (!existing) {
    d.prepare(
      `INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind, source, sort_order)
       VALUES (?,?,?,?,'text','data','airtable',NULL)`
    ).run(uuidv4(), TABLE, LABEL, NEW)
    created = true
  }

  // 4-5. Le natif disparaît.
  d.exec(`DROP VIEW IF EXISTS ${TABLE}_v`)
  d.exec(`ALTER TABLE ${TABLE} DROP COLUMN [${OLD}]`)

  // 6. Registres qui décrivaient le natif. Aucun n'a de ligne aujourd'hui
  // (le champ était cœur, donc hors du mapping champ-à-champ), mais une
  // migration qui suppose l'état de la base se trompe un jour.
  d.prepare(`DELETE FROM custom_fields WHERE erp_table=? AND column_name=?`).run(TABLE, OLD)
  d.prepare(`DELETE FROM airtable_field_mappings WHERE erp_table=? AND column_name=?`).run(TABLE, OLD)
  try {
    d.prepare(`DELETE FROM airtable_field_defs WHERE erp_table=? AND column_name=?`).run(TABLE, OLD)
  } catch { /* table héritée absente */ }

  // 7. Registre du miroir : même champ Airtable, nouvelle colonne ERP.
  let remapped = 0
  const already = d.prepare(
    `SELECT id FROM airtable_field_map WHERE mirror_id=? AND erp_column=?`
  ).get(MIRROR, NEW)
  if (already) {
    d.prepare(`DELETE FROM airtable_field_map WHERE mirror_id=? AND erp_column=?`).run(MIRROR, OLD)
  } else {
    remapped = d.prepare(
      `UPDATE airtable_field_map SET erp_column=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE mirror_id=? AND erp_column=?`
    ).run(NEW, MIRROR, OLD).changes
  }

  const renamed = renameInSavedViews(d)
  regenerateView(TABLE)

  return {
    dropped: `${TABLE}.${OLD}`, adopted: `${TABLE}.${NEW}`,
    carried_over: carried, custom_field_created: created,
    mirror_remapped: remapped, views_renamed: renamed,
  }
}

// Vues enregistrées : le champ SURVIT sous un autre id, donc on renomme au lieu
// de retirer. `visible_columns`, `sort`, `filters`, `color_rules`, `group_by` et
// `column_widths` référencent la colonne par son id.
function renameInSavedViews(d) {
  const parse = (raw, fallback) => {
    try { return JSON.parse(raw ?? fallback) } catch { return JSON.parse(fallback) }
  }
  // Un id de colonne apparaît soit comme chaîne nue (visible_columns), soit
  // porté par `.field` / `.id` (règles de tri, de filtre, de couleur).
  const rename = (x) => {
    if (typeof x === 'string') return x === OLD ? NEW : x
    if (x && typeof x === 'object') {
      if (x.field === OLD) return { ...x, field: NEW }
      if (x.id === OLD) return { ...x, id: NEW }
    }
    return x
  }
  const hits = (x) => (typeof x === 'string' ? x === OLD : (x?.field === OLD || x?.id === OLD))
  let renamed = 0

  const patchRow = (table, row, fields) => {
    const patch = {}
    for (const [col, kind] of Object.entries(fields)) {
      if (kind === 'list') {
        // `filters` a DEUX formes en base : le tableau de règles historique et
        // l'objet `{ conjunction, rules }` que la barre de filtres écrit
        // aujourd'hui. Traiter l'objet comme un tableau ferait un TypeError en
        // pleine transaction de migration.
        const raw = parse(row[col], '[]')
        const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.rules) ? raw.rules : [])
        if (!list.some(hits)) continue
        patch[col] = JSON.stringify(
          Array.isArray(raw) ? raw.map(rename) : { ...raw, rules: list.map(rename) }
        )
      } else if (kind === 'map') {
        const map = parse(row[col], '{}')
        if (!Object.hasOwn(map, OLD)) continue
        const { [OLD]: moved, ...rest } = map
        patch[col] = JSON.stringify({ ...rest, [NEW]: moved })
      } else if (kind === 'scalar' && row[col] === OLD) {
        patch[col] = NEW
      }
    }
    if (!Object.keys(patch).length) return
    const sets = Object.keys(patch).map(k => `${k}=?`).join(', ')
    d.prepare(`UPDATE ${table} SET ${sets} WHERE id=?`).run(...Object.values(patch), row.id)
    renamed++
  }

  for (const key of VIEW_KEYS) {
    for (const row of d.prepare(`SELECT * FROM table_view_pills WHERE table_name=?`).all(key)) {
      patchRow('table_view_pills', row, {
        visible_columns: 'list', sort: 'list', filters: 'list', color_rules: 'list',
        column_widths: 'map', group_by: 'scalar',
      })
    }
    try {
      for (const row of d.prepare(`SELECT * FROM table_view_configs WHERE table_name=?`).all(key)) {
        patchRow('table_view_configs', row, {
          visible_columns: 'list', default_sort: 'list',
          column_widths: 'map', footer_aggregations: 'map',
        })
      }
    } catch { /* table absente */ }
  }

  return renamed
}
