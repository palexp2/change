/**
 * Airtable Auto-Sync — automatically imports ALL fields from an Airtable table
 * into the ERP, creating columns and storing field metadata dynamically.
 */
import path from 'path'
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { getAccessToken, airtableFetch } from '../connectors/airtable.js'
import { getFrozenColumns } from './airtableFrozenColumns.js'
import { dynamicFieldDirection, writebackModuleForTable } from './airtableWriteback.js'

// ── Airtable type → ERP type mapping ────────────────────────────────────────

function mapAirtableType(atField) {
  const t = atField.type
  switch (t) {
    case 'singleLineText':
    case 'richText':
    case 'barcode':
    case 'externalSyncSource':
      return { field_type: 'text', options: {} }

    case 'multilineText':
      return { field_type: 'long_text', options: {} }

    case 'number':
    case 'count':
    case 'autoNumber':
      return { field_type: 'number', options: { precision: atField.options?.precision } }

    case 'currency':
      return { field_type: 'number', options: { format: 'currency', symbol: atField.options?.symbol } }

    case 'percent':
      return { field_type: 'number', options: { format: 'percent' } }

    case 'singleSelect':
      return {
        field_type: 'single_select',
        options: { choices: (atField.options?.choices || []).map(c => c.name) },
      }

    case 'multipleSelects':
      return {
        field_type: 'multi_select',
        options: { choices: (atField.options?.choices || []).map(c => c.name) },
      }

    case 'checkbox':
      return { field_type: 'checkbox', options: {} }

    case 'date':
    case 'dateTime':
    case 'createdTime':
    case 'lastModifiedTime':
      return { field_type: 'date', options: {} }

    case 'email':
      return { field_type: 'text', options: { format: 'email' } }

    case 'url':
      return { field_type: 'text', options: { format: 'url' } }

    case 'phoneNumber':
      return { field_type: 'text', options: { format: 'phone' } }

    case 'rating':
      return { field_type: 'number', options: { format: 'rating', max: atField.options?.max } }

    case 'multipleRecordLinks':
      return {
        field_type: 'link',
        options: { linked_table_id: atField.options?.linkedTableId },
      }

    case 'rollup':
    case 'lookup':
    case 'multipleLookupValues':
    case 'formula': {
      // Use the result type if available (e.g. formula returning a number)
      const resultType = atField.options?.result?.type
      if (resultType === 'number' || resultType === 'currency' || resultType === 'percent')
        return { field_type: 'number', options: { source: t, precision: atField.options?.result?.options?.precision } }
      if (resultType === 'date' || resultType === 'dateTime')
        return { field_type: 'date', options: { source: t } }
      if (resultType === 'checkbox')
        return { field_type: 'checkbox', options: { source: t } }
      return { field_type: 'text', options: { source: t } }
    }

    case 'multipleAttachments':
      return { field_type: 'text', options: { format: 'attachment' } }

    default:
      return { field_type: 'text', options: {} }
  }
}

// ── Convert Airtable field value to ERP value ───────────────────────────────

// Cache statements pour la résolution des liens (par table cible).
const _linkResolverCache = new Map()
function resolveAirtableIdToErp(targetTable, airtableId) {
  if (!airtableId) return null
  let stmt = _linkResolverCache.get(targetTable)
  if (!stmt) {
    stmt = db.prepare(`SELECT id FROM ${targetTable} WHERE airtable_id=?`)
    _linkResolverCache.set(targetTable, stmt)
  }
  const row = stmt.get(airtableId)
  return row?.id || null
}

// Un champ Airtable de type `percent` renvoie une FRACTION par l'API : 0.85 pour
// une cellule affichée « 85 % ». Stocker la valeur brute donnait une probabilité
// de projet à « 0.85 % » sur /pipeline (et un pipeline pondéré 100× trop petit au
// dashboard, qui calcule value_cad * probability / 100). On repasse donc en
// points de pourcentage (0-100) à l'import — c'est la convention de toutes les
// colonnes pourcentage de l'ERP (curseur 0-100 du formulaire projet, affichage
// `{probability}%`). L'arrondi à 4 décimales absorbe le bruit binaire
// (0.07 * 100 = 7.000000000000001).
function percentToPoints(val) {
  return Math.round(val * 100 * 10000) / 10000
}

export function convertValue(val, fieldType, options) {
  if (val === null || val === undefined) return null

  if (options?.format === 'percent' && typeof val === 'number') return percentToPoints(val)

  switch (fieldType) {
    case 'single_select':
      return typeof val === 'string' ? val : String(val)

    case 'multi_select':
      return Array.isArray(val) ? JSON.stringify(val) : JSON.stringify([val])

    case 'checkbox':
      return val ? 1 : 0

    case 'number':
      return typeof val === 'number' ? val : null

    case 'date': {
      if (!val) return null
      const d = new Date(val)
      return isNaN(d.getTime()) ? null : d.toISOString()
    }

    case 'link': {
      // Si la def porte une `link_target_table`, on résout chaque record ID
      // Airtable vers le UUID ERP correspondant. Sinon (legacy / pas configuré),
      // on stocke les IDs Airtable bruts comme avant.
      const arr = Array.isArray(val) ? val : [val]
      const target = options?.link_target_table
      if (target) {
        const resolved = arr.map(rid => resolveAirtableIdToErp(target, rid)).filter(Boolean)
        return JSON.stringify(resolved)
      }
      return JSON.stringify(arr)
    }

    case 'text':
    case 'long_text':
    default:
      if (Array.isArray(val)) {
        // Attachments, lookups, etc. — flatten to text
        return val.map(v => v == null ? '' : typeof v === 'object' ? (v.url || v.name || JSON.stringify(v)) : String(v)).join(', ')
      }
      if (typeof val === 'object') return JSON.stringify(val)
      return String(val)
  }
}

// ── Miroir local des pièces jointes image ───────────────────────────────────
//
// Les URL d'attachment Airtable (v5.airtableusercontent.com) expirent au bout de
// quelques heures : passé ce délai elles répondent 410 Gone. Une colonne « Image »
// qui stocke l'URL telle quelle finit donc par n'afficher qu'un lien mort — alors
// qu'une colonne image doit montrer une image. On recopie la pièce jointe sous
// `uploads/attachments/airtable/` et on stocke un chemin same-origin STABLE
// (`/erp/api/attachments/airtable/<fichier>`, servi en statique par index.js), que
// le front rend en vignette (cf. `imageSrc`/`ImageValue` côté client).
//
// Même principe que les images produit (`syncPieces` dans airtable.js), mais
// générique : s'applique à n'importe quelle colonne image de n'importe quelle
// table synchronisée depuis Airtable.

const ATTACHMENT_MIRROR_DIR = () =>
  path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'attachments', 'airtable')

const IMAGE_FILENAME_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|heic|heif)$/i
// Sous-types MIME image → extension de fichier. Les autres retombent sur le
// sous-type lui-même (déjà l'extension usuelle pour png/gif/webp/avif/bmp…).
const MIME_EXT = { jpeg: 'jpg', 'svg+xml': 'svg', 'x-icon': 'ico' }

// Pièces jointes image d'une valeur de champ Airtable. Tolère un niveau
// d'imbrication : un lookup d'un champ attachment renvoie un tableau de tableaux.
function imageAttachmentsOf(val) {
  if (!Array.isArray(val)) return []
  const flat = val.flat ? val.flat() : val
  const atts = []
  for (const att of flat) {
    if (!att || typeof att !== 'object' || typeof att.url !== 'string') return []
    const isImage = typeof att.type === 'string'
      ? att.type.startsWith('image/')
      : IMAGE_FILENAME_RE.test(att.filename || '')
    if (!isImage) return []
    atts.push(att)
  }
  return atts
}

function mirrorFileName(att) {
  const fromName = (att.filename || '').match(IMAGE_FILENAME_RE)?.[1]
  const fromMime = (att.type || '').startsWith('image/')
    ? (att.type.slice(6).toLowerCase())
    : null
  const raw = fromName || (fromMime && (MIME_EXT[fromMime] || fromMime)) || 'jpg'
  const ext = raw.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
  // `att.id` est stable pour une pièce jointe donnée : le fichier n'est
  // retéléchargé à aucun sync ultérieur (cf. existsSync ci-dessous).
  return `${String(att.id || '').replace(/[^A-Za-z0-9_-]/g, '') || 'att'}.${ext}`
}

// Les photos Airtable sortent souvent de l'appareil en pleine résolution (2 à
// 11 Mo pièce, mesuré sur le module Assemblages). Une colonne de tableau les
// affiche en 28px : on stocke donc une copie réduite à 1024px sur le grand côté
// — assez pour l'aperçu plein écran au clic, ~50× plus légère à charger. Formats
// que sharp ne rastérise pas proprement (SVG vectoriel, GIF animé) et échecs de
// décodage : on garde les octets d'origine.
const MIRROR_MAX_PX = 1024
const NO_RESIZE_EXT = /\.(svg|gif|ico)$/i

async function downscale(buffer, file) {
  if (NO_RESIZE_EXT.test(file)) return buffer
  try {
    const { default: sharp } = await import('sharp')
    const pipeline = sharp(buffer)
      .rotate() // respecte l'orientation EXIF, perdue au redimensionnement
      .resize({ width: MIRROR_MAX_PX, height: MIRROR_MAX_PX, fit: 'inside', withoutEnlargement: true })
    // Ces photos sont souvent exportées en PNG (sans perte) : ré-encoder avec
    // une palette divise encore la taille par ~5 sans différence visible à
    // l'écran. On conserve toujours le format d'origine — le nom de fichier
    // (donc l'URL déjà écrite en DB) porte l'extension.
    const out = /\.png$/i.test(file)
      ? pipeline.png({ compressionLevel: 9, palette: true })
      : /\.jpe?g$/i.test(file)
        ? pipeline.jpeg({ quality: 82, mozjpeg: true })
        : pipeline
    const resized = await out.toBuffer()
    return resized.length < buffer.length ? resized : buffer
  } catch {
    return buffer
  }
}

/**
 * Télécharge les pièces jointes image des `records` pour les champs demandés et
 * retourne une Map `${recordId}::${airtableFieldName}` → valeur ERP à écrire
 * (chemin same-origin, plusieurs pièces jointes jointes par ', ' comme le fait
 * `convertValue` pour les tableaux). Les champs sans image sont absents de la
 * Map : l'appelant retombe alors sur `convertValue`.
 *
 * Ne jette jamais : un téléchargement raté laisse simplement le champ au
 * comportement historique (URL Airtable brute) plutôt que de casser la sync.
 */
async function mirrorImageAttachments(records, fieldNames) {
  const out = new Map()
  if (!fieldNames.length || !records?.length) return out
  const dir = ATTACHMENT_MIRROR_DIR()
  let dirReady = false
  const failed = new Set()

  for (const rec of records) {
    for (const name of fieldNames) {
      const atts = imageAttachmentsOf(rec.fields?.[name])
      if (!atts.length) continue
      const paths = []
      for (const att of atts) {
        const file = mirrorFileName(att)
        if (failed.has(file)) break
        const dest = path.join(dir, file)
        if (!existsSync(dest)) {
          try {
            if (!dirReady) { await mkdir(dir, { recursive: true }); dirReady = true }
            const res = await fetch(att.url)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            await writeFile(dest, await downscale(Buffer.from(await res.arrayBuffer()), file))
          } catch (e) {
            failed.add(file)
            console.error(`⚠️  Airtable attachment « ${name} » (${file}): ${e.message}`)
            break
          }
        }
        paths.push(`/erp/api/attachments/airtable/${file}`)
      }
      if (paths.length === atts.length) out.set(`${rec.id}::${name}`, paths.join(', '))
    }
  }
  return out
}

// Noms de champs Airtable susceptibles de porter des pièces jointes image, parmi
// les colonnes qu'on s'apprête à écrire. On détecte sur la FORME de la valeur
// plutôt que sur le type déclaré : le webhook n'a pas les métadonnées Airtable,
// et un lookup d'attachment n'est pas typé `multipleAttachments`.
function imageFieldNames(writable, records) {
  const names = new Set()
  for (const rec of records || []) {
    for (const f of writable) {
      if (names.has(f.airtableFieldName)) continue
      if (imageAttachmentsOf(rec.fields?.[f.airtableFieldName]).length) names.add(f.airtableFieldName)
    }
  }
  return [...names]
}

// ── Live table column lookup ────────────────────────────────────────────────

function liveColumns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name))
}

// Colonnes NOT NULL : la sync dynamique ne doit jamais y écrire — `convertValue`
// peut produire null pour un champ Airtable vide, ce qui violerait la contrainte
// et ferait rollback toute la transaction. Cf. incident projects.name de mai 2026
// où une def dynamique « Projet → name » écrasait la valeur posée par le sync
// hardcodé dès que le field_map_projects était vide.
function notNullColumns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().filter(c => c.notnull === 1).map(c => c.name))
}

// ── Main: sync all fields for a module ──────────────────────────────────────

/**
 * Colonnes ERP appartenant au handler de sync hardcodé, déduites des CLÉS du
 * field_map du module. Une def dynamique qui viserait l'une d'elles l'écraserait
 * (souvent avec NULL) juste après que le handler hardcodé l'ait écrite.
 *
 * Les clés du field_map sont des clés LOGIQUES, qui ne portent pas toujours le
 * suffixe `_id` de la colonne FK correspondante : `company` → `company_id`,
 * `contact` → `contact_id`, `project` → `project_id`… Sans l'alias, la def native
 * `projects.company_id` (« Entreprise » — un libellé interne, pas un champ
 * Airtable) passait le filtre et remettait `company_id = NULL` sur chaque record
 * synchronisé : tous les projets se déliaient de leur entreprise alors même que
 * la map `company: "Client final"` était correcte.
 */
function hardcodedErpColumns(hardcodedFieldMap) {
  const cols = new Set()
  for (const key of Object.keys(hardcodedFieldMap || {})) {
    cols.add(key)
    if (!key.endsWith('_id')) cols.add(`${key}_id`)
  }
  return cols
}

/**
 * Sync ALL Airtable fields (not just hardcoded ones) for a given module.
 * Call this AFTER the regular sync has already handled the known fields.
 *
 * @param {string} module - e.g. 'billets', 'achats'
 * @param {string} erpTable - e.g. 'tickets', 'purchases'
 * @param {string} airtableBaseId
 * @param {string} airtableTableId
 * @param {Object} hardcodedFieldMap - the existing field_map (to skip already-mapped fields)
 * @param {Array} records - Airtable records (already fetched by the regular sync)
 */
export async function syncDynamicFields(module, erpTable, airtableBaseId, airtableTableId, hardcodedFieldMap, records) {
  let accessToken
  try { accessToken = await getAccessToken() } catch { return }

  // 1. Fetch table metadata from Airtable
  let tableFields
  try {
    const meta = await airtableFetch(`/meta/bases/${airtableBaseId}/tables`, accessToken)
    const table = (meta.tables || []).find(t => t.id === airtableTableId)
    if (!table) { console.log(`⚠️  Table ${airtableTableId} not found in Airtable metadata`); return }
    tableFields = table.fields || []
  } catch (e) {
    console.error(`❌ Airtable metadata fetch failed: ${e.message}`)
    return
  }

  // 2. Determine which fields are NOT in the hardcoded map
  const mappedAirtableFields = new Set(Object.values(hardcodedFieldMap || {}).filter(v => typeof v === 'string'))
  // Colonnes ERP gérées par la sync hardcodée — interdire qu'une def dynamique
  // pointe vers la même colonne sous un autre nom Airtable, sinon elle écrase
  // (ex : ancien champ Airtable "Coût unitaire" vs nouveau "Coût unitaire (FIFO)"
  // tous deux mappés vers products.unit_cost).
  const mappedErpColumns = hardcodedErpColumns(hardcodedFieldMap)
  const existingCols = liveColumns(erpTable)
  const existingDefs = db.prepare(
    'SELECT * FROM airtable_field_mappings WHERE erp_table=?'
  ).all(erpTable)
  const defsByAtId = new Map(existingDefs.map(d => [d.airtable_field_id, d]))
  const defsByName = new Map(existingDefs.map(d => [d.airtable_field_name, d]))
  // IDs de champs qui existent réellement dans Airtable — sert à reconnaître les
  // mappings orphelins (cf. `twinDefs`).
  const realFieldIds = new Set(tableFields.map(f => f.id))

  // Tous les mappings qui pointent vers `atField`, pas seulement le « gagnant ».
  //
  // Les tables importées de longue date traînent des colonnes legacy créées par
  // le webhook, dont l'`airtable_field_id` est synthétique (`webhook_<colonne>`)
  // et qu'un mapping issu des métadonnées a plus tard doublonnées (`image` vs
  // `image_2`…). Historiquement un seul mapping était alimenté et la colonne
  // perdante gardait éternellement sa dernière valeur importée. Sur une colonne
  // image c'est visible : l'URL d'attachment Airtable expire en quelques heures,
  // donc le tableau finissait par n'afficher qu'un lien mort.
  //
  // On n'accepte comme jumeau qu'un mapping de MÊME NOM dont l'`airtable_field_id`
  // n'existe pas dans la base Airtable (orphelin) — jamais un mapping rattaché à
  // un autre vrai champ.
  const twinDefs = (atField) => existingDefs.filter(d =>
    d.airtable_field_id === atField.id ||
    (d.airtable_field_name === atField.name && !realFieldIds.has(d.airtable_field_id))
  )

  let updatedFields = 0
  const dynamicFieldMap = [] // { airtableFieldName, columnName, fieldType }
  const claimedColumns = new Set() // une colonne ERP n'est écrite qu'une fois par UPDATE

  for (const atField of tableFields) {
    // Skip fields already handled by hardcoded map
    if (mappedAirtableFields.has(atField.name)) continue

    const mapped = mapAirtableType(atField)
    const existingDef = defsByAtId.get(atField.id) || defsByName.get(atField.name)

    // No def → field is unknown to the ERP; we no longer auto-create columns
    // for new Airtable fields, so simply skip.
    if (!existingDef) continue

    // Placeholder (`__pending__`) defs created via the sync modale never had
    // a real column attached — without auto-creation we just skip them.
    if (existingDef.column_name === '__pending__') continue

    // Update mapping metadata (nom du champ Airtable) sur le mapping existant.
    // Le field_type/options de RENDU vit désormais dans custom_fields et n'est
    // plus jamais réécrit par le sync entrant (changement de comportement
    // volontaire — un renommage/retype côté Airtable ne doit plus surprendre un
    // utilisateur qui a configuré le rendu ERP à la main). `mapped.field_type`/
    // `mapped.options`, dérivés à chaque passage des métadonnées Airtable
    // live, servent uniquement à convertir la VALEUR ci-dessous.
    if (existingDef.airtable_field_name !== atField.name) {
      db.prepare(
        "UPDATE airtable_field_mappings SET airtable_field_name=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?"
      ).run(atField.name, existingDef.id)
      updatedFields++
    }

    for (const def of twinDefs(atField)) {
      if (def.import_disabled === 1) continue
      if (def.column_name === '__pending__') continue
      // Defensive: if the column was dropped manually, skip rather than crash.
      if (!existingCols.has(def.column_name)) continue
      // Sens 'push' (ERP → Airtable seulement) : la valeur Airtable n'est plus
      // importée — la vérité vit dans l'ERP (cf. airtable_field_directions).
      if (dynamicFieldDirection(writebackModuleForTable(erpTable), def.column_name) === 'push') continue
      // Si une autre def Airtable mappe vers une colonne ERP gérée par le hardcoded
      // map, on l'ignore : sinon elle écraserait la valeur écrite par la sync
      // hardcodée (souvent avec NULL, quand l'ancien champ Airtable a été remplacé).
      if (mappedErpColumns.has(def.column_name)) continue
      if (claimedColumns.has(def.column_name)) continue
      claimedColumns.add(def.column_name)

      // `link_target_table` (résolution des liens Airtable→ERP) est une config de
      // MAPPING persistée sur airtable_field_mappings.options par la modale de
      // mapping (routes/connectors.js) — indépendante des options de rendu
      // dérivées ici des métadonnées Airtable (choices, precision, etc.).
      let mappingOptions = {}
      try { mappingOptions = JSON.parse(def.options || '{}') } catch {}
      dynamicFieldMap.push({
        airtableFieldName: atField.name,
        columnName: def.column_name,
        fieldType: mapped.field_type,
        options: { ...mapped.options, link_target_table: mappingOptions.link_target_table || null },
      })
    }
  }

  // 3. Populate dynamic fields for all records (skip frozen + NOT NULL columns)
  const frozen = getFrozenColumns(erpTable)
  const notNull = notNullColumns(erpTable)
  const writable = dynamicFieldMap.filter(f => !frozen.has(f.columnName) && !notNull.has(f.columnName))
  if (writable.length > 0 && records.length > 0) {
    // Les téléchargements se font AVANT la transaction (better-sqlite3 est
    // synchrone : aucun await ne peut vivre à l'intérieur).
    const mirrored = await mirrorImageAttachments(records, imageFieldNames(writable, records))

    const updateStmt = writable.map(f => `${f.columnName}=?`).join(', ')
    const stmt = db.prepare(
      `UPDATE ${erpTable} SET ${updateStmt} WHERE airtable_id=?`
    )

    const populated = db.transaction((recs) => {
      let count = 0
      for (const rec of recs) {
        const values = writable.map(f => mirrored.get(`${rec.id}::${f.airtableFieldName}`)
          ?? convertValue(rec.fields[f.airtableFieldName], f.fieldType, f.options))
        const result = stmt.run(...values, rec.id)
        if (result.changes > 0) count++
      }
      return count
    })(records)
    if (populated > 0) console.log(`🔄 ${module}: ${populated} records enrichis avec champs dynamiques`)
  }

  if (updatedFields > 0) console.log(`🔄 ${module}: ${updatedFields} types de champs mis à jour`)
}

/**
 * Lightweight dynamic field update for webhook records.
 * Uses existing airtable_field_defs only — no schema mutation, no new defs.
 * Fields seen in webhook payloads but unknown to airtable_field_defs are ignored.
 */
export async function updateDynamicFields(erpTable, hardcodedFieldMap, records) {
  if (!records?.length) return

  // Le field_type/options de rendu vit désormais dans custom_fields (fusion
  // avec l'ex-airtable_field_defs) — JOIN pour la conversion de valeur.
  const defs = db.prepare(`
    SELECT m.*, cf.type AS render_type, cf.options AS render_options
    FROM airtable_field_mappings m
    LEFT JOIN custom_fields cf ON cf.erp_table = m.erp_table AND cf.column_name = m.column_name AND cf.deleted_at IS NULL
    WHERE m.erp_table=?
  `).all(erpTable)
  const mappedFields = new Set(Object.values(hardcodedFieldMap || {}).filter(v => typeof v === 'string'))
  // Voir syncDynamicFields pour la motivation : deux noms de champs Airtable
  // ne doivent pas se disputer la même colonne ERP.
  const mappedErpColumns = hardcodedErpColumns(hardcodedFieldMap)
  const existingCols = liveColumns(erpTable)

  // Build dynamic field list from existing defs only, en filtrant les champs
  // désactivés via la modale de sync, ceux gérés par le handler hardcodé
  // (sinon une def dynamique préexistante peut écraser ce que le sync
  // hardcodé a écrit — ex. products.image_url qui se faisait remplacer par
  // l'URL Airtable temporaire), les placeholders __pending__ et les defs
  // dont la colonne a été supprimée manuellement.
  const dynamicFields = []
  const wbModule = writebackModuleForTable(erpTable)
  for (const d of defs) {
    if (d.import_disabled === 1) continue
    if (mappedFields.has(d.airtable_field_name)) continue
    if (mappedErpColumns.has(d.column_name)) continue
    if (d.column_name === '__pending__') continue
    if (!existingCols.has(d.column_name)) continue
    // Sens 'push' : export seulement — le webhook entrant n'écrase pas la valeur ERP.
    if (dynamicFieldDirection(wbModule, d.column_name) === 'push') continue
    // `d.options` (colonne propre à airtable_field_mappings) porte link_target_table
    // — config de résolution du sync ; `d.render_options` (custom_fields.options)
    // porte les choices/format de rendu. On fusionne les deux pour convertValue.
    // Un champ lien Airtable migre vers custom_fields.type='text' (voir migration
    // schema.js — 'link' n'est pas un type de rendu sélectionnable) : la présence
    // de link_target_table est donc le seul signal fiable qu'il faut prendre le
    // chemin de résolution 'link' de convertValue plutôt que le rendu texte.
    let mappingOptions = {}
    try { mappingOptions = JSON.parse(d.options || '{}') } catch {}
    let renderOptions = {}
    try { renderOptions = JSON.parse(d.render_options || '{}') } catch {}
    const isLink = !!mappingOptions.link_target_table
    dynamicFields.push({
      airtableFieldName: d.airtable_field_name,
      columnName: d.column_name,
      fieldType: isLink ? 'link' : (d.render_type || 'text'),
      // `format` du mapping (dérivé du type Airtable — 'percent', 'currency'…)
      // en repli du format de rendu : sans lui, le chemin webhook stockait la
      // fraction brute d'un champ pourcentage là où le sync complet, qui lit les
      // métadonnées Airtable live, la convertissait en points (cf. convertValue).
      options: {
        format: mappingOptions.format,
        ...renderOptions,
        link_target_table: mappingOptions.link_target_table || null,
      },
    })
  }

  if (!dynamicFields.length) return

  const frozen = getFrozenColumns(erpTable)
  const notNull = notNullColumns(erpTable)
  const writable = dynamicFields.filter(f => !frozen.has(f.columnName) && !notNull.has(f.columnName))
  if (!writable.length) return

  // Idem syncDynamicFields : miroir local des pièces jointes image avant la
  // transaction, sinon le webhook réécrirait une URL Airtable déjà périmée.
  const mirrored = await mirrorImageAttachments(records, imageFieldNames(writable, records))

  const updateStmt = writable.map(f => `${f.columnName}=?`).join(', ')
  const stmt = db.prepare(`UPDATE ${erpTable} SET ${updateStmt} WHERE airtable_id=?`)

  const count = db.transaction((recs) => {
    let n = 0
    for (const rec of recs) {
      const values = writable.map(f => mirrored.get(`${rec.id}::${f.airtableFieldName}`)
        ?? convertValue(rec.fields[f.airtableFieldName], f.fieldType, f.options))
      const result = stmt.run(...values, rec.id)
      if (result.changes > 0) n++
    }
    return n
  })(records)

  if (count > 0) console.log(`🔄 ${erpTable}: ${count} records enrichis (webhook)`)
}

/**
 * Register native (hardcoded) fields in airtable_field_mappings so they
 * appear in fieldRuleEngine's column whitelist (templates) alongside dynamic
 * Airtable fields. Ces defs 'native_*' ne migrent jamais vers custom_fields
 * (bruit inutile dans l'UI « champs custom ») — voir plan de fusion.
 * Runs at startup — idempotent (INSERT OR IGNORE).
 */
export function ensureNativeFieldDefs(definitions) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO airtable_field_mappings (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, sort_order)
     VALUES (?,?,?,?,?,?,?)`
  )
  // Le type ERP déclaré ici est la SEULE source de vérité côté serveur pour une
  // colonne native : airtable_field_mappings n'a pas de colonne field_type, et
  // custom_fields n'a de ligne que pour les colonnes déjà adoptées. Sans lui,
  // /champs/:table voyait toute colonne native comme du texte et son picker de
  // mapping n'offrait aucun champ Airtable numérique/date/select compatible
  // (« Aucun champ compat. » sur Probabilité, Valeur (CAD), Date de clôture…).
  // On le persiste donc dans les options de la def native, en FUSIONNANT : ces
  // options portent aussi `format` (conversion des pourcentages côté webhook)
  // et `link_target_table`, qu'un écrasement ferait disparaître.
  const readStmt = db.prepare(
    'SELECT id, airtable_field_id, options FROM airtable_field_mappings WHERE erp_table=? AND column_name=?'
  )
  const optsStmt = db.prepare(
    "UPDATE airtable_field_mappings SET options=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?"
  )
  let count = 0
  for (const def of definitions) {
    const result = stmt.run(
      uuid(), def.module, def.erp_table, `native_${def.column_name}`,
      def.label, def.column_name,
      def.sort_order ?? -(1000 - count)
    )
    if (result.changes > 0) count++

    const row = readStmt.get(def.erp_table, def.column_name)
    // La def a pu devenir un VRAI mapping Airtable depuis (l'utilisateur a
    // choisi un champ pour cette colonne) : ses options ne nous appartiennent
    // plus.
    if (!row || !String(row.airtable_field_id || '').startsWith('native_')) continue
    let opts = {}
    try { opts = JSON.parse(row.options || '{}') } catch { opts = {} }
    const next = { ...opts, ...(def.options || {}), native_field_type: def.field_type || 'text' }
    if (JSON.stringify(next) !== JSON.stringify(opts)) optsStmt.run(JSON.stringify(next), row.id)
  }
  if (count > 0) console.log(`📋 ${count} native field(s) registered in airtable_field_mappings`)
}
