import db from '../db/database.js'
import { getAccessToken, airtablePatch, airtablePost } from '../connectors/airtable.js'
import { getFrozenColumns } from './airtableFrozenColumns.js'
import { logSync } from './syncLog.js'

// Résout l'airtable_id d'un record ERP lié (commande, adresse…) pour un linked record.
function linkedAirtableId(table, erpId) {
  if (!erpId) return null
  const r = db.prepare(`SELECT airtable_id FROM ${table} WHERE id=?`).get(erpId)
  return r?.airtable_id || null
}

// Airtable ids des order_items assignés à un envoi (pour « items expédiés »).
function shipmentItemAirtableIds(shipmentId) {
  return db.prepare('SELECT airtable_id FROM order_items WHERE shipment_id=? AND airtable_id IS NOT NULL')
    .all(shipmentId).map(r => r.airtable_id)
}

// ── Write-back ERP → Airtable ────────────────────────────────────────────────
//
// Module pilote : « achats » (table ERP `purchases`). Quand un achat synchronisé
// depuis Airtable est édité dans l'ERP, on répercute la modification vers
// Airtable via PATCH. Une garde anti-boucle (airtable_writeback_guard) mémorise
// les valeurs poussées pour que le webhook de retour soit reconnu comme un echo
// et ignoré par le sync entrant (cf. consumeWritebackEcho dans syncAchats).
//
// Pour généraliser à d'autres modules : ajouter une entrée à WRITEBACK_MODULES
// (module Airtable ↔ table ERP) et déclencher writeBackRecord() sur l'édition.

const WRITEBACK_MODULES = {
  achats: {
    erpTable: 'purchases',
    // Clés du field_map qui pointent vers des linked records / champs non scalaires :
    // on ne sait pas les ré-écrire de façon fiable, on les exclut du write-back.
    // `product` → "Nom de la pièce" est un linked record dans Airtable.
    skipKeys: new Set(['product']),
    // Correspondance clé field_map → colonne ERP quand elles diffèrent.
    keyToColumn: { product: 'product_id' },
  },
  envois: {
    erpTable: 'shipments',
    // Seuls les champs scalaires écrivables côté Airtable sont poussés
    // (tracking_number → "Numéro de tracking", carrier → "Service de livraison",
    //  status → "Statut" singleSelect, shipped_at → "Date" dateTime, notes → "Notes").
    // Exclusions :
    //  • order   → "Commande lié"          : linked record
    //  • address → "Adresse de livraison"  : linked record
    //  • items   → "items expédiés"        : linked record (jamais dans field_map persisté, prudence)
    //  • pays    → "Pays de l'adresse de livraison" : champ lookup (multipleLookupValues)
    //              calculé depuis l'adresse liée → non écrivable, un PATCH dessus renverrait 422.
    skipKeys: new Set(['order', 'address', 'items', 'pays']),
    // Linked records à inclure UNIQUEMENT à la création (create ERP→Airtable).
    // Clé = clé du field_map (donne le nom de champ Airtable), resolve → record ids
    // Airtable à lier. Non poussés sur un simple update (un PATCH de linked record
    // depuis l'ERP n'est pas fiable — cf. skipKeys). `pays` reste exclu : lookup
    // dérivé de l'adresse, il se remplit tout seul côté Airtable une fois l'adresse liée.
    linkedRecords: {
      order:   (row) => { const id = linkedAirtableId('orders', row.order_id); return id ? [id] : null },
      address: (row) => { const id = linkedAirtableId('adresses', row.address_id); return id ? [id] : null },
      items:   (row) => { const ids = shipmentItemAirtableIds(row.id); return ids.length ? ids : null },
    },
  },
  // Webhook write surface (tickets / projects / serial_numbers). Ces modules sont
  // pull-only depuis Airtable ; sans write-back, une écriture ERP sur une colonne
  // mappée serait écrasée au prochain sync. Le write-back est best-effort : il ne
  // pousse que les colonnes scalaires mappées (les colonnes ERP-natives — assigned_to,
  // vendeur_ref, notes, custom fields… — restent en DB, jamais clobberées car le sync
  // entrant fait un upsert sélectif). Les linked records (company/contact) sont exclus.
  billets: {
    erpTable: 'tickets',
    skipKeys: new Set(['company', 'contact']),
    keyToColumn: { company: 'company_id', contact: 'contact_id' },
  },
  projets: {
    erpTable: 'projects',
    skipKeys: new Set(['company', 'contact']),
    keyToColumn: { company: 'company_id', contact: 'contact_id' },
    // field_map des projets vit dans airtable_projets_config (singleton), pas dans
    // airtable_module_config — d'où la source de config dédiée.
    configSource: { table: 'airtable_projets_config', baseCol: 'base_id', tableIdCol: 'projects_table_id', fieldMapCol: 'field_map_projects' },
  },
  serials: {
    erpTable: 'serial_numbers',
    skipKeys: new Set(['product', 'company', 'order_item']),
    keyToColumn: { product: 'product_id', company: 'company_id', order_item: 'order_item_id' },
  },
}

// Lit base_id / table_id / field_map du module. La plupart des modules vivent dans
// airtable_module_config (clé `module`), mais certains (projets) ont leur propre
// table singleton — déclaré via cfg.configSource. Retourne null si absent.
function readAirtableConfig(module) {
  const src = WRITEBACK_MODULES[module]?.configSource
  if (src) {
    // Colonnes interpolées depuis configSource (littéraux du code, jamais user input) → safe.
    return db.prepare(
      `SELECT ${src.baseCol} AS base_id, ${src.tableIdCol} AS table_id, ${src.fieldMapCol} AS field_map FROM ${src.table} LIMIT 1`
    ).get()
  }
  return db.prepare('SELECT base_id, table_id, field_map FROM airtable_module_config WHERE module=?').get(module)
}

// Tables exposées au moteur de webhooks → clé module write-back correspondante.
// Une écriture du webhook sur une de ces tables déclenche un write-back best-effort.
export const TABLE_TO_WRITEBACK_MODULE = {
  tickets: 'billets',
  projects: 'projets',
  serial_numbers: 'serials',
}

// TTL de la garde : au-delà, une entrée non consommée est considérée périmée
// (le webhook a été manqué ou un vrai changement Airtable est survenu depuis).
const GUARD_TTL_MS = 2 * 60 * 1000

// Normalise une valeur (envoyée ou reçue d'Airtable) pour comparaison d'echo.
function normVal(v) {
  if (v == null || v === '') return ''
  if (Array.isArray(v)) return v.map(normVal).join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v).trim()
}

// Mémorise les champs poussés vers Airtable AVANT le PATCH, pour que le webhook
// de retour (echo) soit reconnaissable même s'il arrive très vite.
export function recordWriteback(airtableId, fields) {
  db.prepare(`
    INSERT INTO airtable_writeback_guard (airtable_id, fields_json, written_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(airtable_id) DO UPDATE SET
      fields_json = excluded.fields_json,
      written_at = excluded.written_at
  `).run(airtableId, JSON.stringify(fields))
}

// Appelé par le sync entrant (webhook) pour chaque record Airtable. Renvoie true
// si ce record correspond à un write-back ERP récent dont les valeurs n'ont pas
// changé depuis → c'est notre propre echo, le sync doit l'ignorer.
// Consomme (supprime) l'entrée de garde dans tous les cas où elle est résolue.
export function consumeWritebackEcho(airtableId, airtableFields) {
  const row = db.prepare('SELECT fields_json, written_at FROM airtable_writeback_guard WHERE airtable_id=?').get(airtableId)
  if (!row) return false

  const age = Date.now() - new Date(row.written_at).getTime()
  if (!(age >= 0) || age > GUARD_TTL_MS) {
    // Entrée périmée : on la nettoie et on laisse le sync traiter normalement.
    db.prepare('DELETE FROM airtable_writeback_guard WHERE airtable_id=?').run(airtableId)
    return false
  }

  let pushed
  try { pushed = JSON.parse(row.fields_json) } catch { pushed = null }
  if (!pushed || typeof pushed !== 'object') {
    db.prepare('DELETE FROM airtable_writeback_guard WHERE airtable_id=?').run(airtableId)
    return false
  }

  // Echo confirmé seulement si TOUS les champs poussés correspondent encore aux
  // valeurs Airtable actuelles. Sinon un vrai changement a eu lieu après notre
  // write → on laisse le sync l'appliquer.
  const fields = airtableFields || {}
  const isEcho = Object.entries(pushed).every(([k, v]) => normVal(fields[k]) === normVal(v))

  // Garde à usage unique : on la supprime qu'il s'agisse d'un echo ou non.
  db.prepare('DELETE FROM airtable_writeback_guard WHERE airtable_id=?').run(airtableId)
  return isEcho
}

// Construit la correspondance colonne ERP → nom de champ Airtable à partir du
// field_map du module, en excluant les clés non scalaires.
function buildColumnMap(module, fieldMap) {
  const cfg = WRITEBACK_MODULES[module]
  const out = {}
  for (const [key, atField] of Object.entries(fieldMap || {})) {
    if (!atField) continue                       // pas de champ Airtable mappé
    if (cfg.skipKeys.has(key)) continue          // linked record / non scalaire
    const col = cfg.keyToColumn?.[key] || key
    out[col] = atField
  }
  return out
}

// Pousse une modification d'un record ERP vers Airtable.
// @param module        clé module Airtable ('achats')
// @param recordId      id ERP du record
// @param changedColumns  optionnel : colonnes réellement modifiées (filtre le payload)
export async function writeBackRecord(module, recordId, changedColumns = null) {
  const cfg = WRITEBACK_MODULES[module]
  if (!cfg) return { skipped: 'module non éligible' }

  // Tout le corps est sous try : les lectures DB (config, record), buildColumnMap
  // et getFrozenColumns peuvent lever AVANT l'appel réseau. Sans ce filet, ces
  // throws s'échappaient en fire-and-forget et n'étaient capturés que par un
  // console.error côté route — aucune trace dans sync_log, write-back rompu en
  // silence. Désormais tout échec produit exactement une entrée sync_log error.
  const t0 = Date.now()
  let airtableId = null
  try {
    const config = readAirtableConfig(module)
    if (!config?.base_id || !config?.table_id || !config?.field_map) return { skipped: 'config Airtable absente' }

    const row = db.prepare(`SELECT * FROM ${cfg.erpTable} WHERE id=?`).get(recordId)
    if (!row) return { skipped: 'record introuvable' }
    if (!row.airtable_id) return { skipped: 'record non lié à Airtable' } // pilote : update only
    airtableId = row.airtable_id

    let fieldMap
    try { fieldMap = JSON.parse(config.field_map) } catch { return { skipped: 'field_map illisible' } }

    const columnMap = buildColumnMap(module, fieldMap)
    const frozen = getFrozenColumns(cfg.erpTable)
    const changedSet = changedColumns ? new Set(changedColumns) : null

    const fields = {}
    for (const [col, atField] of Object.entries(columnMap)) {
      if (changedSet && !changedSet.has(col)) continue   // ne pousser que ce qui a changé
      if (frozen.has(col)) continue                       // colonne gelée : jamais écrite
      fields[atField] = row[col] ?? null                  // null = effacer le champ Airtable
    }

    if (Object.keys(fields).length === 0) return { skipped: 'aucun champ à pousser' }

    const token = await getAccessToken()
    // Mémoriser AVANT le PATCH : le webhook peut revenir avant la fin du fetch.
    recordWriteback(airtableId, fields)
    await airtablePatch(`/${config.base_id}/${config.table_id}/${airtableId}`, token, {
      fields,
      typecast: true,
    })
    logSync(module, 'erp-writeback', { status: 'success', modified: 1, durationMs: Date.now() - t0 })
    console.log(`↩️  Write-back ${module} → Airtable ${airtableId} (${Object.keys(fields).join(', ')})`)
    return { ok: true, airtable_id: airtableId, fields }
  } catch (e) {
    // Échec : retirer la garde (si posée) sinon elle masquerait un vrai sync entrant ultérieur.
    if (airtableId) db.prepare('DELETE FROM airtable_writeback_guard WHERE airtable_id=?').run(airtableId)
    logSync(module, 'erp-writeback', { status: 'error', error: `${recordId}: ${e.message}`, durationMs: Date.now() - t0 })
    console.error(`❌ Write-back ${module} ${recordId}:`, e.message)
    return { error: e.message }
  }
}

// Crée dans Airtable un record ERP qui n'y existe pas encore (sens ERP → Airtable),
// puis mémorise l'airtable_id retourné sur la ligne ERP. C'est le pendant « création »
// de writeBackRecord (qui ne gère que l'update d'un record déjà lié). Pousse les
// champs scalaires (mêmes exclusions que l'update) + les linked records configurés
// dans WRITEBACK_MODULES[module].linkedRecords (commande, adresse, items). La garde
// anti-boucle est posée pour que le webhook de création de retour soit reconnu comme
// notre propre echo et non ré-importé. Idempotent : si le record a déjà un airtable_id,
// on ne fait rien.
export async function createInAirtable(module, recordId) {
  const cfg = WRITEBACK_MODULES[module]
  if (!cfg) return { skipped: 'module non éligible' }

  // Tout le corps est sous try (cf. writeBackRecord) : les lectures DB et la
  // construction du payload peuvent lever AVANT l'appel réseau. C'est précisément
  // le cas qui cassait le 2-way sync en silence — un envoi créé dans l'ERP restait
  // sans airtable_id quand Airtable était indisponible, et le throw fire-and-forget
  // n'aboutissait qu'à un console.error. Désormais chaque échec laisse une trace
  // sync_log error (avec le recordId) exploitable depuis l'historique des syncs.
  const t0 = Date.now()
  try {
    const config = readAirtableConfig(module)
    if (!config?.base_id || !config?.table_id || !config?.field_map) return { skipped: 'config Airtable absente' }

    const row = db.prepare(`SELECT * FROM ${cfg.erpTable} WHERE id=?`).get(recordId)
    if (!row) return { skipped: 'record introuvable' }
    if (row.airtable_id) return { skipped: 'record déjà lié à Airtable' }

    let fieldMap
    try { fieldMap = JSON.parse(config.field_map) } catch { return { skipped: 'field_map illisible' } }

    const columnMap = buildColumnMap(module, fieldMap)
    const frozen = getFrozenColumns(cfg.erpTable)

    // Champs scalaires : on n'envoie que les valeurs non vides (un null sur un champ
    // singleSelect/lookup inexistant à la création est inutile et peut bruiter).
    const fields = {}
    for (const [col, atField] of Object.entries(columnMap)) {
      if (frozen.has(col)) continue
      const v = row[col]
      if (v != null && v !== '') fields[atField] = v
    }

    // Linked records (commande, adresse, items) — seulement si le field_map nomme le
    // champ Airtable correspondant et qu'on a des record ids à lier.
    for (const [key, resolve] of Object.entries(cfg.linkedRecords || {})) {
      const atField = fieldMap[key]
      if (!atField) continue
      const ids = resolve(row)
      if (ids && ids.length) fields[atField] = ids
    }

    if (Object.keys(fields).length === 0) return { skipped: 'aucun champ à pousser' }

    const token = await getAccessToken()
    const resp = await airtablePost(`/${config.base_id}/${config.table_id}`, token, { fields, typecast: true })
    const airtableId = resp?.id
    if (!airtableId) throw new Error('réponse Airtable sans id')

    // Atomique : poser l'airtable_id ET la garde anti-boucle dans une seule
    // transaction. Si recordWriteback échouait après l'UPDATE, la garde manquerait
    // et le webhook « record created » ré-importerait le record en doublon (boucle
    // de sync). Le tout-ou-rien garantit qu'on n'a jamais un airtable_id lié sans
    // sa garde, ni l'inverse.
    db.transaction(() => {
      db.prepare(`UPDATE ${cfg.erpTable} SET airtable_id=? WHERE id=?`).run(airtableId, recordId)
      // Garde anti-boucle : le webhook « record created » va revenir avec ces valeurs,
      // consumeWritebackEcho le reconnaîtra et le sync entrant ne le ré-importera pas.
      recordWriteback(airtableId, fields)
    })()

    logSync(module, 'erp-create', { status: 'success', modified: 1, durationMs: Date.now() - t0 })
    console.log(`➕ Create ${module} → Airtable ${airtableId} (${Object.keys(fields).join(', ')})`)
    return { ok: true, airtable_id: airtableId, fields }
  } catch (e) {
    logSync(module, 'erp-create', { status: 'error', error: `${recordId}: ${e.message}`, durationMs: Date.now() - t0 })
    console.error(`❌ Create ${module} ${recordId}:`, e.message)
    return { error: e.message }
  }
}
