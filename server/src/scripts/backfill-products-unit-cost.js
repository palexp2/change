#!/usr/bin/env node
// One-shot: restaure products.unit_cost à partir d'une liste figée extraite
// d'Airtable, pour les produits dont la sync a vidé le coût unitaire à NULL.
//
// Contexte : la def dynamique `airtable_field_defs` mappait l'ancien champ
// Airtable "Coût unitaire" → products.unit_cost, et écrasait avec NULL la
// valeur correcte écrite par le sync hardcodé (qui lit le nouveau champ
// "Coût unitaire (FIFO)"). Le code de sync a été corrigé (airtableAutoSync.js)
// pour ne plus laisser deux noms Airtable se disputer la même colonne ERP.
// Ce script :
//   1. désactive la def `airtable_field_defs` en conflit ("Coût unitaire"
//      → unit_cost) pour que la collision ne se reproduise pas même si on
//      revient en arrière sur la patch code ;
//   2. réécrit les unit_cost manquants à partir de la liste figée.
//
// Usage :
//   node src/scripts/backfill-products-unit-cost.js            # dry run
//   node src/scripts/backfill-products-unit-cost.js --apply    # execute

import Database from 'better-sqlite3'

const DB_PATH = process.env.DB_PATH || './data/erp.db'
const APPLY = process.argv.includes('--apply')

// (sku, name, target_unit_cost) — extrait du diff Airtable ↔ ERP du 2026-05-21.
// Liste résolue par matching des produits ERP active=1, type non OBSOL,
// stock_qty != 0, unit_cost NULL/0 contre l'export Airtable du même jour.
const TARGETS = [
  ['1192', "MOSFET N-CH 50V 500MA SOT23", 0.25],
  ['1145', "CONN HDR 40POS 0.1 TIN PCB", 2.01],
  ['1411', "PCB BME280", 4.14],
  ['1321', "LORA1276-C1 100mW", 7.5],
  ['1107', "Raspberry Pi 4 2GB", 99.51],
  ['1130', "Plug 5,08 mm 3 connecteurs", 1.48],
  ['1305', "M3-0,5 x 6 mm Pan Head", 0.07],
  ['1153', "CBL ASSY RP-SMA-UMCC 3po", 3.91],
  ['1363', "WP13-18-5G - network plastic box", 22.49],
  ['1368', "Polyamide Cable Gland M20 mm", 0.81],
  ['1264', "Fan 5VDC", 5.4],
  ['1347', "Autocollant devant du contrôleur central", 2.14],
  ['1462', "PCB Module switch", 10.62],
  ['1356', "Plastic Adhesive Standoff M3 (commande pack 100)", 0.62],
  ['1076', "Sun shield", 20.96],
  ['1477', 'Cable Tie Long Lasting, Polypropylene Plastic, Narrow, 4" Long', 0.12],
  ['1310', "O-Ring 2 mm Wide, 5 mm ID", 0.15],
  ['1319', "RPi4 Model B Power Supplies Raspberry Pi", 8.64],
  ['1078', "Ceramique Temp. & hum. sensor shell", 9.72],
  ['1274', "CRYSTAL 32.7680KHZ 12.5PF SMD", 0.66],
  ['1198', "ATMEGA 328p", 3.58],
  ['1369', "BMP1520P - Plastic Mounting Plate", 4.97],
  ['1202', "IC RTC CLK/CALENDAR I2C 8SO", 1.24],
  ['1086', "CR2032 Lithium Coin Cell 3V", 1.02],
  ['1253', "SWITCH TOGGLE SPDT ON-ON", 2.31],
  ['1464', "10.5mm O.D. Rubber Cable Gland Plugs", 0.56],
  ['1224', "RES SMD 10K OHM 1% 1/8W 0805", 0.01],
  ['1465', "Wifi Dongle PAU03", 27.28],
  ['1300', "Capteur de pluie RG-15", 128.14],
  ['1089', "Gorilla tape (pied linéaire)", 2.27],
  ['1256', "MALE FEMALE THREADED STANDOFF", 0.56],
  ['1259', "HEAT SHRINK 1/4 IN X (pied linéaire)", 1.98],
  ['1358', "BMP1315P - Plastic Mounting Plate", 9.26],
  ['1389', "M3-0.5 x 10 mm PAN HEAD", 0.05],
  ['1016', "Sonde T&H BME280", 14.27],
  ['1324', "PCB simple LoRa-Pi", 0.7],
  ['1144', "U.FL Connector Jack, Male Pin 50 Ohm", 0.38],
  ['1337', "Mèche en coton (en mètre) 1/4 in", 0.58],
  ['1339', "Fil 22 AWG 4 cond. non blindé (pied)", 0.25],
  ['1114', "CAP CER 0.1UF 50V X7R 0805", 0.02],
  ['1110', "SDCIT2 - 16 GB - microSDHC", 40.42],
  ['1277', "RF ANT 916MHZ WHIP TILT RP-SMA", 17.78],
  ['1115', "CAP CER 10UF 16V X5R 0805", 0.02],
  ['1359', "BCPC091207-S", 18.11],
  ['1270', "BATT HOLDER COIN 20MM 1 CELL SMD", 1.42],
  ['1279', "HEAT SINK KIT FOR RASPBERRY PI 4", 1.53],
  ['1390', "PCB LoRa-Pi avec antenne externe", 17.81],
]

const db = new Database(DB_PATH)

console.log(`DB: ${DB_PATH}`)
console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`)

// 1. Désactiver la def airtable_field_defs en conflit (Coût unitaire → unit_cost).
const conflictDef = db.prepare(
  `SELECT id, airtable_field_name, column_name, import_disabled
   FROM airtable_field_defs
   WHERE erp_table = 'products' AND column_name = 'unit_cost'`
).all()

console.log(`\nDefs airtable_field_defs ciblant products.unit_cost : ${conflictDef.length}`)
for (const d of conflictDef) {
  console.log(`  - ${d.airtable_field_name} (id=${d.id}, import_disabled=${d.import_disabled})`)
}

// 2. Identifier les UPDATE à faire — résoudre chaque target SKU dans la DB.
const findStmt = db.prepare(`SELECT id, sku, name_fr, unit_cost, stock_qty FROM products WHERE sku = ?`)
const plan = []
const skipped = []
for (const [sku, name, targetCost] of TARGETS) {
  const row = findStmt.get(sku)
  if (!row) { skipped.push({ sku, name, reason: 'product not found' }); continue }
  if (targetCost <= 0) { skipped.push({ sku: row.sku, name: row.name_fr, reason: 'target cost is 0' }); continue }
  if (row.unit_cost && row.unit_cost > 0) {
    skipped.push({ sku: row.sku, name: row.name_fr, reason: `already has cost ${row.unit_cost}` })
    continue
  }
  plan.push({ id: row.id, sku: row.sku, name: row.name_fr, current: row.unit_cost, target: targetCost, stock: row.stock_qty })
}

console.log(`\nProduits à mettre à jour : ${plan.length}`)
console.log(`Sautés : ${skipped.length}`)
if (skipped.length) {
  console.log('\nDétail des sautés :')
  for (const s of skipped) console.log(`  - sku=${s.sku} "${s.name?.slice(0, 50)}" → ${s.reason}`)
}

console.log('\nÀ appliquer :')
let recoveredValue = 0
for (const p of plan) {
  recoveredValue += p.target * (p.stock || 0)
  console.log(`  sku=${p.sku} ${p.name?.slice(0, 50)} | ${p.current ?? 'NULL'} → ${p.target} (stock=${p.stock})`)
}
console.log(`\nValeur d'inventaire récupérée : ${recoveredValue.toFixed(2)} $`)

if (!APPLY) {
  console.log('\nDry run terminé. Relance avec --apply pour exécuter.')
  process.exit(0)
}

const updateProduct = db.prepare(
  `UPDATE products SET unit_cost = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE id = ?`
)
const disableDef = db.prepare(
  `UPDATE airtable_field_defs SET import_disabled = 1, updated_at = datetime('now') WHERE id = ?`
)

const tx = db.transaction(() => {
  let updated = 0
  for (const p of plan) {
    const res = updateProduct.run(p.target, p.id)
    if (res.changes) updated++
  }
  let disabled = 0
  for (const d of conflictDef) {
    if (d.import_disabled !== 1) {
      const res = disableDef.run(d.id)
      if (res.changes) disabled++
    }
  }
  return { updated, disabled }
})

const { updated, disabled } = tx()
console.log(`\n✅ Produits mis à jour : ${updated}`)
console.log(`✅ Defs airtable désactivées : ${disabled}`)
