#!/usr/bin/env node
/**
 * mirror-double-run.js — la vérification obligatoire avant de basculer un
 * miroir vers le moteur unique (palier 3).
 *
 * Le contrat de la bascule est simple : le moteur doit écrire EXACTEMENT ce que
 * la fonction historique écrivait. Le prouver demande de faire tourner les deux
 * sur la MÊME donnée de départ, puis de comparer. Ce script enchaîne les quatre
 * étapes, qui étaient jusqu'ici tapées à la main à chaque module :
 *
 *   1. deux copies cohérentes de la base de production (snapshot SQLite, pas
 *      un `cp` — la base est en WAL, une copie brute peut être à moitié écrite)
 *   2. la fonction historique sur la copie A
 *   3. `syncMirror()` sur la copie B
 *   4. `mirror-table-diff.js` entre les deux
 *
 * Les deux syncs tournent dans des sous-processus : `db/database.js` ouvre UNE
 * base au chargement du module, donc un seul processus ne peut pas en viser
 * deux. C'est aussi ce qui garantit que rien de l'un ne fuit dans l'autre.
 *
 * La production n'est jamais touchée : elle est lue pour la copie, et le drapeau
 * `engine` n'est PAS modifié — la bascule reste un geste séparé
 * (`mirror-engine-switch.js`), à faire seulement si la sortie est verte.
 *
 * Usage
 *   node src/scripts/mirror-double-run.js --mirror=achats
 *   node src/scripts/mirror-double-run.js --mirror=achats --dir=/chemin --keep
 *
 * Sortie 0 = les deux tables sont équivalentes, la bascule est justifiable.
 */

import Database from 'better-sqlite3'
import { spawnSync } from 'child_process'
import { mkdirSync, rmSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROD_DB = path.join(__dirname, '../../data/erp.db')
// Hors de /tmp, qui est un tmpfs : deux copies de 500 Mo y tiendraient en RAM.
const DEFAULT_DIR = '/home/ec2-user/mirror-verify'

function parseArgs(argv) {
  const o = { mirror: null, dir: DEFAULT_DIR, keep: false, run: null, ignore: null }
  for (const a of argv) {
    if (a.startsWith('--mirror=')) o.mirror = a.slice(9)
    else if (a.startsWith('--dir=')) o.dir = a.slice(6)
    else if (a.startsWith('--ignore=')) o.ignore = a.slice(9)
    else if (a === '--keep') o.keep = true
    else if (a.startsWith('--run=')) o.run = a.slice(6) // usage interne
    else console.warn(`⚠️  argument ignoré : ${a}`)
  }
  return o
}

const opts = parseArgs(process.argv.slice(2))
if (!opts.mirror) {
  console.error('Usage: --mirror=<id> [--dir=<dossier>] [--keep] [--ignore=col,col]')
  process.exit(2)
}

// ── Mode interne : un des deux syncs, dans son propre processus ─────────────
//
// Le parent a posé DATABASE_PATH sur la copie ; l'import de database.js
// l'utilise. Le garde-fou vérifie qu'on ne vise pas la production par accident
// — ce serait un vrai sync, sur la vraie base, hors de tout contrôle.
if (opts.run) {
  const target = process.env.DATABASE_PATH || ''
  if (!target || path.resolve(target) === path.resolve(PROD_DB)) {
    console.error('❌ DATABASE_PATH doit pointer une COPIE, jamais la production')
    process.exit(2)
  }
  if (opts.run === 'legacy') {
    const { LEGACY_SYNCS } = await import('../services/airtable.js')
    const fn = LEGACY_SYNCS[opts.mirror]
    if (!fn) { console.error(`❌ aucune fonction historique pour « ${opts.mirror} »`); process.exit(2) }
    await fn(null)
  } else {
    const { syncMirror } = await import('../services/airtableMirrorEngine.js')
    const report = await syncMirror(opts.mirror, null)
    console.log(JSON.stringify(report))
  }
  process.exit(0)
}

// ── Orchestrateur ───────────────────────────────────────────────────────────

// La table ERP visée : c'est elle qu'on comparera.
const reg = new Database(PROD_DB, { readonly: true })
const mirror = reg.prepare('SELECT erp_table FROM airtable_mirrors WHERE id=?').get(opts.mirror)
reg.close()
if (!mirror) { console.error(`❌ miroir « ${opts.mirror} » absent du registre`); process.exit(2) }
const table = mirror.erp_table

mkdirSync(opts.dir, { recursive: true })
const A = path.join(opts.dir, `${opts.mirror}-legacy.db`)
const B = path.join(opts.dir, `${opts.mirror}-unified.db`)

// Les -wal/-shm d'une copie précédente rendent la base « malformed » : ils
// décrivent une autre histoire que le fichier qu'on vient d'écrire.
for (const f of [A, B]) for (const suffix of ['', '-wal', '-shm']) rmSync(f + suffix, { force: true })

console.log(`📋 Copie de la base (×2) → ${opts.dir}`)
const src = new Database(PROD_DB, { readonly: true })
await src.backup(A)
await src.backup(B)
src.close()

// Les copies sont des bacs à sable, mais le RÉSEAU, lui, est le vrai. Le sync
// des commandes appelle `reconcileFacturesForOrder`, qui publie une écriture de
// journal dans QuickBooks : sans cette neutralisation, un essai de bascule
// pourrait comptabiliser pour de bon. On retire donc le jeton QuickBooks des
// deux copies — la réconciliation échoue proprement, des deux côtés, et le
// jeton Airtable (indispensable au sync lui-même) reste en place.
for (const f of [A, B]) {
  const copy = new Database(f)
  const removed = copy.prepare("DELETE FROM connector_oauth WHERE connector='quickbooks'").run().changes
  copy.close()
  if (removed) console.log(`   ${path.basename(f)} : jeton QuickBooks retiré (${removed})`)
}

const node = process.execPath
const runOne = (which, dbFile) => {
  console.log(`\n▶️  ${which} → ${path.basename(dbFile)}`)
  const r = spawnSync(node, [fileURLToPath(import.meta.url), `--mirror=${opts.mirror}`, `--run=${which}`], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_PATH: dbFile },
  })
  if (r.status !== 0) { console.error(`❌ le sync ${which} a échoué (code ${r.status})`); process.exit(1) }
}
runOne('legacy', A)
runOne('unified', B)

console.log(`\n🔍 Comparaison de « ${table} »`)
const diffArgs = [path.join(__dirname, 'mirror-table-diff.js'), `--a=${A}`, `--b=${B}`, `--table=${table}`]
if (opts.ignore) diffArgs.push(`--ignore=${opts.ignore}`)
const diff = spawnSync(node, diffArgs, { stdio: 'inherit' })

if (!opts.keep) {
  for (const f of [A, B]) for (const suffix of ['', '-wal', '-shm']) rmSync(f + suffix, { force: true })
} else {
  console.log(`\n📁 Copies conservées : ${A} · ${B}`)
}

if (diff.status === 0) {
  console.log(`\n✅ Équivalence vérifiée — la bascule de « ${opts.mirror} » est justifiée :`)
  console.log(`   node src/scripts/mirror-engine-switch.js --mirror=${opts.mirror} --to=unified`)
}
process.exit(diff.status ?? 1)
