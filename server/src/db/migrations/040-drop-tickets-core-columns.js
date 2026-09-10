/**
 * 040 — Les 9 champs Airtable « codés en dur » des Billets : suppression
 * DÉFINITIVE.
 *
 * Demande depuis /champs/tickets : « supprime tous les champs codés en dur
 * (ID, Question, Type support, Statut, Entreprise, Contacts, Temps en minutes,
 * Date, Réponse) drop column ». Même voie que 023 / 028 / 029 / 030 / 032 /
 * 033 / 035 / 037 (migration numérotée, tracée dans `schema_migrations`,
 * appliquée au `pm2 restart`), et même portée que 035 (Achats) et 037
 * (Retours) : c'est le pendant Billets de ce lot.
 *
 * ── QUELLES colonnes, exactement ──────────────────────────────────────────
 * La note « N champs Airtable gérés en code » au bas de /champs/tickets liste
 * les valeurs STRING du field_map cœur du module `billets`
 * (`airtable_module_config`). Ses clés nomment la colonne ERP alimentée — et
 * `hardcodedErpColumns()` (airtableAutoSync.js) ajoute le suffixe `_id` aux
 * clés qui n'en ont pas, d'où `company` → `company_id` :
 *
 *   title            « ID »                 → tickets.title            (3 688/3 688)
 *   description      « Question »           → tickets.description      (3 673/3 688)
 *   type             « Type support »       → tickets.type             (2 705/3 688)
 *   status           « Statut »             → tickets.status           (3 688/3 688)
 *   company          « Entreprise »         → tickets.company_id       (3 648/3 688)
 *   contact          « Contacts »           → tickets.contact_id       (1 867/3 688)
 *   duration_minutes « Temps en minutes »   → tickets.duration_minutes (3 688/3 688)
 *   created_at       « Date »               → tickets.created_at       (3 688/3 688)
 *   response         « Réponse »            → tickets.response         (  869/3 688)
 *
 * `status_map` part avec elles : ce n'est pas un champ Airtable mais la table
 * de correspondance des statuts, sans objet une fois `status` détruite.
 *
 * ── Ce que la table devient ───────────────────────────────────────────────
 * Un billet n'a plus de titre, de question, de réponse, de type, de statut, de
 * durée, de date de création, ni de lien vers une entreprise ou un contact
 * côté colonnes NATIVES. Ce qui reste : `assigned_to`, `updated_at`,
 * `airtable_id` et TOUS les champs Airtable adoptés pilotés depuis
 * /champs/tickets — dont des jumeaux partiels des colonnes détruites
 * (`titre`, `reponse`, `temps`, `heures`, `conseiller`, `responsable`…). Ces
 * jumeaux ne sont PAS repris par le code : un champ personnalisé se supprime
 * d'un clic, s'appuyer dessus reviendrait à bâtir sur du sable (cf.
 * l'avertissement en tête de nativeFieldConversions.js).
 *
 * Effet de bord VOULU : le field_map cœur du module `billets` ne contient plus
 * aucune valeur string, donc plus aucun champ Airtable n'est « géré en code ».
 * Les neuf champs redeviennent mappables depuis /champs/tickets, vers les
 * colonnes que l'utilisateur choisira.
 *
 * ── Ce qu'il a fallu couper côté code (hors migration) ────────────────────
 *  • `routes/tickets.js` — /meta et PATCH /:id/status supprimés (plus de types
 *    ni de statuts), filtres `?status=` / `?type=` / `?company_id=` et
 *    recherche par titre retirés, tri sur `updated_at`, création réduite à
 *    l'assignation ;
 *  • `services/ticketSurveys.js` — le sondage ne peut plus lire le contact du
 *    billet : numéro ET langue se saisissent à l'envoi (le renvoi reprend ceux
 *    du sondage existant). `publicSurveyView` ne renvoie plus de titre ;
 *  • `routes/companies.js` — une entreprise n'a plus d'onglet « Support » : le
 *    lien billet ↔ entreprise n'existe plus ;
 *  • `routes/search.js` — les billets sortent de la recherche globale (plus de
 *    libellé à chercher) ;
 *  • `routes/dashboard.js` — billets ouverts, « Billets par mois » et
 *    « Billets par semaine » retirés (statut, date et durée détruits) ;
 *  • `services/nativeFieldConversions.js` — `tickets.company_name` (lookup sur
 *    la FK détruite) et `tasks.ticket_title` (lookup sur `tickets.title`)
 *    retirés, sinon ils sont re-semés à chaque démarrage et `tickets_v` /
 *    `tasks_v` joindraient sur des colonnes absentes ;
 *  • `services/recordLinks.js` (libellé « Billet »),
 *    `services/airtableMirrorEngine.js` (`CORE_PLANS.billets.fields` vidé),
 *    `services/airtable.js` (`syncBillets`), `services/airtableWriteback.js`,
 *    `services/systemAutomations.js` (gabarit Slack de l'escalade),
 *    `db/changeLog.js`, `db/schema.js`, et côté client `tableDefs.js`,
 *    `Tickets.jsx`, `TicketDetail.jsx`, `TicketSurvey.jsx`, `Tasks.jsx`,
 *    `CompanyDetail.jsx`, `Dashboard.jsx`, `DashboardOverview.jsx`,
 *    `GlobalSearch.jsx`, `useRecentRecords.js`, `Badge.jsx`.
 *
 * ── Le filet ──────────────────────────────────────────────────────────────
 * Détruire les valeurs EST la demande : le garde-fou « colonne non vide » de
 * 023 ne s'applique pas (cf. 028). Il est remplacé par une sauvegarde JSON
 * dans `uploads/backups/`, comme le fait `services/fieldPurge.js`.
 *
 * Particularité par rapport à 037 : quatre INDEX portent sur les colonnes
 * visées (`idx_tickets_status`, `idx_tickets_company`, `idx_tickets_created`,
 * `idx_tickets_contact_id`). SQLite refuse `DROP COLUMN` sur une colonne
 * indexée — ils tombent AVANT, et leurs `CREATE INDEX` sortent de schema.js.
 *
 * Défensive : chaque garde-fou renvoie `skipped` au lieu de lever — une
 * exception arrêterait le démarrage du serveur.
 */
import fs from 'node:fs'
import path from 'node:path'
import db from '../database.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '040-drop-tickets-core-columns'
export const description =
  'tickets : title, description, type, status, company_id, contact_id, duration_minutes, created_at et response droppées — plus aucun champ Airtable géré en code sur les billets'

const TABLE = 'tickets'
const COLUMNS = ['title', 'description', 'type', 'status', 'company_id', 'contact_id',
  'duration_minutes', 'created_at', 'response']
// Clés du field_map cœur à retirer. `company` et `contact` ne portent pas le
// suffixe `_id` de leur colonne (cf. hardcodedErpColumns) ; `status_map` est la
// table de correspondance des statuts, pas un champ Airtable.
const CORE_KEYS = ['title', 'description', 'type', 'status', 'status_map', 'company', 'company_id',
  'contact', 'contact_id', 'duration_minutes', 'created_at', 'response']
const MIRROR = 'billets'
// Les vues sauvegardées sont rangées sous le nom de la RESSOURCE : /billets et
// le tableau « Support » de la fiche entreprise (cf. TABLE_COLUMN_META).
const VIEW_TABLES = ['tickets', 'company_tickets']
// Champs CALCULÉS semés par nativeFieldConversions.js qui n'existent que par
// les colonnes détruites. Leurs entrées sont retirées du registre au même
// commit — sans quoi le prochain démarrage les re-sèmerait.
const DEPENDENT_LOOKUPS = [
  { table: 'tickets', column: 'company_name' },  // lookup sur la FK company_id
  { table: 'tasks',   column: 'ticket_title' },  // lookup sur tickets.title
]
// Vues SQL à reconstruire : celle de la table, plus celle de `tasks` qui joint
// sur `tickets.title` par le lookup ci-dessus.
const VIEWS_TO_REBUILD = ['tickets', 'tasks']

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = new Set(d.pragma(`table_info(${TABLE})`).map(c => c.name))
  const present = COLUMNS.filter(c => cols.has(c))
  if (!present.length) return { skipped: 'colonnes déjà absentes' }

  const exempt = new Set(DEPENDENT_LOOKUPS.map(l => `${l.table}.${l.column}`))

  // Un lookup / rollup d'une AUTRE table qui viserait l'une des colonnes serait
  // vidé en silence (hors ceux qu'on retire nous-mêmes juste après).
  for (const col of present) {
    const dependents = d.prepare(
      `SELECT erp_table, column_name, name FROM custom_fields
        WHERE deleted_at IS NULL AND erp_table <> ?
          AND ((lookup_target_table=? AND lookup_target_column=?)
            OR (rollup_target_table=? AND rollup_target_column=?))`
    ).all(TABLE, TABLE, col, TABLE, col)
    const blocker = dependents.find(r => !exempt.has(`${r.erp_table}.${r.column_name}`))
    if (blocker) return { skipped: `champ calculé dépendant : ${blocker.erp_table}.${blocker.name}` }
  }

  // Un rollup d'une autre table qui compte les billets d'une entreprise passe
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
  // s'arrête.
  const mapped = d.prepare(
    `SELECT column_name FROM airtable_field_mappings
      WHERE erp_table=? AND column_name IN (${present.map(() => '?').join(',')})
        AND import_disabled IS NOT 1`
  ).get(TABLE, ...present)
  if (mapped) return { skipped: `import Airtable actif sur ${TABLE}.${mapped.column_name}` }

  const backup = backupValues(d, present)

  for (const view of VIEWS_TO_REBUILD) d.exec(`DROP VIEW IF EXISTS ${view}_v`)
  const indexes = dropDependentIndexes(d, present)
  for (const col of present) d.exec(`ALTER TABLE ${TABLE} DROP COLUMN [${col}]`)

  const ph = present.map(() => '?').join(',')
  const fields = d.prepare(`DELETE FROM custom_fields WHERE erp_table=? AND column_name IN (${ph})`)
    .run(TABLE, ...present).changes
  let lookups = 0
  for (const l of DEPENDENT_LOOKUPS) {
    lookups += d.prepare('DELETE FROM custom_fields WHERE erp_table=? AND column_name=?')
      .run(l.table, l.column).changes
  }
  const mappings = d.prepare(`DELETE FROM airtable_field_mappings WHERE erp_table=? AND column_name IN (${ph})`)
    .run(TABLE, ...present).changes
  let defs = 0
  try {
    defs = d.prepare(`DELETE FROM airtable_field_defs WHERE erp_table=? AND column_name IN (${ph})`)
      .run(TABLE, ...present).changes
  } catch { /* table héritée absente */ }

  const unmapped = removeFromLegacyFieldMap(d)
  const released = releaseMirrorRegistry(d)
  const views = cleanSavedViews(d, [...present, 'company_name'])

  for (const view of VIEWS_TO_REBUILD) regenerateView(view)

  return {
    dropped: present.map(c => `${TABLE}.${c}`),
    backup, indexes_dropped: indexes,
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
    console.warn(`[040] sauvegarde ${TABLE} impossible :`, e.message)
    return null
  }
}

// SQLite refuse `ALTER TABLE … DROP COLUMN` tant qu'un index porte la colonne.
// On les lit du schéma plutôt que de les nommer : la liste a bougé plusieurs
// fois (schema.js + migration 001) et un index oublié arrêterait le démarrage.
function dropDependentIndexes(d, columns) {
  const dropped = new Set(columns)
  const names = []
  for (const idx of d.pragma(`index_list(${TABLE})`)) {
    if (idx.origin !== 'c') continue      // 'pk' / 'u' : contraintes, pas des index nommés
    const cols = d.pragma(`index_info(${idx.name})`).map(c => c.name)
    if (cols.some(c => dropped.has(c))) {
      d.exec(`DROP INDEX IF EXISTS [${idx.name}]`)
      names.push(idx.name)
    }
  }
  return names
}

// Le field_map « cœur » du miroir billets, stocké en JSON. Retirer ses clés
// coupe l'import à la source ET vide la note « champs Airtable gérés en code »
// de /champs/tickets, qui n'est que la liste de ses valeurs string.
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

// Registre du miroir, scopé au miroir `billets`. Les lignes visées sont en
// `state='core'` : elles repassent en `unmapped` — PAS en `excluded`. Le champ
// Airtable existe toujours et l'utilisateur peut vouloir le (re)mapper depuis
// /champs/tickets, c'est précisément ce que la demande rend possible.
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
