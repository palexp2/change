// Instantané de référence des champs — LECTURE SEULE.
//
// Parcourt toutes les tables de TABLE_COLUMN_META et enregistre, pour chacune,
// l'état résolu de ses champs tel que l'utilisateur le voit : libellé, type,
// ordre, et visibilité par vue (pills + vue « Tous »). Rejoué après un
// changement, le diff fait ressortir toute régression d'affichage — c'est le
// filet du chantier d'unification des champs (aucune écriture, la base de dev
// EST la base de prod).
//
//   node src/scripts/fields-snapshot.js > /tmp/avant.json
//   node src/scripts/fields-snapshot.js > /tmp/apres.json
//   diff <(jq -S . /tmp/avant.json) <(jq -S . /tmp/apres.json)
import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../..')
const dbPath = process.env.ERP_DB_PATH || path.join(repo, 'server/data/erp.db')
const db = new Database(dbPath, { readonly: true })

const { TABLE_COLUMN_META } = await import(
  path.join(repo, 'client/src/lib/tableDefs.js')
)

// Même table de correspondance que fieldOverrides.jsx (OVERRIDE_TO_COLUMN_TYPE).
const OVERRIDE_TO_COLUMN_TYPE = {
  text: 'text', number: 'number', currency: 'number',
  date: 'date', boolean: 'boolean', url: 'text', phone: 'text',
}

// Overrides des champs natifs. Après le palier 1 ils vivent dans custom_fields
// (kind='native') ; avant, dans field_overrides. On lit les deux pour que
// l'instantané soit comparable de part et d'autre de la migration.
function loadOverrides() {
  const byTable = new Map()
  const put = (t, fieldId, row) => {
    if (!byTable.has(t)) byTable.set(t, new Map())
    byTable.get(t).set(fieldId, row)
  }
  const tableExists = name => !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name)

  if (tableExists('field_overrides')) {
    for (const r of db.prepare(
      `SELECT erp_table, field_id, label, type, decimals, country_code, sort_order
       FROM field_overrides WHERE deleted_at IS NULL`
    ).all()) {
      put(r.erp_table, r.field_id, r)
    }
  }
  // `country_code` n'existe sur custom_fields qu'après le palier 1 : l'instantané
  // doit tourner des deux côtés de la migration.
  const cfHasCountry = db.pragma('table_info(custom_fields)').some(c => c.name === 'country_code')
  for (const r of db.prepare(
    `SELECT erp_table, column_name AS field_id, name AS label, type, decimals,
            ${cfHasCountry ? 'country_code' : 'NULL AS country_code'}, sort_order
     FROM custom_fields WHERE deleted_at IS NULL AND kind='native'`
  ).all()) {
    put(r.erp_table, r.field_id, { ...r, label: r.label || null, type: r.type || null })
  }
  return byTable
}

// Champs personnalisés actifs (hors natifs) — ceux que DataTable ajoute aux
// colonnes de la page.
function loadCustomFields() {
  const byTable = new Map()
  for (const r of db.prepare(
    `SELECT erp_table, column_name, name, type, kind, sort_order
     FROM custom_fields WHERE deleted_at IS NULL AND kind <> 'native'
     ORDER BY sort_order, created_at`
  ).all()) {
    if (!byTable.has(r.erp_table)) byTable.set(r.erp_table, [])
    byTable.get(r.erp_table).push(r)
  }
  return byTable
}

function loadViews() {
  const byTable = new Map()
  const add = (t, name, cols) => {
    if (!byTable.has(t)) byTable.set(t, {})
    byTable.get(t)[name] = cols
  }
  for (const r of db.prepare(
    `SELECT table_name, label, visible_columns FROM table_view_pills ORDER BY sort_order, label`
  ).all()) {
    let cols = []
    try { cols = JSON.parse(r.visible_columns || '[]') } catch { cols = ['<illisible>'] }
    add(r.table_name, `pill:${r.label}`, cols)
  }
  for (const r of db.prepare(
    `SELECT table_name, visible_columns FROM table_view_configs`
  ).all()) {
    let cols = []
    try { cols = JSON.parse(r.visible_columns || '[]') } catch { cols = ['<illisible>'] }
    add(r.table_name, 'vue:Tous', cols)
  }
  return byTable
}

// Reproduit applyFieldOverrides + applyFieldOrder (fieldOverrides.jsx).
function resolve(table, cols, overrides, customs) {
  const ov = overrides.get(table) || new Map()
  const merged = [
    ...cols.map(c => ({
      id: c.id ?? c.field,
      label: c.label,
      type: c.type || 'text',
      origine: 'natif',
      alwaysVisible: !!c.alwaysVisible,
    })),
    ...(customs.get(table) || [])
      .filter(f => !cols.some(c => (c.id ?? c.field) === f.column_name))
      .map(f => ({
        id: f.column_name,
        label: f.name,
        type: f.type || 'text',
        origine: f.kind === 'data' ? 'perso' : `perso:${f.kind}`,
        alwaysVisible: false,
      })),
  ]

  for (const c of merged) {
    const o = ov.get(c.id)
    if (!o) continue
    if (o.label) c.label = o.label
    if (o.type && o.type !== c.type) c.type = OVERRIDE_TO_COLUMN_TYPE[o.type] || 'text'
    if (o.decimals != null) c.decimales = o.decimals
    if (o.country_code) c.indicatif = o.country_code
  }

  const pinned = merged.filter(c => c.alwaysVisible)
  const orderable = merged.filter(c => !c.alwaysVisible)
  const hasOrder = [...ov.values()].some(o => o.sort_order != null)
  if (hasOrder) {
    orderable
      .map((c, i) => ({ c, so: ov.get(c.id)?.sort_order, i }))
      .sort((a, b) => {
        const ao = a.so != null, bo = b.so != null
        if (ao !== bo) return ao ? -1 : 1
        if (ao) return a.so - b.so || a.i - b.i
        return a.i - b.i
      })
      .forEach((k, rang) => { k.c._rang = rang })
    orderable.sort((a, b) => a._rang - b._rang)
  }
  return [...orderable, ...pinned].map(({ alwaysVisible, _rang, ...rest }) => rest)
}

const overrides = loadOverrides()
const customs = loadCustomFields()
const views = loadViews()

const out = {}
for (const table of Object.keys(TABLE_COLUMN_META).sort()) {
  out[table] = {
    champs: resolve(table, TABLE_COLUMN_META[table], overrides, customs),
    vues: views.get(table) || {},
  }
}
// Tables qui n'ont pas de définition native mais portent des champs perso.
for (const table of [...customs.keys()].sort()) {
  if (out[table]) continue
  out[table] = { champs: resolve(table, [], overrides, customs), vues: views.get(table) || {} }
}

process.stdout.write(JSON.stringify(out, null, 2) + '\n')
