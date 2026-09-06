#!/usr/bin/env node
/**
 * mirror-table-diff.js — compare une table entre DEUX fichiers SQLite.
 *
 * À quoi ça sert. La bascule d'un miroir vers le moteur unique (palier 3) n'est
 * acceptable que si le moteur écrit EXACTEMENT ce que la fonction historique
 * écrivait. Le seul moyen de le prouver est de faire tourner les deux sur deux
 * copies de la même base, puis de comparer le résultat ligne par ligne. C'est ce
 * que fait ce script, et il servira à chacun des modules restants.
 *
 * Lecture seule sur les deux fichiers. À utiliser sur des COPIES : le script
 * refuse d'ouvrir data/erp.db, par sécurité.
 *
 * Usage
 *   node src/scripts/mirror-table-diff.js --a=/tmp/legacy.db --b=/tmp/unified.db \
 *        --table=assemblages [--ignore=updated_at,created_at] [--max=20]
 *
 * Colonnes ignorées par défaut : `updated_at` — l'écriture différentielle du
 * moteur ne touche pas une ligne inchangée, donc son horodatage diffère
 * légitimement de celui de l'ancienne fonction, qui réécrivait tout. C'est
 * précisément le gain qu'on cherche, pas un écart.
 *
 * Code de sortie : 0 si les tables sont équivalentes, 1 sinon — utilisable
 * comme garde dans un enchaînement.
 */

import Database from 'better-sqlite3'
import path from 'path'

function parseArgs(argv) {
  const o = { a: null, b: null, table: null, ignore: ['updated_at'], max: 20 }
  for (const arg of argv) {
    if (arg.startsWith('--a=')) o.a = arg.slice(4)
    else if (arg.startsWith('--b=')) o.b = arg.slice(4)
    else if (arg.startsWith('--table=')) o.table = arg.slice(8)
    else if (arg.startsWith('--ignore=')) o.ignore = arg.slice(9).split(',').map(s => s.trim()).filter(Boolean)
    else if (arg.startsWith('--max=')) o.max = parseInt(arg.slice(6), 10) || 20
    else console.warn(`⚠️  argument ignoré : ${arg}`)
  }
  return o
}

const opts = parseArgs(process.argv.slice(2))
if (!opts.a || !opts.b || !opts.table) {
  console.error('Usage: --a=<db> --b=<db> --table=<nom> [--ignore=col,col] [--max=N]')
  process.exit(2)
}

// Garde-fou : ce script est un outil de comparaison, jamais un outil de
// production. L'ouvrir sur la vraie base serait sans danger (lecture seule) mais
// signalerait une erreur de manipulation dans l'enchaînement.
for (const f of [opts.a, opts.b]) {
  if (path.resolve(f).endsWith('/data/erp.db')) {
    console.error(`❌ ${f} est la base de production — comparer des copies, pas l'original`)
    process.exit(2)
  }
}

const A = new Database(opts.a, { readonly: true })
const B = new Database(opts.b, { readonly: true })

const colsA = A.prepare(`PRAGMA table_info(${opts.table})`).all().map(c => c.name)
const colsB = B.prepare(`PRAGMA table_info(${opts.table})`).all().map(c => c.name)
const onlyA = colsA.filter(c => !colsB.includes(c))
const onlyB = colsB.filter(c => !colsA.includes(c))
if (onlyA.length || onlyB.length) {
  console.error(`❌ Colonnes différentes — seulement dans A : ${onlyA.join(', ') || '—'} · seulement dans B : ${onlyB.join(', ') || '—'}`)
  process.exit(1)
}

const ignore = new Set(opts.ignore)
const compared = colsA.filter(c => !ignore.has(c) && c !== 'id')
// `id` est un uuid tiré à l'insertion : deux exécutions indépendantes en
// produisent forcément deux différents. L'appariement se fait donc sur
// airtable_id, la seule identité stable de part et d'autre.
if (!colsA.includes('airtable_id')) {
  console.error(`❌ ${opts.table} n'a pas de colonne airtable_id — appariement impossible`)
  process.exit(2)
}

const load = (dbh) => {
  const rows = dbh.prepare(`SELECT ${['airtable_id', ...compared].map(c => `"${c}"`).join(', ')} FROM ${opts.table}`).all()
  const byKey = new Map()
  const noKey = []
  for (const r of rows) {
    if (r.airtable_id == null) { noKey.push(r); continue }
    byKey.set(r.airtable_id, r)
  }
  return { byKey, noKey, total: rows.length }
}

const a = load(A)
const b = load(B)

const norm = (v) => {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return v
  if (Buffer.isBuffer(v)) return v.toString('utf8')
  return String(v)
}
const same = (x, y) => {
  const nx = norm(x)
  const ny = norm(y)
  if (nx === null || ny === null) return nx === ny
  if (typeof nx === 'number' || typeof ny === 'number') {
    const a2 = Number(nx)
    const b2 = Number(ny)
    if (Number.isFinite(a2) && Number.isFinite(b2)) return a2 === b2
  }
  return String(nx) === String(ny)
}

const missingInB = []
const missingInA = []
const differing = []
const perColumn = new Map()

for (const [key, rowA] of a.byKey) {
  const rowB = b.byKey.get(key)
  if (!rowB) { missingInB.push(key); continue }
  const diffs = compared.filter(c => !same(rowA[c], rowB[c]))
  if (diffs.length) {
    differing.push({ key, diffs: diffs.map(c => ({ column: c, a: rowA[c], b: rowB[c] })) })
    for (const c of diffs) perColumn.set(c, (perColumn.get(c) || 0) + 1)
  }
}
for (const key of b.byKey.keys()) if (!a.byKey.has(key)) missingInA.push(key)

const trunc = (v) => {
  if (v === null || v === undefined) return 'null'
  const s = String(v)
  return s.length > 60 ? `${s.slice(0, 60)}…` : s
}

console.log('')
console.log(`Table « ${opts.table} »`)
console.log(`  A ${opts.a}  → ${a.total} lignes (${a.noKey.length} sans airtable_id)`)
console.log(`  B ${opts.b}  → ${b.total} lignes (${b.noKey.length} sans airtable_id)`)
console.log(`  ${compared.length} colonnes comparées, ignorées : ${[...ignore].join(', ') || '—'}`)
console.log('')

const equivalent = !missingInA.length && !missingInB.length && !differing.length
if (equivalent) {
  console.log(`✓ ÉQUIVALENTES — aucune différence sur ${a.byKey.size} records appariés`)
  process.exit(0)
}

if (missingInB.length) console.log(`✗ ${missingInB.length} record(s) présent(s) dans A et absent(s) de B : ${missingInB.slice(0, 5).join(', ')}`)
if (missingInA.length) console.log(`✗ ${missingInA.length} record(s) présent(s) dans B et absent(s) de A : ${missingInA.slice(0, 5).join(', ')}`)
if (differing.length) {
  console.log(`✗ ${differing.length} record(s) avec au moins une valeur différente`)
  console.log('')
  console.log('  Par colonne :')
  for (const [col, n] of [...perColumn].sort((x, y) => y[1] - x[1])) {
    console.log(`    ${String(n).padStart(6)}  ${col}`)
  }
  console.log('')
  console.log(`  Exemples (max ${opts.max}) :`)
  for (const d of differing.slice(0, opts.max)) {
    console.log(`    ${d.key}`)
    for (const x of d.diffs) console.log(`      ${x.column}: A=${trunc(x.a)}  B=${trunc(x.b)}`)
  }
}
process.exit(1)
