// Corrige le reçu CT Greenhouse INV-2813 (7c1655f7-c232-4667-9816-40399ab54d4d) :
// l'extraction IA avait lu correctement le montant total dû (1 548,20 $, escompte 10 %
// + transport inclus) dans raw_data, mais items/subtotal/total avaient ensuite été
// recalés à 1 648,00 $ (sous-total avant escompte) par un recalcul côté fiche qui ne
// connaissait pas l'escompte. Applique rétroactivement la répartition au prorata
// (reconcileDiscountFreightProrata, système « Pro rata transport » du fichier
// CTB - Suivi) sur les lignes déjà rattachées aux achats LIA.
//
// Usage : cd server && node src/scripts/fix-ct-greenhouse-2813-prorata.js

import db from '../db/database.js'
import { reconcileDiscountFreightProrata } from '../services/saleReceiptExtraction.js'

const ID = '7c1655f7-c232-4667-9816-40399ab54d4d'
const round2 = n => Math.round((Number(n) || 0) * 100) / 100

const row = db.prepare('SELECT * FROM sale_receipts WHERE id=?').get(ID)
if (!row) throw new Error(`Reçu ${ID} introuvable`)

const items = JSON.parse(row.items || '[]')
const raw = JSON.parse(row.raw_data || '{}')

const itemSum = round2(items.filter(it => it && it.total != null).reduce((s, it) => s + Number(it.total), 0))
const target = round2(Number(raw.total) || 0)
const discount = round2(itemSum - target)

console.log(`Sous-total actuel des lignes : ${itemSum} $ — total réel (raw_data) : ${target} $ — escompte à répartir : ${discount} $`)

const result = reconcileDiscountFreightProrata(items, { discount, freight: 0 })
if (!result) throw new Error('reconcileDiscountFreightProrata a renvoyé null — rien à corriger ?')

db.prepare(`
  UPDATE sale_receipts SET
    items=?, subtotal=?, total=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id=?
`).run(JSON.stringify(result.items), result.subtotal, target, ID)

console.log('Lignes corrigées :')
for (const it of result.items) console.log(`  ${it.description} : ${it.total} $`)
console.log(`Nouveau sous-total : ${result.subtotal} $ — total : ${target} $`)
