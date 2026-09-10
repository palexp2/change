/**
 * 035 — Les 7 derniers champs Airtable « gérés en code » des Achats :
 * suppression DÉFINITIVE.
 *
 * Demande depuis /champs/purchases : « supprime tous les champs Airtable gérés
 * en code définitivement (drop column) », confirmée après avoir été prévenu que
 * la page Achats serait vidée de ces colonnes. Même voie que 023 / 028 / 029 /
 * 030 / 032 / 033 (migration numérotée, tracée dans `schema_migrations`,
 * appliquée au `pm2 restart`).
 *
 * ── QUELLES colonnes, exactement ──────────────────────────────────────────
 * La note « N champs Airtable gérés en code » au bas de /champs/purchases liste
 * les valeurs STRING du field_map cœur du module `achats`
 * (`airtable_module_config`). Ses clés nomment la colonne ERP alimentée — et
 * `hardcodedErpColumns()` (airtableAutoSync.js) ajoute le suffixe `_id` aux clés
 * qui n'en ont pas, d'où `product` → `product_id` :
 *
 *   product       « Nom de la pièce »              → purchases.product_id   (1 932/1 941)
 *   reference     « Numéro de commande »           → purchases.reference    (1 941/1 941)
 *   order_date    « Date de commande »             → purchases.order_date   (1 941/1 941)
 *   received_date « Date de réception complète »   → purchases.received_date(1 924/1 941)
 *   qty_ordered   « Quantité commandé »            → purchases.qty_ordered  (1 941/1 941)
 *   unit_cost     « Prix unitaire ($ CAD) »        → purchases.unit_cost    (1 941/1 941)
 *   notes         « Notes »                        → purchases.notes        (  141/1 941)
 *
 * Le 8ᵉ de la liste d'origine, « Fournisseur - LEGACY » → `purchases.supplier`,
 * est déjà parti avec la migration 032. `qty_received` n'en fait pas partie :
 * sa clé vaut `null` dans le field_map (aucun champ Airtable derrière), la
 * colonne SURVIT — c'est désormais la seule trace de réception d'un achat.
 *
 * ── Ce que la table devient ───────────────────────────────────────────────
 * Un achat n'est plus rattaché à un produit, à un fournisseur texte, à une date
 * ni à un prix côté colonnes NATIVES. Ce qui reste : `qty_received`,
 * `emplacement`, `supplier_company_id` / `supplier_vendor_name` /
 * `supplier_qb_vendor_id`, `at_id` (le code LIA), et TOUS les champs Airtable
 * adoptés que l'utilisateur pilote depuis /champs/purchases — dont les jumeaux
 * partiels de six des sept colonnes détruites (`nom_de_la_piece`,
 * `numero_de_commande`, `date_de_commande`, `quantite_commande`,
 * `prix_unitaire_cad`, `notes_2`). Ces jumeaux ne sont PAS repris par le code :
 * un champ personnalisé se supprime d'un clic, s'appuyer dessus reviendrait à
 * bâtir sur du sable (cf. l'avertissement en tête de nativeFieldConversions.js).
 *
 * Effet de bord VOULU : le field_map cœur du module `achats` ne contient plus
 * aucune valeur string, donc plus aucun champ Airtable n'est « géré en code ».
 * Les defs dynamiques qui doublaient ces champs cessent d'être dormantes
 * (`sharesCoreField`, airtableAutoSync.js) et reprennent l'import vers les
 * colonnes adoptées. Le module devient entièrement pilotable depuis
 * /champs/purchases.
 *
 * ── Ce qu'il a fallu couper côté code (hors migration) ────────────────────
 *  • `services/purchaseOrder.js` SUPPRIMÉ — il n'existait que pour écrire
 *    product_id / reference / order_date / qty_ordered / unit_cost / notes.
 *    Un bon de commande envoyé ne crée donc plus d'achats (routes/products.js) ;
 *  • `services/purchasePriceCheck.js` SUPPRIMÉ — il comparait `unit_cost` aux
 *    achats passés du même `product_id`. Avec lui partent son veilleur
 *    (index.js) et l'automatisation système « Vérification des prix d'achat ».
 *    Les colonnes `price_check_*` restent (hors périmètre de la demande) ;
 *  • `services/purchaseLiaMatch.js` — le moteur de score perd ses signaux
 *    (nom de pièce, quantité, prix, dates) : il ne reste que le code LIA
 *    explicite et le fournisseur. `matchReceiptItems` ne propose donc plus
 *    d'achat par ressemblance, l'appariement redevient manuel ;
 *  • `routes/purchases.js` — création réduite (plus de produit ni de quantité
 *    requis), filtre `?product_id=` retiré, `PATCHABLE_FIELDS` réduit ;
 *  • `routes/products.js` — un produit n'a plus d'achats liés (ni onglet, ni
 *    verrou de suppression) ;
 *  • `services/airtableMirrorEngine.js` — `CORE_PLANS.achats.fields` vidé,
 *    `achatsDerive` ne déduit plus `qty_received` de la date de réception ;
 *  • `services/airtable.js` — `syncAchats` (repli legacy) : les 7 clés sortent
 *    de l'auto-détection (sinon le field_map persisté les remettrait à chaque
 *    sync complet, cf. 029) et de l'UPDATE / INSERT ;
 *  • `services/nativeFieldConversions.js` — les deux lookups `product_name` et
 *    `sku` des achats (FK `product_id`) retirés, sinon ils sont re-semés à
 *    chaque démarrage et la vue `purchases_v` tombe sur une colonne absente ;
 *  • `services/recordLinks.js`, `db/schema.js` (CREATE TABLE + index),
 *    `client/src/lib/tableDefs.js`, `Purchases.jsx`, `PurchaseDetail.jsx`,
 *    `ProductDetail.jsx`, `PrioriteAssemblage.jsx`.
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

export const id = '035-drop-purchases-core-columns'
export const description =
  'purchases : product_id, reference, order_date, received_date, qty_ordered, unit_cost et notes droppées — plus aucun champ Airtable géré en code sur les achats'

const TABLE = 'purchases'
const COLUMNS = ['product_id', 'reference', 'order_date', 'received_date', 'qty_ordered', 'unit_cost', 'notes']
// Clés du field_map cœur à retirer. `product` ne porte pas le suffixe `_id` de
// sa colonne (cf. hardcodedErpColumns) : les deux graphies sont testées.
const CORE_KEYS = ['product', 'product_id', 'reference', 'order_date', 'received_date', 'qty_ordered', 'unit_cost', 'notes']
const MIRROR = 'achats'
// Les vues sauvegardées sont rangées sous le nom de la RESSOURCE : /purchases et
// le tableau « Achats » de la fiche pièce (cf. TABLE_COLUMN_META).
const VIEW_TABLES = ['purchases', 'product_achats']
// Champs CALCULÉS de la table qui n'existent que par la FK détruite : sans eux,
// `regenerateView` construirait un `purchases_v` qui joint sur `p.product_id`.
const DEPENDENT_LOOKUPS = ['product_name', 'sku']

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = new Set(d.pragma(`table_info(${TABLE})`).map(c => c.name))
  const present = COLUMNS.filter(c => cols.has(c))
  if (!present.length) return { skipped: 'colonnes déjà absentes' }

  // Un champ ressorti de la corbeille depuis /champs/purchases ne se détruit pas
  // dans son dos. Les deux lookups de `DEPENDENT_LOOKUPS` sont exclus du test :
  // ils sont bien actifs, et c'est justement cette migration qui les retire.
  const alive = d.prepare(
    `SELECT name FROM custom_fields
      WHERE erp_table=? AND column_name IN (${present.map(() => '?').join(',')})
        AND deleted_at IS NULL`
  ).get(TABLE, ...present)
  if (alive) return { skipped: `champ « ${alive.name} » redevenu actif` }

  // Un lookup / rollup d'une AUTRE table qui viserait l'une des colonnes serait
  // vidé en silence.
  for (const col of present) {
    const dependent = d.prepare(
      `SELECT erp_table, name FROM custom_fields
        WHERE deleted_at IS NULL AND erp_table <> ?
          AND ((lookup_target_table=? AND lookup_target_column=?)
            OR (rollup_target_table=? AND rollup_target_column=?))`
    ).get(TABLE, TABLE, col, TABLE, col)
    if (dependent) return { skipped: `champ calculé dépendant : ${dependent.erp_table}.${dependent.name}` }
  }

  // Un rollup d'une autre table qui compte les achats d'un produit passe par la
  // FK `product_id` : la vue de CETTE table-là tomberait en erreur.
  const rollupFk = d.prepare(
    `SELECT erp_table, name FROM custom_fields
      WHERE deleted_at IS NULL AND rollup_target_table=? AND rollup_target_fk IN (${present.map(() => '?').join(',')})`
  ).get(TABLE, ...present)
  if (rollupFk) return { skipped: `rollup dépendant : ${rollupFk.erp_table}.${rollupFk.name}` }

  // Une formule DE CETTE TABLE qui nomme l'une des colonnes tomberait en erreur
  // de vue au prochain rendu.
  for (const col of present) {
    const formula = d.prepare(
      `SELECT name FROM custom_fields
        WHERE deleted_at IS NULL AND erp_table=? AND kind='formula' AND formula_expr LIKE ?`
    ).get(TABLE, `%${col}%`)
    if (formula) return { skipped: `formule dépendante : ${TABLE}.${formula.name}` }
  }

  // Si l'import Airtable a été (re)branché sur l'une des colonnes entre temps,
  // le sync réécrirait une colonne disparue : on s'arrête.
  const mapped = d.prepare(
    `SELECT column_name FROM airtable_field_mappings
      WHERE erp_table=? AND column_name IN (${present.map(() => '?').join(',')})
        AND import_disabled IS NOT 1`
  ).get(TABLE, ...present)
  if (mapped) return { skipped: `import Airtable actif sur ${TABLE}.${mapped.column_name}` }

  const backup = backupValues(d, present)

  d.exec(`DROP VIEW IF EXISTS ${TABLE}_v`)
  // L'index de la FK doit tomber AVANT sa colonne : SQLite refuse de dropper une
  // colonne indexée (« error in index … after drop column »).
  d.exec('DROP INDEX IF EXISTS idx_purchases_product')
  for (const col of present) d.exec(`ALTER TABLE ${TABLE} DROP COLUMN [${col}]`)

  const ph = present.map(() => '?').join(',')
  const fields = d.prepare(`DELETE FROM custom_fields WHERE erp_table=? AND column_name IN (${ph})`)
    .run(TABLE, ...present).changes
  // « Produit » et « SKU » : lookups semés par nativeFieldConversions.js sur la
  // FK détruite. L'entrée est retirée du registre au même commit — sans quoi le
  // prochain démarrage les re-sèmerait.
  const lookups = d.prepare(
    `DELETE FROM custom_fields WHERE erp_table=? AND column_name IN (${DEPENDENT_LOOKUPS.map(() => '?').join(',')})`
  ).run(TABLE, ...DEPENDENT_LOOKUPS).changes
  const mappings = d.prepare(`DELETE FROM airtable_field_mappings WHERE erp_table=? AND column_name IN (${ph})`)
    .run(TABLE, ...present).changes
  let defs = 0
  try {
    defs = d.prepare(`DELETE FROM airtable_field_defs WHERE erp_table=? AND column_name IN (${ph})`)
      .run(TABLE, ...present).changes
  } catch { /* table héritée absente */ }

  const unmapped = removeFromLegacyFieldMap(d)
  const excluded = excludeFromMirrorRegistry(d)
  const views = cleanSavedViews(d, [...present, ...DEPENDENT_LOOKUPS])

  regenerateView(TABLE)

  return {
    dropped: present.map(c => `${TABLE}.${c}`),
    backup,
    custom_fields_removed: fields, dependent_lookups_removed: lookups,
    airtable_mappings_removed: mappings, airtable_defs_removed: defs,
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
    console.warn(`[035] sauvegarde ${TABLE} impossible :`, e.message)
    return null
  }
}

// Le field_map « cœur » du miroir achats, stocké en JSON. Retirer ses clés coupe
// l'import à la source ET vide la note « champs Airtable gérés en code » de
// /champs/purchases, qui n'est que la liste de ses valeurs string. `qty_received`
// (valeur `null`, aucun champ Airtable derrière) est laissée : sa colonne survit.
function removeFromLegacyFieldMap(d) {
  const row = d.prepare('SELECT field_map FROM airtable_module_config WHERE module=?').get(MIRROR)
  if (!row?.field_map) return 0
  let map
  try { map = JSON.parse(row.field_map) } catch { return 0 }
  const removed = CORE_KEYS.filter(k => Object.hasOwn(map, k))
  if (!removed.length) return 0
  for (const k of removed) delete map[k]
  // airtable_module_config n'a pas de colonne updated_at (cf. db/schema.js) :
  // l'y écrire ferait échouer la migration au démarrage.
  d.prepare('UPDATE airtable_module_config SET field_map=? WHERE module=?')
    .run(JSON.stringify(map), MIRROR)
  return removed.length
}

// Registre du miroir, scopé au miroir `achats`. Les lignes visées sont celles en
// `state='core'` : leur `erp_column` pointe soit sur la colonne détruite, soit
// (cas « un champ Airtable, deux colonnes ERP ») sur le jumeau adopté. Elles
// repassent en `unmapped` — PAS en `excluded` : le champ Airtable existe
// toujours et l'utilisateur peut vouloir le (re)mapper depuis /champs/purchases,
// c'est précisément ce que la demande rend possible. `decided_by` reste
// 'backfill' pour que le rafraîchissement du registre puisse re-dériver l'état
// réel (un jumeau dont la def dynamique se réveille redeviendra 'mirrored').
// `undecided` n'existe pas ici : le CHECK de la table (migration 004) n'accepte
// que mirrored / core / excluded / unmapped / broken.
function excludeFromMirrorRegistry(d) {
  let n = 0
  for (const key of CORE_KEYS) {
    n += d.prepare(`
      UPDATE airtable_field_map
      SET state='unmapped', direction='none', erp_column=NULL, core_key=NULL,
          decided_by='backfill',
          decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE mirror_id=? AND core_key=? AND state='core'
    `).run(MIRROR, key).changes
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
