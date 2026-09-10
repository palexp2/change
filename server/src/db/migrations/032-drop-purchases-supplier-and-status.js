/**
 * 032 — « Fournisseur » et « Statut » (Achats) : suppression DÉFINITIVE.
 *
 * Demande depuis /champs/purchases : « supprime définitivement les champs Statut
 * et Fournisseur de cette table. Drop column. » Même voie que 023 / 028 / 029 /
 * 030 (migration numérotée, tracée dans `schema_migrations`, appliquée au
 * `pm2 restart`).
 *
 * ── QUELLES colonnes, exactement ──────────────────────────────────────────
 * Les deux lignes visées sont les deux colonnes NATIVES et VOISINES de
 * `TABLE_COLUMN_META.purchases` (client/src/lib/tableDefs.js) :
 *
 *  • `supplier`  — libellée « Fournisseur », 1 937 / 1 941 achats renseignés.
 *    C'est la colonne texte héritée d'Airtable, cible du field_map CŒUR
 *    `"supplier": "Fournisseur - LEGACY"` (le champ Airtable lui-même est déjà
 *    `state='excluded'` depuis 030). Le fournisseur d'un achat survit deux fois :
 *    `supplier_company_id` (entreprise liée, 1 570 achats) et
 *    `supplier_vendor_name` (nom canonique QuickBooks résolu depuis le champ LIÉ
 *    « Fournisseur » d'Airtable, 1 926 achats). Rien n'est perdu de la donnée
 *    utile — seule la copie texte disparaît.
 *
 *  • `status`    — libellée « Statut », 1 941 / 1 941 (« Reçu » ×1 924,
 *    « Commandé » ×17). Aucun champ Airtable derrière (`"status": null` dans le
 *    field_map) : la valeur se DÉDUISAIT de `received_date` — une date ⇒ « Reçu »,
 *    sinon « Commandé ». Détruire la colonne ne détruit donc aucune information :
 *    tout ce qu'elle disait se relit sur `received_date`.
 *
 * NB : la colonne `fournisseur` (champ perso adopté du champ LIÉ Airtable,
 * `multipleRecordLinks`) n'est PAS touchée — même libellé, autre ligne.
 *
 * ── Ce qu'il a fallu couper côté code (hors migration) ────────────────────
 * Contrairement à 030 (où la colonne détruite n'avait AUCUN consommateur), ces
 * deux-là étaient load-bearing. Sites repris :
 *  • `services/airtableMirrorEngine.js` — `achatsDerive` ne rend plus `status`
 *    ni `supplier` ; `qty_received` se déduit directement de `received_date`
 *    (elle passait par `status === 'Reçu'`, lui-même dérivé de la même date :
 *    même résultat, un intermédiaire de moins) ;
 *  • `services/airtable.js` — `syncAchats` : clés `supplier` / `status` retirées
 *    de l'auto-détection (sinon le field_map persisté les remettrait à chaque
 *    sync complet, cf. 029), `STATUS_MAP` et le repli legacy supprimés, colonnes
 *    retirées de l'UPDATE et de l'INSERT ;
 *  • `routes/purchases.js` — plus de défaut `status='Commandé'` ni de texte
 *    `supplier` à la création, plus de filtre `?status=`, les deux clés sortent
 *    de `PATCHABLE_FIELDS` ;
 *  • `services/purchaseOrder.js` — INSERT du PO sans les deux colonnes ;
 *  • `services/purchasePriceCheck.js` — les filtres `status <> 'Annulé'` tombent
 *    (aucun achat n'a jamais porté ce statut : ils ne retiraient rien) ;
 *  • `services/purchaseLiaMatch.js` — l'appariement d'un achat à une facture ne
 *    compare plus que `supplier_vendor_name` (le nom canonique QB, justement la
 *    raison pour laquelle cette colonne existe) ;
 *  • `services/recordLinks.js` — sous-titre d'un achat = `supplier_vendor_name` ;
 *  • `db/schema.js` — les deux colonnes sortent du `CREATE TABLE`, qui tourne
 *    AVANT les migrations et les recréerait sur une base neuve.
 *
 * ── Le filet ──────────────────────────────────────────────────────────────
 * Détruire les valeurs EST la demande : le garde-fou « colonne non vide » de 023
 * ne s'applique pas (cf. 028). Il est remplacé par une sauvegarde JSON dans
 * `uploads/backups/`, comme le fait `services/fieldPurge.js`.
 *
 * ── Ce qui reste volontairement ───────────────────────────────────────────
 * La ligne `airtable_field_map` du champ « Fournisseur - LEGACY », déjà
 * `state='excluded'` / `decided_by='user'` depuis 030 : c'est la décision « ne
 * pas importer ce champ Airtable », pas une trace du champ ERP. Pas de
 * `purged_fields` : les deux colonnes sortent aussi de `tableDefs.js`, donc
 * aucune définition ne peut les faire réapparaître.
 *
 * Défensive : chaque garde-fou renvoie `skipped` au lieu de lever — une
 * exception arrêterait le démarrage du serveur.
 */
import fs from 'node:fs'
import path from 'node:path'
import db from '../database.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '032-drop-purchases-supplier-and-status'
export const description =
  'purchases.supplier et purchases.status droppées — champs « Fournisseur » (texte) et « Statut » des achats détruits'

const TABLE = 'purchases'
const COLUMNS = ['supplier', 'status']
const MIRROR = 'achats'
// Les vues sauvegardées sont rangées sous le nom de la RESSOURCE : /purchases et
// le tableau « Achats » de la fiche pièce (cf. TABLE_COLUMN_META).
const VIEW_TABLES = ['purchases', 'product_achats']

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = new Set(d.pragma(`table_info(${TABLE})`).map(c => c.name))
  const present = COLUMNS.filter(c => cols.has(c))
  if (!present.length) return { skipped: 'colonnes déjà absentes' }

  // Un champ ressorti de la corbeille depuis /champs/purchases ne se détruit pas
  // dans son dos.
  const alive = d.prepare(
    `SELECT name FROM custom_fields
      WHERE erp_table=? AND column_name IN (${present.map(() => '?').join(',')})
        AND deleted_at IS NULL`
  ).get(TABLE, ...present)
  if (alive) return { skipped: `champ « ${alive.name} » redevenu actif` }

  // Un lookup / rollup d'une autre table qui viserait l'une des colonnes serait
  // vidé en silence.
  for (const col of present) {
    const dependent = d.prepare(
      `SELECT erp_table, name FROM custom_fields
        WHERE deleted_at IS NULL
          AND ((lookup_target_table=? AND lookup_target_column=?)
            OR (rollup_target_table=? AND rollup_target_column=?))`
    ).get(TABLE, col, TABLE, col)
    if (dependent) return { skipped: `champ calculé dépendant : ${dependent.erp_table}.${dependent.name}` }
  }

  // Une formule DE CETTE TABLE qui nomme la colonne tomberait en erreur de vue
  // au prochain rendu. Le test se scope à `purchases` : « status » est un nom de
  // colonne trop courant pour chercher dans les formules de tout l'ERP.
  for (const col of present) {
    const formula = d.prepare(
      `SELECT name FROM custom_fields
        WHERE deleted_at IS NULL AND erp_table=? AND kind='formula' AND formula_expr LIKE ?`
    ).get(TABLE, `%${col}%`)
    if (formula) return { skipped: `formule dépendante : ${TABLE}.${formula.name}` }
  }

  // Si l'import Airtable a été (re)branché sur l'une des deux colonnes entre
  // temps, le sync réécrirait une colonne disparue : on s'arrête.
  const mapped = d.prepare(
    `SELECT column_name FROM airtable_field_mappings
      WHERE erp_table=? AND column_name IN (${present.map(() => '?').join(',')})
        AND import_disabled IS NOT 1`
  ).get(TABLE, ...present)
  if (mapped) return { skipped: `import Airtable actif sur ${TABLE}.${mapped.column_name}` }

  const backup = backupValues(d, present)

  d.exec(`DROP VIEW IF EXISTS ${TABLE}_v`)
  for (const col of present) d.exec(`ALTER TABLE ${TABLE} DROP COLUMN [${col}]`)

  // Registres qui décrivaient les natifs. Aucun n'a de ligne aujourd'hui (les
  // deux colonnes étaient « cœur »), mais une migration qui suppose l'état de la
  // base se trompe un jour.
  const ph = present.map(() => '?').join(',')
  const fields = d.prepare(`DELETE FROM custom_fields WHERE erp_table=? AND column_name IN (${ph})`)
    .run(TABLE, ...present).changes
  const mappings = d.prepare(`DELETE FROM airtable_field_mappings WHERE erp_table=? AND column_name IN (${ph})`)
    .run(TABLE, ...present).changes
  let defs = 0
  try {
    defs = d.prepare(`DELETE FROM airtable_field_defs WHERE erp_table=? AND column_name IN (${ph})`)
      .run(TABLE, ...present).changes
  } catch { /* table héritée absente */ }

  const unmapped = removeFromLegacyFieldMap(d, present)
  const excluded = excludeFromMirrorRegistry(d, present)
  const views = cleanSavedViews(d, present)

  regenerateView(TABLE)

  return {
    dropped: present.map(c => `${TABLE}.${c}`),
    backup,
    custom_fields_removed: fields, airtable_mappings_removed: mappings, airtable_defs_removed: defs,
    field_map_keys_removed: unmapped, mirror_rows_excluded: excluded, ...views,
  }
}

// Sauvegarde des valeurs qu'on s'apprête à détruire (cf. fieldPurge.js).
function backupValues(d, columns) {
  try {
    const dir = path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
    const file = path.join(dir, `champs-purges-${TABLE}-${stamp}.json`)
    const rows = d.prepare(`SELECT id, ${columns.map(c => `[${c}]`).join(', ')} FROM ${TABLE}`).all()
    fs.writeFileSync(file, JSON.stringify(
      { table: TABLE, columns, purged_at: new Date().toISOString(), rows }, null, 1))
    return file
  } catch (e) {
    console.warn(`[032] sauvegarde ${TABLE} impossible :`, e.message)
    return null
  }
}

// Le field_map « cœur » du miroir achats, stocké en JSON. Sa clé porte le nom de
// la colonne ERP : la retirer coupe l'import à la source. `status` y valait déjà
// `null`, `supplier` pointait sur « Fournisseur - LEGACY ».
function removeFromLegacyFieldMap(d, columns) {
  const row = d.prepare('SELECT field_map FROM airtable_module_config WHERE module=?').get(MIRROR)
  if (!row?.field_map) return 0
  let map
  try { map = JSON.parse(row.field_map) } catch { return 0 }
  const removed = columns.filter(c => Object.hasOwn(map, c))
  if (!removed.length) return 0
  for (const c of removed) delete map[c]
  // airtable_module_config n'a pas de colonne updated_at (cf. db/schema.js) :
  // l'y écrire ferait échouer la migration au démarrage.
  d.prepare('UPDATE airtable_module_config SET field_map=? WHERE module=?')
    .run(JSON.stringify(map), MIRROR)
  return removed.length
}

// Registre du miroir, scopé au miroir `achats` : ailleurs, `status` est une clé
// cœur bien vivante (factures, billets, sériaux…). `decided_by='user'` est la
// seule marque que le rafraîchissement du registre respecte.
function excludeFromMirrorRegistry(d, columns) {
  let n = 0
  for (const col of columns) {
    n += d.prepare(`
      UPDATE airtable_field_map
      SET state='excluded', direction='none', erp_column=NULL, core_key=NULL,
          exclude_reason=?, decided_by='user',
          decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE mirror_id=? AND (core_key=? OR erp_column=?)
    `).run('champ ERP supprimé — colonne droppée (migration 032)', MIRROR, col, col).changes
  }
  return n
}

// Une colonne droppée qui traîne dans visible_columns / sort / filters /
// color_rules / group_by / column_widths laisse une colonne fantôme dans la
// barre des vues. Une pastille qui ne filtrait QUE sur elle perd sa raison
// d'être : on la supprime au lieu de la laisser mentir.
function cleanSavedViews(d, columns) {
  const dropped = new Set(columns)
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
      // Pastille dont TOUT le filtre reposait sur une colonne détruite.
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
