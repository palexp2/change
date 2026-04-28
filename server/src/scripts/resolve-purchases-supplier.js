// Tente de résoudre le fournisseur (texte libre) d'un record `purchases` et de
// le lier à une entreprise (table `companies`) via `purchases.supplier_company_id`.
//
// Stratégie de match :
//   1. Nom normalisé (accents retirés, ponctuation et suffixes « inc », « ltée »,
//      « ltd », etc. strippés, casse ignorée).
//   2. Si plusieurs candidats → privilégier ceux de type='Fournisseur'.
//   3. Si toujours ambigu → laissé non résolu et reporté.
//
// Usage :
//   node server/src/scripts/resolve-purchases-supplier.js                  # dry run
//   node server/src/scripts/resolve-purchases-supplier.js --apply          # écrit en DB
//   node server/src/scripts/resolve-purchases-supplier.js --apply --create-missing
//     crée les entreprises manquantes (type=Fournisseur) et les lie
//   node server/src/scripts/resolve-purchases-supplier.js --all
//     retente aussi les records déjà liés (réécriture si meilleure correspondance)

import { randomUUID } from 'crypto'
import db from '../db/database.js'

const args = new Set(process.argv.slice(2))
const APPLY = args.has('--apply')
const CREATE_MISSING = args.has('--create-missing')
const ALL = args.has('--all')

// Sécurité : la colonne est créée dans schema.js, mais le script peut être lancé
// avant un restart du serveur.
try { db.exec('ALTER TABLE purchases ADD COLUMN supplier_company_id TEXT REFERENCES companies(id)') } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_purchases_supplier_company ON purchases(supplier_company_id)') } catch {}

function normalizeName(name) {
  if (!name) return ''
  return String(name)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.,'"&()/\\-]/g, ' ')
    .replace(/\b(inc|incorporated|ltd|ltee|limited|llc|corp|corporation|co|sa|sarl|gmbh|enr)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Score de "poids" par company = nombre de liens entrants connus. Sert de tie-break
// quand plusieurs entreprises partagent le même nom normalisé (doublons dans companies).
const refCount = new Map()
const refQueries = [
  'SELECT company_id AS id, COUNT(*) AS n FROM contacts WHERE company_id IS NOT NULL GROUP BY company_id',
  'SELECT company_id AS id, COUNT(*) AS n FROM projects WHERE company_id IS NOT NULL GROUP BY company_id',
  'SELECT company_id AS id, COUNT(*) AS n FROM orders WHERE company_id IS NOT NULL GROUP BY company_id',
  'SELECT vendor_id AS id, COUNT(*) AS n FROM achats_fournisseurs WHERE vendor_id IS NOT NULL GROUP BY vendor_id',
]
for (const sql of refQueries) {
  try {
    for (const r of db.prepare(sql).all()) {
      refCount.set(r.id, (refCount.get(r.id) || 0) + r.n)
    }
  } catch {}
}

const companies = db.prepare('SELECT id, name, type FROM companies').all()
const byNormalized = new Map()
for (const c of companies) {
  const key = normalizeName(c.name)
  if (!key) continue
  if (!byNormalized.has(key)) byNormalized.set(key, [])
  byNormalized.get(key).push(c)
}

function pickBest(candidates, rawName) {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]

  const fournisseurs = candidates.filter(c => c.type === 'Fournisseur')
  const pool = fournisseurs.length > 0 ? fournisseurs : candidates

  const rawLower = rawName.trim().toLowerCase()
  const exact = pool.filter(c => c.name === rawName)
  if (exact.length === 1) return exact[0]
  const caseInsensitive = pool.filter(c => c.name.toLowerCase() === rawLower)
  if (caseInsensitive.length === 1) return caseInsensitive[0]

  // Tie-break final : le plus référencé (le plus susceptible d'être le record canonique)
  const ranked = [...pool].sort((a, b) => (refCount.get(b.id) || 0) - (refCount.get(a.id) || 0))
  const topScore = refCount.get(ranked[0].id) || 0
  const tied = ranked.filter(c => (refCount.get(c.id) || 0) === topScore)
  if (tied.length === 1) return tied[0]
  return null
}

const where = ALL
  ? "(supplier IS NOT NULL AND TRIM(supplier) != '') OR (fournisseur IS NOT NULL AND TRIM(fournisseur) != '')"
  : "supplier_company_id IS NULL AND ((supplier IS NOT NULL AND TRIM(supplier) != '') OR (fournisseur IS NOT NULL AND TRIM(fournisseur) != ''))"

const rows = db.prepare(`
  SELECT id, supplier, fournisseur, supplier_company_id
  FROM purchases
  WHERE ${where}
`).all()

const fournCount = companies.filter(c => c.type === 'Fournisseur').length
console.log(`📋 ${rows.length} achat(s) à traiter (${ALL ? 'TOUS' : 'non liés'})`)
console.log(`   ${companies.length} entreprise(s) indexée(s), dont ${fournCount} fournisseur(s)`)
console.log(`   Mode: ${APPLY ? 'APPLY (écriture DB)' : 'DRY RUN (lecture seule)'}${CREATE_MISSING ? ' + création des manquants' : ''}\n`)

const stats = { matched: 0, alreadyLinked: 0, ambiguous: 0, unmatched: 0, created: 0, skipped: 0 }
const unmatched = new Map()
const ambiguousMap = new Map()

const update = db.prepare('UPDATE purchases SET supplier_company_id=?, updated_at=datetime(\'now\') WHERE id=?')
const insertCompany = db.prepare(
  "INSERT INTO companies (id, name, type, created_at, updated_at) VALUES (?, ?, 'Fournisseur', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
)

const run = db.transaction(() => {
  for (const row of rows) {
    const rawName = (row.supplier || row.fournisseur || '').trim()
    if (!rawName) { stats.skipped++; continue }

    const key = normalizeName(rawName)
    if (!key) { stats.skipped++; continue }

    const candidates = byNormalized.get(key) || []
    const picked = pickBest(candidates, rawName)

    if (picked) {
      if (row.supplier_company_id === picked.id) {
        stats.alreadyLinked++
        continue
      }
      if (APPLY) update.run(picked.id, row.id)
      stats.matched++
    } else if (candidates.length > 1) {
      stats.ambiguous++
      ambiguousMap.set(rawName, (ambiguousMap.get(rawName) || 0) + 1)
    } else {
      if (CREATE_MISSING && APPLY) {
        const newId = randomUUID()
        insertCompany.run(newId, rawName)
        update.run(newId, row.id)
        byNormalized.set(key, [{ id: newId, name: rawName, type: 'Fournisseur' }])
        stats.created++
      } else {
        stats.unmatched++
        unmatched.set(rawName, (unmatched.get(rawName) || 0) + 1)
      }
    }
  }
})

run()

console.log('━━ Résultat ━━')
console.log(`✅ Liés        : ${stats.matched}`)
console.log(`= Déjà liés   : ${stats.alreadyLinked}`)
console.log(`➕ Créés      : ${stats.created}`)
console.log(`⚠  Ambigus    : ${stats.ambiguous}`)
console.log(`✗ Non résolus: ${stats.unmatched}`)
console.log(`· Ignorés    : ${stats.skipped}`)

if (unmatched.size > 0) {
  console.log(`\nFournisseurs non résolus (${unmatched.size} uniques, top 20):`)
  const sorted = [...unmatched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  for (const [name, n] of sorted) console.log(`  ${String(n).padStart(4)}× ${name}`)
}

if (ambiguousMap.size > 0) {
  console.log(`\nFournisseurs ambigus :`)
  for (const [name, n] of ambiguousMap) {
    const cands = byNormalized.get(normalizeName(name)) || []
    console.log(`  ${n}× ${name} → ${cands.map(c => `${c.name} [${c.type || '—'}]`).join(' | ')}`)
  }
}

if (!APPLY && (stats.matched > 0 || unmatched.size > 0)) {
  console.log(`\n💡 Dry run — relancer avec --apply pour écrire en DB${unmatched.size > 0 ? ' (ajouter --create-missing pour créer les fournisseurs manquants)' : ''}.`)
}

process.exit(0)
