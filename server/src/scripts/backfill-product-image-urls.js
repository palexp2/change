// Repare les products.image_url qui pointent vers une URL Airtable temporaire
// (https://v5.airtableusercontent.com/...) quand le fichier local correspondant
// existe deja dans uploads/products/<airtable_id>.<ext>.
//
// Cause : updateDynamicFields ecrasait image_url (def dynamique pour le champ
// AT "Image") avec l'URL temporaire Airtable, malgre le handler hardcode qui
// telechargeait deja l'image localement. Corrige dans airtableAutoSync.js.
//
// Usage : node src/scripts/backfill-product-image-urls.js
//         node src/scripts/backfill-product-image-urls.js --dry-run

import fs from 'fs'
import path from 'path'
import db from '../db/database.js'

const dryRun = process.argv.includes('--dry-run')
const uploadsDir = path.resolve(
  process.cwd(),
  process.env.UPLOADS_PATH || 'uploads',
  'products'
)

const stuck = db.prepare(`
  SELECT id, name_fr, airtable_id
  FROM products
  WHERE image_url LIKE 'https://v5.airtableusercontent.com%'
`).all()

console.log(`${stuck.length} produits avec URL Airtable temporaire`)

const files = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : []
const byRec = new Map()
for (const f of files) {
  const rec = f.split('.')[0]
  if (!byRec.has(rec)) byRec.set(rec, f)
}

let fixed = 0
let missing = 0
const update = db.prepare('UPDATE products SET image_url=? WHERE id=?')

for (const p of stuck) {
  const file = byRec.get(p.airtable_id)
  if (!file) {
    missing++
    console.log(`  ⚠️  pas de fichier local pour ${p.airtable_id} (${p.name_fr})`)
    continue
  }
  const newUrl = `/erp/api/product-images/${file}`
  if (!dryRun) update.run(newUrl, p.id)
  fixed++
}

console.log(`${dryRun ? '[dry-run] ' : ''}corriges: ${fixed}, sans fichier local: ${missing}`)
