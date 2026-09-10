/**
 * 037 — Les 6 champs Airtable « codés en dur » des Retours : suppression
 * DÉFINITIVE.
 *
 * Demande depuis /champs/retours : « supprime tous les champs Airtable codés en
 * dur (Entreprise, Contact, # de retour, Statut du problème, Notes, Facturé le)
 * drop column ». Même voie que 023 / 028 / 029 / 030 / 032 / 033 / 035
 * (migration numérotée, tracée dans `schema_migrations`, appliquée au
 * `pm2 restart`), et même portée que 035 pour les Achats : c'est le pendant
 * Retours de ce lot.
 *
 * ── QUELLES colonnes, exactement ──────────────────────────────────────────
 * La note « N champs Airtable gérés en code » au bas de /champs/retours liste
 * les valeurs STRING du field_map cœur du module `retours`
 * (`airtable_module_config`). Ses clés nomment la colonne ERP alimentée — et
 * `hardcodedErpColumns()` (airtableAutoSync.js) ajoute le suffixe `_id` aux clés
 * qui n'en ont pas, d'où `company` → `company_id` :
 *
 *   company        « Entreprise »          → returns.company_id     (473/476)
 *   contact        « Contact »             → returns.contact        (403/476)
 *   return_number  « # de retour »         → returns.n_de_retour    (476/476)
 *   problem_status « Statut du problème »  → returns.problem_status ( 64/476)
 *   notes          « Notes »               → returns.notes          (  8/476)
 *   billed_at      « Facturé le »          → returns.billed_at      ( 43/476)
 *
 * Deux de ces colonnes sont des champs PERSONNALISÉS vivants (`contact` et
 * `n_de_retour`, adoptés par les migrations 027 et 026) : le garde-fou « champ
 * ressorti de la corbeille » de 035 ne s'applique donc PAS ici — ces deux
 * colonnes sont nommément visées par la demande, vivantes ou non.
 *
 * ── Ce que la table devient ───────────────────────────────────────────────
 * Un retour n'est plus rattaché à une entreprise ni à un contact, n'a plus de
 * numéro RMA, plus de statut de problème, plus de notes ni de date de
 * facturation. Ce qui reste : `status` (constante « Ouvert » du sync),
 * `order_id`, les colonnes de l'étiquette de retour (Novoxpress/UPS, aide-
 * mémoire, instructions) et TOUS les champs Airtable adoptés pilotés depuis
 * /champs/retours.
 *
 * L'entreprise d'un retour se lit désormais par ses ARTICLES
 * (`return_items.company_id`, à défaut l'entreprise du numéro de série) —
 * services/returnCompany.js. C'est la seule source qui survit : elle couvre
 * 321 des 476 retours historiques, et 100 % des retours créés depuis l'ERP
 * (« Retourner tous les numéros de série » écrit `return_items.company_id`).
 *
 * Effet de bord VOULU : le field_map cœur du module `retours` ne contient plus
 * aucune valeur string, donc plus aucun champ Airtable n'est « géré en code ».
 * Les six champs redeviennent mappables depuis /champs/retours, vers les
 * colonnes que l'utilisateur choisira.
 *
 * ── Ce qu'il a fallu couper côté code (hors migration) ────────────────────
 *  • `services/returnExchangeReminder.js` + son test SUPPRIMÉS — l'éligibilité
 *    reposait entièrement sur `billed_at IS NULL` et sur le contact du retour.
 *    L'automatisation « Rappel retours avec échange immédiat » part avec
 *    (RETIRED_SYSTEM_AUTOMATION_IDS + son planificateur dans index.js) ; elle
 *    était inactive (`active=0`) depuis son import ;
 *  • `services/returnCompany.js` AJOUTÉ — résolution de l'entreprise d'un
 *    retour par ses articles, utilisée par le contexte d'étiquette
 *    (returnContext.js), la fiche entreprise (routes/companies.js), le filtre
 *    `?company_id=` de la liste (routes/projets.js) et la commande de
 *    remplacement (returnItemCreatedWatcher.js) ;
 *  • `services/returnContext.js` — l'adresse client se cherche par cette
 *    entreprise-là ; le destinataire des courriels vient du contact de
 *    l'ADRESSE (le retour n'a plus de contact à lui) ;
 *  • `routes/retours.js` — mémo et instructions : langue et prénom du contact
 *    de l'adresse ; pièces jointes nommées par l'id du retour ; création en
 *    masse sans `company_id` sur le retour (les articles le portent) ;
 *  • `routes/ups.js`, `services/recordLinks.js` (libellé « Retour »),
 *    `services/trash.js`, `services/nativeFieldConversions.js` (les 3 entrées
 *    retours), `services/airtable.js` (syncRetours), `services/
 *    airtableMirrorEngine.js` (`CORE_PLANS.retours.fields` vidé),
 *    `db/schema.js`, et côté client `tableDefs.js`, `Retours.jsx`,
 *    `RetourDetail.jsx`, `CompanyDetail.jsx`, `recordPeekRoutes.jsx`,
 *    `useRecentRecords.js`.
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

export const id = '037-drop-returns-core-columns'
export const description =
  'returns : company_id, contact, n_de_retour, problem_status, notes et billed_at droppées — plus aucun champ Airtable géré en code sur les retours'

const TABLE = 'returns'
const COLUMNS = ['company_id', 'contact', 'n_de_retour', 'problem_status', 'notes', 'billed_at']
// Clés du field_map cœur à retirer. `company` et `contact` ne portent pas le
// suffixe `_id` de leur colonne d'origine (cf. hardcodedErpColumns), et
// `return_number` a été repointé sur `n_de_retour` par la migration 026 : on
// teste les graphies possibles.
const CORE_KEYS = ['company', 'company_id', 'contact', 'contact_id', 'return_number', 'n_de_retour', 'problem_status', 'notes', 'billed_at']
const MIRROR = 'retours'
// Les vues sauvegardées sont rangées sous le nom de la RESSOURCE : /retours et
// le tableau « Retours » de la fiche entreprise (cf. TABLE_COLUMN_META).
const VIEW_TABLES = ['retours', 'company_retours']
// Champ CALCULÉ de la table qui n'existe que par la FK détruite : sans lui,
// `regenerateView` construirait un `returns_v` qui joint sur `r.company_id`.
const DEPENDENT_LOOKUPS = ['company_name']

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = new Set(d.pragma(`table_info(${TABLE})`).map(c => c.name))
  const present = COLUMNS.filter(c => cols.has(c))
  if (!present.length) return { skipped: 'colonnes déjà absentes' }

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

  // Un rollup d'une autre table qui compte les retours d'une entreprise passe
  // par la FK `company_id` : la vue de CETTE table-là tomberait en erreur.
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

  // Si l'import Airtable a été (re)branché sur l'une des colonnes par une def
  // dynamique entre temps, le sync réécrirait une colonne disparue : on
  // s'arrête. (Les champs perso `contact` / `n_de_retour` sont alimentés par le
  // plan CŒUR, pas par une ligne de mapping : ils ne déclenchent pas ce test.)
  const mapped = d.prepare(
    `SELECT column_name FROM airtable_field_mappings
      WHERE erp_table=? AND column_name IN (${present.map(() => '?').join(',')})
        AND import_disabled IS NOT 1`
  ).get(TABLE, ...present)
  if (mapped) return { skipped: `import Airtable actif sur ${TABLE}.${mapped.column_name}` }

  const backup = backupValues(d, present)

  d.exec(`DROP VIEW IF EXISTS ${TABLE}_v`)
  for (const col of present) d.exec(`ALTER TABLE ${TABLE} DROP COLUMN [${col}]`)

  const ph = present.map(() => '?').join(',')
  const fields = d.prepare(`DELETE FROM custom_fields WHERE erp_table=? AND column_name IN (${ph})`)
    .run(TABLE, ...present).changes
  // « Entreprise » : lookup semé par nativeFieldConversions.js sur la FK
  // détruite. L'entrée est retirée du registre au même commit — sans quoi le
  // prochain démarrage le re-sèmerait.
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
  const released = releaseMirrorRegistry(d)
  const views = cleanSavedViews(d, [...present, ...DEPENDENT_LOOKUPS])

  regenerateView(TABLE)

  return {
    dropped: present.map(c => `${TABLE}.${c}`),
    backup,
    custom_fields_removed: fields, dependent_lookups_removed: lookups,
    airtable_mappings_removed: mappings, airtable_defs_removed: defs,
    field_map_keys_removed: unmapped, mirror_rows_released: released, ...views,
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
    console.warn(`[037] sauvegarde ${TABLE} impossible :`, e.message)
    return null
  }
}

// Le field_map « cœur » du miroir retours, stocké en JSON. Retirer ses clés
// coupe l'import à la source ET vide la note « champs Airtable gérés en code »
// de /champs/retours, qui n'est que la liste de ses valeurs string.
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

// Registre du miroir, scopé au miroir `retours`. Les six lignes visées sont en
// `state='core'` : elles repassent en `unmapped` — PAS en `excluded`. Le champ
// Airtable existe toujours et l'utilisateur peut vouloir le (re)mapper depuis
// /champs/retours, c'est précisément ce que la demande rend possible.
// `decided_by` reste 'backfill' pour que le rafraîchissement du registre puisse
// re-dériver l'état réel. `undecided` n'existe pas ici : le CHECK de la table
// (migration 004) n'accepte que mirrored / core / excluded / unmapped / broken.
function releaseMirrorRegistry(d) {
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
