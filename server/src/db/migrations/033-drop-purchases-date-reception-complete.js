/**
 * 033 — « Date de réception complète » (Achats) : suppression DÉFINITIVE de la
 * colonne ADOPTÉE.
 *
 * Demande depuis /champs/purchases : « supprime définitivement le champ Date de
 * réception complète (drop column) ». Même voie que 023 / 028 / 029 / 030 / 032
 * (migration numérotée, tracée dans `schema_migrations`, appliquée au
 * `pm2 restart`).
 *
 * ── QUELLE colonne, exactement ────────────────────────────────────────────
 * C'est le cas « UN champ Airtable, DEUX colonnes ERP » de 030 — en pire, car
 * ici les deux portent le MÊME libellé sur /champs/purchases. Le champ Airtable
 * « Date de réception complète » (fld16H2phgzRQromD) atterrit :
 *
 *  • `date_de_reception_complete` — colonne ADOPTÉE (champ perso `kind='data'`,
 *    `source='airtable'`, libellé exact « Date de réception complète »), 816 /
 *    1 941 achats renseignés, import actif. **ZÉRO consommateur** : aucune
 *    occurrence dans `server/src`, `client/src` ni `e2e`. C'est un doublon
 *    partiel, arrivé par l'adoption automatique d'un champ déjà pris en charge
 *    par le field_map cœur. → C'EST LA CIBLE.
 *
 *  • `received_date` — colonne NATIVE, cible du field_map CŒUR
 *    `"received_date": "Date de réception complète"`, 1 924 / 1 941 achats,
 *    libellée pareil dans `TABLE_COLUMN_META` (client/src/lib/tableDefs.js).
 *    → ELLE SURVIT, intacte.
 *
 * Pourquoi ce sens-là : depuis 032, `received_date` est LA lecture de la
 * réception d'un achat pour toute l'app — `achatsDerive` en déduit
 * `qty_received` (airtableMirrorEngine.js), `purchaseLiaMatch.js` en tire la
 * section « À recevoir » et `pending_reception`, `PrioriteAssemblage.jsx` son
 * `isOpenPurchase`, `PurchaseDetail` / `Purchases` / `ProductDetail` l'affichent.
 * 032 a justement supprimé `status` PARCE QUE `received_date` portait déjà
 * l'information : la détruire à son tour effacerait la réception de l'ERP. La
 * colonne adoptée, elle, ne dit rien de plus (mêmes dates, en moins complet) et
 * n'est lue par personne.
 *
 * ── L'import Airtable n'est PAS coupé ─────────────────────────────────────
 * Contrairement à 023 / 030, la ligne `airtable_field_mappings` n'est pas gardée
 * en pierre tombale `import_disabled=1` : elle est SUPPRIMÉE. Le champ Airtable
 * doit continuer d'être importé — vers `received_date`, par le field_map cœur.
 * Sans ligne de mapping, `airtableMirrorRegistry.js` reclasse le champ par sa
 * première branche (`!d` + `coreFieldNames.has(...)`) en `state='core'`,
 * `core_key='received_date'`, `erp_column='received_date'` : la décision reste
 * prise, le champ ne retombe pas dans les « sans décision » du miroir. Une
 * pierre tombale `import_disabled=1` aurait au contraire figé un `erp_column`
 * pointant sur une colonne détruite.
 * Et il ne peut pas être ré-adopté d'un clic : `airtableFieldsHandler` (modale
 * de sync) filtre les champs réclamés par le field_map cœur.
 *
 * Aucune des trois sources cœur n'est touchée (`CORE_PLANS.achats.fields`,
 * `syncAchats` d'`airtable.js`, clé `received_date` du JSON
 * `airtable_module_config.field_map`) : elles alimentent la SURVIVANTE.
 *
 * ── Le filet ──────────────────────────────────────────────────────────────
 * Détruire les valeurs EST la demande : le garde-fou « colonne non vide » de 023
 * ne s'applique pas (cf. 028). Il est remplacé par une sauvegarde JSON dans
 * `uploads/backups/`, comme le fait `services/fieldPurge.js`.
 *
 * Défensive : chaque garde-fou renvoie `skipped` au lieu de lever — une
 * exception arrêterait le démarrage du serveur.
 */
import fs from 'node:fs'
import path from 'node:path'
import db from '../database.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '033-drop-purchases-date-reception-complete'
export const description =
  'purchases.date_de_reception_complete droppée — doublon adopté du champ Airtable « Date de réception complète » ; la colonne cœur received_date survit'

const TABLE = 'purchases'
const COLUMN = 'date_de_reception_complete'
const SURVIVOR = 'received_date'
const MIRROR = 'achats'
// Les vues sauvegardées sont rangées sous le nom de la RESSOURCE (cf. 028) :
// /purchases et le tableau « Achats » de la fiche pièce.
const VIEW_TABLES = ['purchases', 'product_achats']

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = new Set(d.pragma(`table_info(${TABLE})`).map(c => c.name))
  if (!cols.has(COLUMN)) return { skipped: 'colonne déjà absente' }

  // Garde-fou propre à ce drop : on ne détruit le doublon QUE si l'original
  // tient encore. Sans `received_date`, cette colonne serait la dernière trace
  // de la réception des achats.
  if (!cols.has(SURVIVOR)) return { skipped: `colonne survivante ${TABLE}.${SURVIVOR} absente` }

  // Un lookup / rollup d'une autre table qui viserait la colonne serait vidé en
  // silence.
  const dependent = d.prepare(
    `SELECT erp_table, name FROM custom_fields
      WHERE deleted_at IS NULL
        AND ((lookup_target_table=? AND lookup_target_column=?)
          OR (rollup_target_table=? AND rollup_target_column=?))`
  ).get(TABLE, COLUMN, TABLE, COLUMN)
  if (dependent) return { skipped: `champ calculé dépendant : ${dependent.erp_table}.${dependent.name}` }

  // Une formule qui nomme la colonne tomberait en erreur de vue au prochain
  // rendu. Le nom est assez spécifique pour chercher dans tout l'ERP.
  const formula = d.prepare(
    `SELECT erp_table, name FROM custom_fields
      WHERE deleted_at IS NULL AND kind='formula' AND formula_expr LIKE ?`
  ).get(`%${COLUMN}%`)
  if (formula) return { skipped: `formule dépendante : ${formula.erp_table}.${formula.name}` }

  const backup = backupValues(d)

  d.exec(`DROP VIEW IF EXISTS ${TABLE}_v`)
  d.exec(`ALTER TABLE ${TABLE} DROP COLUMN [${COLUMN}]`)

  // Les trois registres qui décrivaient le champ adopté. Le mapping part pour de
  // bon — voir l'en-tête : le field_map cœur reprend le champ Airtable.
  const fields = d.prepare(`DELETE FROM custom_fields WHERE erp_table=? AND column_name=?`)
    .run(TABLE, COLUMN).changes
  const mappings = d.prepare(`DELETE FROM airtable_field_mappings WHERE erp_table=? AND column_name=?`)
    .run(TABLE, COLUMN).changes
  let defs = 0
  try {
    defs = d.prepare(`DELETE FROM airtable_field_defs WHERE erp_table=? AND column_name=?`)
      .run(TABLE, COLUMN).changes
  } catch { /* table héritée absente */ }

  const repointed = repointMirrorRegistry(d)
  const views = cleanSavedViews(d)

  regenerateView(TABLE)

  return {
    dropped: `${TABLE}.${COLUMN}`, survivor: `${TABLE}.${SURVIVOR}`,
    backup, custom_fields_removed: fields, airtable_mappings_removed: mappings,
    airtable_defs_removed: defs, mirror_rows_repointed: repointed, ...views,
  }
}

// Sauvegarde des valeurs qu'on s'apprête à détruire (cf. fieldPurge.js).
function backupValues(d) {
  try {
    const dir = path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
    const file = path.join(dir, `champs-purges-${TABLE}-${COLUMN}-${stamp}.json`)
    const rows = d.prepare(`SELECT id, [${COLUMN}] FROM ${TABLE} WHERE [${COLUMN}] IS NOT NULL`).all()
    fs.writeFileSync(file, JSON.stringify(
      { table: TABLE, columns: [COLUMN], purged_at: new Date().toISOString(), rows }, null, 1))
    return file
  } catch (e) {
    console.warn(`[033] sauvegarde ${TABLE}.${COLUMN} impossible :`, e.message)
    return null
  }
}

// Registre du miroir : la ligne du champ Airtable reste `state='core'` — elle
// décrit une décision toujours valable — mais son `erp_column` doit désigner la
// colonne SURVIVANTE, pas celle qu'on vient de détruire. C'est exactement ce que
// le backfill recalculerait (branche `!d` d'airtableMirrorRegistry.js) : on
// laisse donc `decided_by` tel quel, sans le passer à 'user'.
function repointMirrorRegistry(d) {
  return d.prepare(`
    UPDATE airtable_field_map
    SET erp_column=?, core_key=?, state='core',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE mirror_id=? AND erp_column=?
  `).run(SURVIVOR, SURVIVOR, MIRROR, COLUMN).changes
}

// Une colonne droppée qui traîne dans visible_columns / sort / filters /
// color_rules / group_by / column_widths laisse une colonne fantôme dans la
// barre des vues. Une pastille qui ne filtrait QUE sur elle perd sa raison
// d'être : on la supprime au lieu de la laisser mentir.
function cleanSavedViews(d) {
  const dropped = new Set([COLUMN])
  const parse = (raw, fallback) => {
    try { return JSON.parse(raw || fallback) } catch { return JSON.parse(fallback) }
  }
  const keyOf = (x) => (typeof x === 'string' ? x : (x?.field ?? x?.id))
  const without = (arr) => arr.filter(x => !dropped.has(keyOf(x)))
  const withoutKeys = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => !dropped.has(k)))
  let cleaned = 0, removedPills = 0

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
        if (!list.some(x => dropped.has(keyOf(x)))) continue
        patch[col] = JSON.stringify(
          Array.isArray(raw) ? without(raw) : { ...raw, rules: without(list) }
        )
      } else if (kind === 'map') {
        const map = parse(row[col], '{}')
        if (Object.keys(map).some(k => dropped.has(k))) patch[col] = JSON.stringify(withoutKeys(map))
      } else if (kind === 'scalar' && dropped.has(row[col])) {
        patch[col] = null
      }
    }
    if (!Object.keys(patch).length) return
    const sets = Object.keys(patch).map(k => `${k}=?`).join(', ')
    d.prepare(`UPDATE ${table} SET ${sets} WHERE id=?`).run(...Object.values(patch), row.id)
    cleaned++
  }

  for (const viewTable of VIEW_TABLES) {
    for (const row of d.prepare(`SELECT * FROM table_view_pills WHERE table_name=?`).all(viewTable)) {
      const raw = parse(row.filters, '[]')
      const rules = Array.isArray(raw) ? raw : (Array.isArray(raw?.rules) ? raw.rules : [])
      // Pastille dont TOUT le filtre reposait sur la colonne détruite.
      if (rules.length && rules.every(r => dropped.has(keyOf(r)))) {
        d.prepare(`DELETE FROM table_view_pills WHERE id=?`).run(row.id)
        removedPills++
        continue
      }
      patchRow('table_view_pills', row, {
        visible_columns: 'list', sort: 'list', filters: 'list', color_rules: 'list',
        column_widths: 'map', group_by: 'scalar',
      })
    }
    try {
      for (const row of d.prepare(`SELECT * FROM table_view_configs WHERE table_name=?`).all(viewTable)) {
        patchRow('table_view_configs', row, {
          visible_columns: 'list', default_sort: 'list',
          column_widths: 'map', footer_aggregations: 'map',
        })
      }
    } catch { /* table absente */ }
  }

  return { views_cleaned: cleaned, pills_removed: removedPills }
}
