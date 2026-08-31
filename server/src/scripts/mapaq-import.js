// Import MAPAQ — rapport d'APERÇU des exploitations agricoles en serre.
//
// APERÇU UNIQUEMENT : ce script n'écrit jamais en base. Il télécharge (ou lit)
// le jeu de données, garde la catégorie « cultures en serre », filtre par région
// si la source expose une colonne région, puis rapproche chaque entrée des
// entreprises de l'ERP (deleted_at IS NULL) pour la classer en « nouvelle »,
// « doublon probable » ou « déjà existante ». La création des prospects se fait
// dans l'interface (Espace finance → Tests – Antoine), après validation.
//
// Usage :
//   node src/scripts/mapaq-import.js
//   node src/scripts/mapaq-import.js --region="Montérégie"
//   node src/scripts/mapaq-import.js --file=/chemin/exploitations.csv
//   node src/scripts/mapaq-import.js --dataset=<slug-ckan> --json
//
// Options :
//   --region=<nom>   filtre région (ignoré si la source n'a pas de colonne région)
//   --file=<chemin>  CSV local au lieu du portail Données Québec
//   --dataset=<slug> slug CKAN à interroger (défaut : MAPAQ_DATASET)
//   --limit=<n>      tronque la liste affichée
//   --json           sort le rapport brut en JSON
import fs from 'node:fs'
import { buildPreviewReport, CATEGORY_LABELS } from '../services/mapaqImport.js'

function parseArgs(argv) {
  const out = {}
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)(?:=(.*))?$/)
    if (m) out[m[1]] = m[2] === undefined ? true : m[2]
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

let csv = null
if (args.file) {
  if (!fs.existsSync(args.file)) {
    console.error(`Fichier introuvable : ${args.file}`)
    process.exit(1)
  }
  csv = fs.readFileSync(args.file, 'utf8')
}

const report = await buildPreviewReport({
  csv,
  region: args.region && args.region !== true ? args.region : null,
  dataset: args.dataset && args.dataset !== true ? args.dataset : null,
  limit: args.limit ? Number(args.limit) : null,
})

if (args.json) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n)

console.log('── Import MAPAQ — aperçu (aucune écriture en base) ──────────────')
console.log(`Source    : ${report.source.label}`)
if (report.source.url) console.log(`Ressource : ${report.source.url}`)
if (!report.source.available) {
  console.log(`Statut    : INDISPONIBLE`)
  console.log(`Raison    : ${report.source.reason}`)
  console.log('\nFournir le fichier avec --file=<chemin.csv> pour obtenir un aperçu.')
  process.exit(0)
}
console.log(`Région    : ${report.region || '(toutes)'}`)
console.log(`Colonnes  : ${JSON.stringify(report.columns)}`)
for (const w of report.warnings) console.log(`⚠️  ${w}`)
console.log('')
console.log(`Lignes source        : ${report.counts.total_source}`)
console.log(`Retenues (en serre)  : ${report.counts.greenhouse}`)
console.log(`  • nouvelles        : ${report.counts.nouvelle}`)
console.log(`  • doublons probables: ${report.counts.doublon}`)
console.log(`  • déjà existantes  : ${report.counts.existante}`)
console.log('')

if (report.entries.length) {
  console.log(`${pad('Catégorie', 20)} ${pad('Nom MAPAQ', 40)} ${pad('Ville', 20)} ${pad('Correspondance ERP', 40)} Score`)
  console.log('-'.repeat(130))
  for (const e of report.entries) {
    console.log(
      `${pad(CATEGORY_LABELS[e.category], 20)} ${pad(e.name, 40)} ${pad(e.city, 20)} `
      + `${pad(e.match_company_name || '—', 40)} ${e.match_score == null ? '—' : e.match_score + '%'}`,
    )
  }
}
console.log('\nAucune écriture effectuée. Valider les créations dans /tests-antoine.')
process.exit(0)
