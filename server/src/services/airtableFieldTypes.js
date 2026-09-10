/**
 * Type Airtable d'un champ — et la seule question qui en découle vraiment :
 * « Airtable acceptera-t-il qu'on ÉCRIVE dedans ? »
 *
 * Un champ FORMULE est calculé par Airtable. Un PATCH dessus renvoie 422 :
 * peu importe le sens réglé dans Boréal, la valeur ne partira jamais. Même
 * chose pour rollup, lookup, count, autoNumber, « créé le / modifié par »,
 * bouton et source de sync externe. Le sélecteur de sens de /champs/:table ne
 * doit donc pas proposer « Bidirectionnel » ni « Boréal → Airtable » sur ces
 * champs, et le write-back ne doit pas les inclure dans son payload.
 *
 * Le type est connu à chaque lecture des métadonnées Airtable, mais cette
 * lecture est asynchrone et réseau. Les chemins qui ont besoin de la réponse
 * (sélecteur de sens, garde d'enregistrement, construction du payload) sont
 * synchrones et parfois dans des boucles par enregistrement — d'où ce cache
 * persisté (table `airtable_field_types`, migration 043) rafraîchi par tous
 * ceux qui passent déjà par `/meta/bases/:id/tables`.
 *
 * Cache et non source de vérité : un champ inconnu du cache ne bloque rien.
 */
import db from '../db/database.js'

// Types de champs Airtable calculés par Airtable → lecture seule pour nous.
// Même liste que COMPUTED_AT_TYPES (services/airtableMirrorRegistry.js) et que
// l'ancien AIRTABLE_READONLY_TYPES de routes/connectors.js, qui l'importe
// désormais d'ici : une seule définition, pour que la garde de mapping, la
// garde de sens et le write-back ne puissent pas diverger.
export const AIRTABLE_READONLY_TYPES = new Set([
  'formula', 'rollup', 'count', 'autoNumber', 'lookup', 'multipleLookupValues',
  'createdTime', 'lastModifiedTime', 'createdBy', 'lastModifiedBy',
  'button', 'externalSyncSource', 'aiText',
])

export function isComputedAirtableType(type) {
  return !!type && AIRTABLE_READONLY_TYPES.has(type)
}

// Mémo par (base, table) des noms de champs calculés. Les appelants sont dans
// des boucles par enregistrement (sync dynamique) : une requête SQL par champ
// et par record serait gratuite en résultat et chère en temps. Invalidé dès
// qu'une passe de métadonnées réécrit les types.
const computedCache = new Map()   // `${baseId}|${tableId}` → { names:Set, at:number }
const CACHE_TTL_MS = 60_000

function cacheKey(baseId, tableId) { return `${baseId}|${tableId}` }

/**
 * Enregistre les types des champs d'une table Airtable, tels que renvoyés par
 * `/meta/bases/:id/tables` (`fields: [{ id, name, type }]`). Appelé par tout
 * chemin qui lit déjà ces métadonnées — c'est ce qui garde le cache frais sans
 * un seul appel réseau supplémentaire. Best-effort : un échec ne doit jamais
 * faire tomber la page ou la passe de sync qui l'appelle.
 */
export function rememberAirtableFieldTypes(baseId, tableId, fields) {
  if (!baseId || !tableId || !Array.isArray(fields) || !fields.length) return 0
  try {
    const stmt = db.prepare(`
      INSERT INTO airtable_field_types (base_id, table_id, field_name, field_id, field_type, updated_at)
      VALUES (?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(base_id, table_id, field_name) DO UPDATE SET
        field_id   = excluded.field_id,
        field_type = excluded.field_type,
        updated_at = excluded.updated_at
    `)
    const write = db.transaction(rows => {
      for (const f of rows) {
        if (!f?.name || !f?.type) continue
        stmt.run(baseId, tableId, f.name, f.id || null, f.type)
      }
    })
    write(fields)
    computedCache.delete(cacheKey(baseId, tableId))
    return fields.length
  } catch { return 0 }   // table absente (tests) : le cache reste simplement vide
}

/** Type Airtable connu d'un champ, ou null s'il n'a jamais été observé. */
export function airtableFieldType(baseId, tableId, fieldName) {
  if (!baseId || !tableId || !fieldName) return null
  try {
    return db.prepare(
      'SELECT field_type FROM airtable_field_types WHERE base_id=? AND table_id=? AND field_name=?'
    ).get(baseId, tableId, fieldName)?.field_type || null
  } catch { return null }
}

/** Noms des champs CALCULÉS d'une table Airtable (vide si rien n'est connu). */
export function computedAirtableFieldNames(baseId, tableId) {
  if (!baseId || !tableId) return new Set()
  const key = cacheKey(baseId, tableId)
  const hit = computedCache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.names
  let names = new Set()
  try {
    const placeholders = [...AIRTABLE_READONLY_TYPES].map(() => '?').join(',')
    names = new Set(db.prepare(
      `SELECT field_name FROM airtable_field_types
       WHERE base_id=? AND table_id=? AND field_type IN (${placeholders})`
    ).all(baseId, tableId, ...AIRTABLE_READONLY_TYPES).map(r => r.field_name))
  } catch { names = new Set() }
  computedCache.set(key, { names, at: Date.now() })
  return names
}
