// Réapplique la répartition au prorata (« Pro rata transport », fichier CTB - Suivi) à
// un reçu dont le transport/escompte avait été laissé par l'IA sur SA PROPRE LIGNE :
// la ligne de frais est sortie des articles, son montant réparti sur les pièces.
// Cas d'origine : Provo INV375790 (bormpPb79pGKNlsMN), « Coût d'expédition » 28,38 $.
//
// Usage : cd server && node src/scripts/fix-charge-line-prorata.js <id> [--dry]

import db from '../db/database.js'
import { extractChargeLines } from '../services/saleReceiptSingleItem.js'
import { reconcileDiscountFreightProrata, printedHtBase } from '../services/saleReceiptExtraction.js'

const id = process.argv[2]
const dry = process.argv.includes('--dry')
if (!id) throw new Error('Usage : node src/scripts/fix-charge-line-prorata.js <id> [--dry]')

const row = db.prepare('SELECT * FROM sale_receipts WHERE id=?').get(id)
if (!row) throw new Error(`Reçu ${id} introuvable`)
if (row.quickbooks_id) throw new Error(`Reçu ${id} déjà poussé dans QuickBooks (${row.quickbooks_id}) — correction manuelle`)

const items = JSON.parse(row.items || '[]')
const charges = extractChargeLines(items)
if (!charges) throw new Error('Aucune ligne de frais à sortir sur ce reçu')

const out = reconcileDiscountFreightProrata(charges.articles, {
  discount: charges.discount,
  freight: charges.freight,
  htBase: printedHtBase(row),
})
if (!out) throw new Error('Répartition refusée (garde-fou de la base hors taxes)')

console.log(`Transport ${charges.freight} $ / escompte ${charges.discount} $ répartis :`)
for (const it of out.items) console.log(`  ${it.description} : ${it.total} $`)
console.log(`Sous-total : ${row.subtotal} $ → ${out.subtotal} $ (total inchangé : ${row.total} $)`)

if (dry) process.exit(0)
db.prepare(`UPDATE sale_receipts SET items=?, subtotal=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
  .run(JSON.stringify(out.items), out.subtotal, id)
console.log('Reçu corrigé.')
