#!/usr/bin/env node
/**
 * mirror-audit.js — auditeur du miroir Airtable ↔ Boréal. LECTURE SEULE.
 *
 * Répond à la question à laquelle rien ne répond aujourd'hui dans l'app :
 * « le miroir est-il exact ? ». Pour chaque table mirroirée, compare Airtable et
 * l'ERP record par record, champ par champ, et classe chaque écart :
 *
 *   missing_in_erp     record présent dans Airtable, absent de l'ERP
 *   orphan_in_erp      record de l'ERP dont l'airtable_id n'existe plus côté Airtable
 *   value_divergence   champ mappé dont les deux côtés ne disent pas la même chose
 *   unmapped_field     champ Airtable sans aucune décision de mapping
 *   orphan_mapping     mapping pointant vers un champ Airtable qui n'existe plus
 *
 * La comparaison de valeur ne devine rien : elle rejoue `convertValue()` du sync
 * (services/airtableAutoSync.js) sur la valeur Airtable, et compare le résultat à
 * ce qui est stocké. Un écart signalé est donc bien « le sync écrirait autre chose
 * que ce qu'il y a », pas une différence de représentation.
 *
 * Aucune écriture sur les tables ERP. Seule écriture possible du process : le
 * refresh du token OAuth Airtable (connector_oauth), fait par le connecteur.
 *
 * Usage
 *   node src/scripts/mirror-audit.js                        # toutes les tables
 *   node src/scripts/mirror-audit.js --mirror=orders,envois # seulement celles-là
 *   node src/scripts/mirror-audit.js --no-values            # structure seulement (rapide)
 *   node src/scripts/mirror-audit.js --max-examples=5       # exemples par écart (défaut 3)
 *   node src/scripts/mirror-audit.js --out=/chemin/rapport.json
 *
 * Sortie : résumé lisible sur stdout + rapport JSON complet
 * (défaut : uploads/audits/mirror-audit-<horodatage>.json, plus un lien
 * mirror-audit-latest.json). Le rapport est le point de comparaison avant/après
 * de chaque palier du chantier miroir.
 */

import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import db from '../db/database.js'
import { getAccessToken, airtableFetch } from '../connectors/airtable.js'
import { convertValue } from '../services/airtableAutoSync.js'
// Le registre du miroir est la source UNIQUE de la description et de la
// classification. L'auditeur ne redéfinit rien : s'il portait sa propre copie
// de `classifyFields`, les deux dériveraient et l'audit finirait par décrire un
// miroir qui n'est pas celui que le sync alimente.
import {
  MIRROR_SEED,
  classifyFields,
  resolveLegacyConfig,
  parseFieldMap,
  hasImageAttachments,
  COMPUTED_AT_TYPES,
  syncMirrorRegistry,
  registryCounters,
} from '../services/airtableMirrorRegistry.js'

// ── Accès base (lecture seule) ──────────────────────────────────────────────

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
}

// ── Métadonnées Airtable ────────────────────────────────────────────────────

const baseSchemaCache = new Map()

async function baseSchema(baseId, token) {
  if (baseSchemaCache.has(baseId)) return baseSchemaCache.get(baseId)
  const data = await airtableFetch(`/meta/bases/${baseId}/tables`, token)
  const byId = new Map()
  for (const t of data.tables || []) byId.set(t.id, t)
  baseSchemaCache.set(baseId, byId)
  return byId
}

// Pacing volontaire : Airtable plafonne à 5 requêtes/seconde et par base. Sur un
// passage complet (~800 requêtes) le throttle coûte ~3 min et évite de dépenser
// le quota du sync de production en 429/backoff.
const PACE_MS = 220
let lastCall = 0
async function paced(fn) {
  const wait = PACE_MS - (Date.now() - lastCall)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastCall = Date.now()
  return fn()
}

async function fetchAllRecords(baseId, tableId, token, onProgress) {
  const records = []
  let offset = null
  do {
    const params = new URLSearchParams({ pageSize: '100' })
    if (offset) params.set('offset', offset)
    const data = await paced(() => airtableFetch(`/${baseId}/${tableId}?${params}`, token))
    records.push(...(data.records || []))
    offset = data.offset || null
    if (onProgress) onProgress(records.length)
  } while (offset)
  return records
}

// ── Arguments ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { mirrors: null, values: true, maxExamples: 3, out: null, refreshRegistry: true }
  for (const a of argv) {
    if (a === '--no-values') opts.values = false
    else if (a.startsWith('--mirror=')) opts.mirrors = a.slice(9).split(',').map(s => s.trim()).filter(Boolean)
    else if (a.startsWith('--max-examples=')) opts.maxExamples = Math.max(0, parseInt(a.slice(15), 10) || 0)
    else if (a.startsWith('--out=')) opts.out = a.slice(6)
    else if (a === '--no-registry-refresh') opts.refreshRegistry = false
    else if (a === '--help' || a === '-h') { opts.help = true }
    else console.warn(`⚠️  argument ignoré : ${a}`)
  }
  return opts
}

// ── Comparaison de valeurs ──────────────────────────────────────────────────

function normStored(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (Buffer.isBuffer(v)) return v.toString('utf8')
  const s = String(v).trim()
  return s === '' ? null : s
}

const ISO_DATE_RE = /^(\d{4}-\d{2}-\d{2})/

// `expected` sort de convertValue() — c'est littéralement ce que le sync
// écrirait. `stored` est la valeur en base. Les seules tolérances admises sont
// celles qui ne cachent aucune perte d'information.
function sameValue(expected, stored) {
  const a = normStored(expected)
  const b = normStored(stored)
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  if (a === b) return true

  // Numérique : tolérance de flottant uniquement.
  const na = typeof a === 'number' ? a : (a !== '' && !Number.isNaN(Number(a)) ? Number(a) : NaN)
  const nb = typeof b === 'number' ? b : (b !== '' && !Number.isNaN(Number(b)) ? Number(b) : NaN)
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return Math.abs(na - nb) < 1e-6

  const sa = String(a)
  const sb = String(b)

  // Dates : une colonne peut porter la date seule là où le sync écrit l'ISO complet.
  const da = sa.match(ISO_DATE_RE)
  const dbb = sb.match(ISO_DATE_RE)
  if (da && dbb) {
    if (sa === sb) return true
    // Même instant écrit différemment (avec/sans millisecondes, décalage).
    const ta = Date.parse(sa)
    const tb = Date.parse(sb)
    if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta === tb
    return da[1] === dbb[1]
  }

  // multi_select : convertValue sérialise un tableau JSON ; l'ordre ne porte
  // aucune information côté Airtable.
  if (sa.startsWith('[') && sb.startsWith('[')) {
    try {
      const pa = JSON.parse(sa)
      const pb = JSON.parse(sb)
      if (Array.isArray(pa) && Array.isArray(pb)) {
        if (pa.length !== pb.length) return false
        const ka = [...pa].map(String).sort()
        const kb = [...pb].map(String).sort()
        return ka.every((x, i) => x === kb[i])
      }
    } catch {}
  }

  return false
}

function truncate(v, n = 120) {
  if (v === null || v === undefined) return null
  const s = String(v)
  return s.length > n ? `${s.slice(0, n)}…` : s
}

// ── Audit d'un miroir ───────────────────────────────────────────────────────

async function auditMirror(mirror, token, opts) {
  const out = {
    id: mirror.id,
    erp_table: mirror.erpTable,
    sync: mirror.sync,
    status: 'ok',
    errors: [],
  }

  const cfg = resolveLegacyConfig(mirror)
  if (!cfg?.baseId || !cfg?.tableId) {
    out.status = 'unconfigured'
    out.errors.push('base_id ou table_id absent de la configuration')
    return out
  }
  out.base_id = cfg.baseId
  out.table_id = cfg.tableId
  out.last_synced_at = cfg.lastSyncedAt || null

  if (!tableExists(mirror.erpTable)) {
    out.status = 'error'
    out.errors.push(`table ERP « ${mirror.erpTable} » absente`)
    return out
  }

  const fieldMap = parseFieldMap(cfg.fieldMapRaw)

  // Métadonnées de la table Airtable.
  let atTable
  try {
    const schema = await baseSchema(cfg.baseId, token)
    atTable = schema.get(cfg.tableId)
  } catch (e) {
    out.status = 'error'
    out.errors.push(`métadonnées Airtable : ${e.message}`)
    return out
  }
  if (!atTable) {
    out.status = 'error'
    out.errors.push(`table_id ${cfg.tableId} introuvable dans la base ${cfg.baseId}`)
    return out
  }
  out.airtable_name = atTable.name
  out.airtable_field_count = atTable.fields.length

  // Classification des champs.
  const { fields, orphanMappings, coreKeyCount } = classifyFields(mirror, atTable, fieldMap)
  out.core_key_count = coreKeyCount
  out.orphan_mappings = orphanMappings
  out.field_states = fields.reduce((acc, f) => { acc[f.state] = (acc[f.state] || 0) + 1; return acc }, {})
  // Champs alimentés par le sync mais dont on ne peut pas vérifier la valeur.
  out.core_uncomparable = fields.filter(f => f.state === 'core').length
  out.unmapped_fields = fields.filter(f => f.state === 'unmapped').map(f => ({ field: f.field, airtable_type: f.airtable_type }))
  out.incomparable_fields = fields
    .filter(f => !f.comparable && f.state !== 'unmapped')
    .map(f => ({ field: f.field, erp_column: f.erp_column, state: f.state, role: f.role, reason: f.reason || null }))

  // Records Airtable.
  let records
  try {
    records = await fetchAllRecords(cfg.baseId, cfg.tableId, token,
      n => process.stderr.write(`\r   ${mirror.id}: ${n} records lus…   `))
    process.stderr.write('\r' + ' '.repeat(48) + '\r')
  } catch (e) {
    out.status = 'error'
    out.errors.push(`lecture des records : ${e.message}`)
    return out
  }
  out.airtable_records = records.length

  // Reclassement après lecture des records : un champ image ne se reconnaît qu'à
  // ses valeurs (un lookup de pièce jointe a le type `multipleLookupValues`).
  // C'est aussi ainsi que le sync procède — `imageFieldNames(writable, records)`.
  for (const f of fields) {
    if (!f.comparable) continue
    if (!records.some(r => hasImageAttachments(r.fields?.[f.field]))) continue
    f.comparable = false
    f.reason = 'pièce jointe image — miroir local'
    out.incomparable_fields.push({ field: f.field, erp_column: f.erp_column, state: f.state, reason: f.reason })
  }

  // Records ERP indexés par airtable_id.
  const comparable = fields.filter(f => f.comparable && f.erp_column)
  const selectCols = [...new Set(['airtable_id', ...comparable.map(f => f.erp_column)])]
  const erpRows = db.prepare(
    `SELECT ${selectCols.map(c => `"${c}"`).join(', ')} FROM ${mirror.erpTable} WHERE airtable_id IS NOT NULL`
  ).all()
  const erpTotal = db.prepare(`SELECT COUNT(*) AS n FROM ${mirror.erpTable}`).get().n
  out.erp_records = erpTotal
  out.erp_records_with_airtable_id = erpRows.length

  const erpById = new Map()
  for (const r of erpRows) erpById.set(r.airtable_id, r)

  const atIds = new Set(records.map(r => r.id))
  out.missing_in_erp = records.filter(r => !erpById.has(r.id)).map(r => r.id)
  out.orphan_in_erp = erpRows.filter(r => !atIds.has(r.airtable_id)).map(r => r.airtable_id)

  // Comparaison champ par champ.
  if (!opts.values || !comparable.length) {
    out.values_compared = false
    return out
  }
  out.values_compared = true
  out.compared_field_count = comparable.length

  const perField = new Map()
  for (const f of comparable) {
    perField.set(f.field, {
      field: f.field,
      erp_column: f.erp_column,
      airtable_type: f.airtable_type,
      state: f.state,
      computed: COMPUTED_AT_TYPES.has(f.airtable_type),
      divergences: 0,
      examples: [],
    })
  }

  let recordsWithDivergence = 0
  for (const rec of records) {
    const erpRow = erpById.get(rec.id)
    if (!erpRow) continue
    let dirty = false
    for (const f of comparable) {
      let expected
      try { expected = convertValue(rec.fields[f.field], f.field_type, f.options) }
      catch (e) {
        const bucket = perField.get(f.field)
        if (!bucket.convert_error) bucket.convert_error = e.message
        continue
      }
      if (sameValue(expected, erpRow[f.erp_column])) continue
      dirty = true
      const bucket = perField.get(f.field)
      bucket.divergences++
      if (bucket.examples.length < opts.maxExamples) {
        bucket.examples.push({ airtable_id: rec.id, airtable: truncate(expected), erp: truncate(erpRow[f.erp_column]) })
      }
    }
    if (dirty) recordsWithDivergence++
  }

  out.records_with_divergence = recordsWithDivergence
  out.value_divergences = [...perField.values()]
    .filter(f => f.divergences > 0 || f.convert_error)
    .sort((a, b) => b.divergences - a.divergences)
  out.divergent_value_count = out.value_divergences.reduce((n, f) => n + f.divergences, 0)

  return out
}

// ── Rapport ─────────────────────────────────────────────────────────────────

function pad(s, n) { return String(s).padEnd(n) }
function lpad(s, n) { return String(s).padStart(n) }

function printSummary(report) {
  const rows = report.mirrors
  console.log('')
  console.log('═'.repeat(104))
  console.log(`AUDIT DU MIROIR AIRTABLE ↔ BORÉAL — ${report.generated_at}`)
  console.log(`${report.totals.mirrors} miroirs · valeurs comparées : ${report.options.values ? 'oui' : 'non'}`)
  console.log('═'.repeat(104))
  console.log('')
  console.log(pad('MIROIR', 17) + pad('TABLE ERP', 21) + lpad('RECORDS', 15) + lpad('MANQ.', 7) + lpad('ORPH.', 7) +
              lpad('CHAMPS', 10) + lpad('NON MAPPÉS', 12) + lpad('ÉCARTS', 9))
  console.log('─'.repeat(104))
  for (const m of rows) {
    if (m.status === 'unconfigured' || m.status === 'error') {
      console.log(pad(m.id, 17) + pad(m.erp_table, 21) + lpad(`⚠ ${m.status}`, 15) + '   ' + (m.errors[0] || ''))
      continue
    }
    const cmp = m.values_compared
    console.log(
      pad(m.id, 17) +
      pad(m.erp_table, 21) +
      lpad(`${m.airtable_records} / ${m.erp_records_with_airtable_id}`, 15) +
      lpad(m.missing_in_erp.length || '·', 7) +
      lpad(m.orphan_in_erp.length || '·', 7) +
      lpad(`${(m.field_states.mirrored || 0) + (m.field_states.core || 0)}/${m.airtable_field_count}`, 10) +
      lpad(m.unmapped_fields.length || '·', 12) +
      lpad(cmp ? (m.divergent_value_count || '·') : '—', 9)
    )
  }
  console.log('─'.repeat(104))
  const t = report.totals
  console.log(
    pad('TOTAL', 38) +
    lpad(`${t.airtable_records} / ${t.erp_records_with_airtable_id}`, 15) +
    lpad(t.missing_in_erp || '·', 7) +
    lpad(t.orphan_in_erp || '·', 7) +
    lpad(`${t.mapped_fields}/${t.airtable_fields}`, 10) +
    lpad(t.unmapped_fields || '·', 12) +
    lpad(report.options.values ? (t.divergent_values || '·') : '—', 9)
  )
  console.log('')
  console.log(`Colonnes  RECORDS = Airtable / ERP porteurs d'un airtable_id · MANQ. = absents de l'ERP`)
  console.log(`          ORPH. = présents dans l'ERP, disparus d'Airtable · CHAMPS = mappés / existants`)
  console.log(`          ÉCARTS = valeurs pour lesquelles le sync écrirait autre chose que ce qui est stocké`)
  console.log('')

  // Ce qui demande une décision : les chiffres qui doivent tomber à zéro.
  // Les compteurs du registre : la même réalité, mais persistée et donc
  // interrogeable hors de ce script (page d'audit, route d'admin).
  const reg = report.registry?.counters
  if (reg) {
    const m = reg.mirrors || {}
    const f = reg.fields || {}
    console.log('REGISTRE DU MIROIR')
    console.log(`  tables   ${lpad(m.mirrored || 0, 4)} mirroirées · ${lpad(m.paused || 0, 3)} en pause · ` +
                `${lpad(m.excluded || 0, 3)} exclues · ${lpad(m.undecided || 0, 3)} SANS DÉCISION`)
    console.log(`  champs   ${lpad(f.mirrored || 0, 4)} mirroirés · ${lpad(f.core || 0, 3)} en field_map cœur · ` +
                `${lpad(f.excluded || 0, 3)} exclus · ${lpad(f.unmapped || 0, 3)} SANS DÉCISION · ` +
                `${lpad(f.broken || 0, 3)} cassés`)
    console.log('')
  }

  console.log('À RAMENER À ZÉRO')
  console.log(`  ${lpad(t.unmapped_fields, 6)} champs Airtable sans décision de mapping`)
  console.log(`  ${lpad(t.core_keys, 6)} clés de field_map codées en dur (invisibles dans l'app)`)
  console.log(`  ${lpad(t.core_uncomparable, 6)} champs alimentés par le field_map cœur, donc NON auditables (transformation dans le code)`)
  console.log(`  ${lpad(t.orphan_mappings, 6)} mappings pointant vers un champ Airtable inexistant`)
  console.log(`  ${lpad(t.missing_in_erp, 6)} records Airtable jamais importés`)
  console.log(`  ${lpad(t.orphan_in_erp, 6)} records ERP dont le jumeau Airtable a disparu`)
  if (report.options.values) {
    console.log(`  ${lpad(t.divergent_values, 6)} valeurs divergentes (dont ${t.divergent_values_computed} sur des champs calculés Airtable)`)
  }
  console.log('')

  // Les pires écarts de valeur, pour savoir où creuser.
  const worst = []
  for (const m of rows) for (const f of m.value_divergences || []) worst.push({ mirror: m.id, ...f })
  worst.sort((a, b) => b.divergences - a.divergences)
  if (worst.length) {
    console.log('PLUS GROS ÉCARTS DE VALEUR')
    for (const w of worst.slice(0, 15)) {
      const tag = w.computed ? ' [calculé Airtable]' : ''
      console.log(`  ${lpad(w.divergences, 7)}  ${pad(w.mirror, 16)} ${pad(w.erp_column, 26)} ← « ${w.field} »${tag}`)
      const ex = w.examples[0]
      if (ex) console.log(`           ${' '.repeat(16)} airtable=${JSON.stringify(ex.airtable)}  erp=${JSON.stringify(ex.erp)}`)
    }
    console.log('')
  }
}

// ── Entrée ──────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log('Usage: node src/scripts/mirror-audit.js [--mirror=a,b] [--no-values] [--max-examples=N]')
    console.log('                                         [--no-registry-refresh] [--out=fichier]')
    process.exit(0)
  }

  const selected = opts.mirrors
    ? MIRROR_SEED.filter(m => opts.mirrors.includes(m.id) || opts.mirrors.includes(m.erpTable))
    : MIRROR_SEED
  if (!selected.length) {
    console.error(`Aucun miroir ne correspond à --mirror=${opts.mirrors?.join(',')}`)
    console.error(`Miroirs connus : ${MIRROR_SEED.map(m => m.id).join(', ')}`)
    process.exit(1)
  }

  let token
  try { token = await getAccessToken() }
  catch (e) { console.error(`❌ Token Airtable : ${e.message}`); process.exit(1) }

  // Le registre est rafraîchi AVANT l'audit : auditer contre une description
  // périmée donnerait un rapport juste sur un miroir qui n'existe plus.
  // `--no-registry-refresh` pour auditer exactement l'état enregistré.
  let registry = null
  if (opts.refreshRegistry) {
    try {
      process.stderr.write('→ rafraîchissement du registre du miroir\n')
      registry = await syncMirrorRegistry({ token })
    } catch (e) {
      console.error(`⚠️  Registre non rafraîchi (${e.message}) — audit poursuivi sur l'état enregistré`)
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    options: { values: opts.values, mirrors: opts.mirrors, maxExamples: opts.maxExamples },
    mirrors: [],
  }

  for (const m of selected) {
    process.stderr.write(`→ ${m.id}\n`)
    try {
      report.mirrors.push(await auditMirror(m, token, opts))
    } catch (e) {
      report.mirrors.push({ id: m.id, erp_table: m.erpTable, status: 'error', errors: [e.message] })
      console.error(`   ❌ ${m.id}: ${e.message}`)
    }
  }

  const t = {
    mirrors: report.mirrors.length,
    airtable_records: 0, erp_records: 0, erp_records_with_airtable_id: 0,
    missing_in_erp: 0, orphan_in_erp: 0,
    airtable_fields: 0, mapped_fields: 0, unmapped_fields: 0,
    core_keys: 0, core_uncomparable: 0, orphan_mappings: 0,
    divergent_values: 0, divergent_values_computed: 0,
    records_with_divergence: 0,
  }
  for (const m of report.mirrors) {
    t.airtable_records += m.airtable_records || 0
    t.erp_records += m.erp_records || 0
    t.erp_records_with_airtable_id += m.erp_records_with_airtable_id || 0
    t.missing_in_erp += m.missing_in_erp?.length || 0
    t.orphan_in_erp += m.orphan_in_erp?.length || 0
    t.airtable_fields += m.airtable_field_count || 0
    t.mapped_fields += (m.field_states?.mirrored || 0) + (m.field_states?.core || 0)
    t.unmapped_fields += m.unmapped_fields?.length || 0
    t.core_keys += m.core_key_count || 0
    t.core_uncomparable += m.core_uncomparable || 0
    t.orphan_mappings += m.orphan_mappings?.length || 0
    t.records_with_divergence += m.records_with_divergence || 0
    for (const f of m.value_divergences || []) {
      t.divergent_values += f.divergences
      if (f.computed) t.divergent_values_computed += f.divergences
    }
  }
  report.totals = t
  report.registry = { refresh: registry, counters: registryCounters() }

  printSummary(report)

  // Le registre porte désormais le résultat du dernier audit : c'est ce que la
  // page d'audit (palier 4) affichera, et ça évite de relire un fichier JSON
  // pour savoir où en est chaque table.
  if (tableExists('airtable_mirrors')) {
    const stmt = db.prepare(`
      UPDATE airtable_mirrors
      SET last_audited_at = ?, audit_divergences = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `)
    db.transaction(() => {
      for (const m of report.mirrors) {
        if (m.status === 'unconfigured' || m.status === 'error') continue
        const divergences = (m.missing_in_erp?.length || 0)
          + (m.orphan_in_erp?.length || 0)
          + (m.divergent_value_count || 0)
        stmt.run(report.generated_at, divergences, m.id)
      }
    })()
  }

  const stamp = report.generated_at.replace(/[:.]/g, '-')
  // `path.resolve` et non `path.join` : UPLOADS_PATH peut être absolu (essais à
  // blanc sur une copie de la base), et un join le concatènerait derrière le cwd.
  const outPath = opts.out || path.join(
    path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads'),
    'audits', `mirror-audit-${stamp}.json`)
  await mkdir(path.dirname(outPath), { recursive: true })
  await writeFile(outPath, JSON.stringify(report, null, 2))
  if (!opts.out) {
    await writeFile(path.join(path.dirname(outPath), 'mirror-audit-latest.json'), JSON.stringify(report, null, 2))
  }
  console.log(`Rapport complet : ${outPath}`)
  process.exit(0)
}

main()
