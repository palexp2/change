#!/usr/bin/env node
// Import manuel du Registre des entreprises du Québec (REQ) dans le miroir
// local `req_entreprises`. Idempotent : upsert par NEQ, jamais de DELETE.
//
// Usage :
//   node server/src/scripts/import-req.js                  → télécharge depuis Données Québec
//   node server/src/scripts/import-req.js --zip <chemin>   → charge un ZIP déjà téléchargé
//   node server/src/scripts/import-req.js --csv <chemin>   → charge un seul CSV (format Entreprise)
//   node server/src/scripts/import-req.js --dry-run        → lit et compte sans rien écrire
//
// ⚠️ Le téléchargement automatique est aujourd'hui refusé (403 Cloudflare) sur
// les IP de ce serveur : passer par --zip après avoir récupéré le fichier
// depuis https://www.donneesquebec.ca/recherche/dataset/registre-des-entreprises
//
// La même passe tourne toute seule une fois par mois (automation système
// `sys_req_import`) — cf. services/reqImport.js.
import { readFileSync } from 'fs'
import '../db/schema.js'
import { runReqImport } from '../services/reqImport.js'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}

const zipPath = arg('--zip')
const csvPath = arg('--csv')
const apply = !process.argv.includes('--dry-run')

try {
  const out = await runReqImport({
    trigger: 'manuel',
    zipPath,
    csv: csvPath ? readFileSync(csvPath, 'utf8') : null,
    apply,
  })
  console.log(out.summary)
  console.log(`  source     : ${out.source.label}`)
  console.log(`  lues       : ${out.read}`)
  console.log(`  écrites    : ${out.written}`)
  console.log(`  ignorées   : ${out.skipped}`)
  console.log(`  durée      : ${(out.duration_ms / 1000).toFixed(1)} s`)
  process.exit(0)
} catch (e) {
  console.error(`❌ Import REQ impossible : ${e.message}`)
  process.exit(1)
}
