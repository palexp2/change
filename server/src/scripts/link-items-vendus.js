#!/usr/bin/env node
// One-shot: lie chaque ligne de stripe_invoice_items à un produit ERP.
// Crée les produits manquants en consolidant FR/EN, en regroupant les variantes
// quasi-identiques et en mettant les entrées junk dans des buckets dédiés.
//
// Usage :
//   node src/scripts/link-items-vendus.js              # dry run
//   node src/scripts/link-items-vendus.js --apply      # exécute

import Database from 'better-sqlite3'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.cwd(), process.env.DATABASE_PATH)
  : path.join(__dirname, '../../data/erp.db')

const APPLY = process.argv.includes('--apply')
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 10000')

// --------- Normalisation ---------
function extractName(raw) {
  if (!raw) return ''
  let s = String(raw).trim().replace(/\s+/g, ' ')
  // Préfixes "essai/trial" — extraire le produit sous-jacent
  s = s.replace(/^free trial for\s+\d+\s*[×xX]\s*/i, '')
  s = s.replace(/^free trial for\s+/i, '')
  s = s.replace(/^trial period for\s+/i, '')
  s = s.replace(/^période d'essai pour\s*/i, '') // \s* pour "pourService" sans espace
  // Préfixe quantité "N × " ou "N x "
  s = s.replace(/^\d+\s*[×xX]\s*/, '')
  // Suffixe prix "(at $X.XX / period)" ou "(à $X.XX/period)"
  s = s.replace(/\s*\((?:at|à)\s*\$[\d,]+(?:\.\d+)?\s*(?:\/\s*\w+)?\)\s*$/i, '')
  return s.trim()
}
const lower = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim()

// --------- Règles de mappage ---------
// Chaque règle: liste de noms (lowercase nettoyés) → produit cible {fr, en}
// existingSku: si fourni, force le mappage vers ce produit existant
const RULES = [
  // === Bucket umbrella : Greenhouse automation (variantes + junk non-test + dépôts + crédits) ===
  {
    fr: 'Automatisation de serre',
    en: 'Greenhouse automation',
    keys: [
      // Service umbrella variantes
      'greenhouse automation services',
      'greenhouse automation service',
      'greenhouse automation',
      "service d'automatisation de serre",
      "service d'automatisation orisha",
      'orisha automation service',
      "services d'automatisation",
      'service orisha',
      'service orisha (avec capteur de vent)',
      'orisha service',
      'orisha subscription',
      'abonnement au service orisha',
      "renouvellement d'abonnement au service orisha",
      'premier tech - service orisha',
      'way farms - greenhouse automation services',
      'greenhouse automation service - farm on central',
      'yearly greenhouse automation',
      'greenhouse automation services core package with roll-up motors included (6x)',
      'greenhouse automation for two roll-ups and a fan',
      'greenhouse temperature automation for two roll-ups (motors included)',
      "services d'automatisation de la serre (gestion température uniquement)",
      'greenhouse automation project',
      'greenhouse automation services - seed package',
      'seed package',
      'plan vision - 2 serres',
      'plan vision',
      'vision',
      'custom project automated energy screen',
      'orisha',
      'core',
      'core package',
      'orisha monitoring for one greenhouse',
      'orisha monitoring service',
      '6 steps to 15000',
      'orisha starter kit',
      'kit de démarrage - orisha 44$',
      'kit de démarrage - côtés ouvrants & toit',
      'greenhouse automation service - starter kit',
      'service orisha (à $380.00/year)',
      'service orisha (à $580.00/year)',
      'system purchase after 1 year',
      'greenhouse automation services - sunny nature',
      'greenhouse automation for two roll-up motors',
      'automatisation côtés ouvrants paiement annuel',
      'service d\'automatisation orisha', // au cas où
      // Junk non-TEST
      'subscription adjustment',
      'invoice 1518 - hidden gem farm',
      'paiement restant',
      'rabais - programme recyclage',
      'temps non utilisé sur premier tech - service orisha après le 11 dec 2023',
      'temps non utilisé sur premier tech - service orisha après le 20 jan 2024',
      'unused time on greenhouse automation after 02 may 2024',
      'remaining time on greenhouse automation after 02 may 2024',
      'basic',
      'produit assistant',
      'ajustement pour contrôleur central',
      // Dépôts (toutes variantes)
      'greenhouse automation services deposit',
      'greenhouse automation deposit',
      'greenhouse automation service - deposit',
      'greenhouse automation services - deposit',
      'deposit for greenhouse automation temp management (2 houses) & temp / hum management (2 houses)',
      'deposit',
      'dépôt',
      // Rachats
      'orisha buy back',
      'rachat des équipements en location',
      'rachat des appareils en location',
      "rachat d'équipements en location",
    ],
  },

  // === Existants à réutiliser explicitement (FR/EN ne matchent pas par défaut) ===
  { existingSku: 'SVC-004', keys: ['orisha in the greenhouse'] },
  { existingSku: '1023',    keys: ['sun sensor'] }, // = solar sensor
  { existingSku: '1038',    keys: ['capteur de vent', 'wind sesor'] }, // typo
  { existingSku: '1482',    keys: ['module d\'activation', 'activation unit v2'] },
  { existingSku: '1179',    keys: ['fuse board mount 5a'] },

  // === Chauffage ===
  { fr: 'Chauffage', en: 'Heating', keys: ['heating', 'chauffage', 'stade de chauffage', 'heating stage'] },
  { fr: 'Chauffage additionnel', en: 'Additional heating', keys: ['chauffage additionnel'] },
  { fr: 'Fournaise de type On/Off', en: 'Heater ON/OFF type', keys: ['fournaise de type on/off', 'heater on/off type'] },
  { fr: 'Automatisation fournaise', en: 'Heater automation', keys: ['automatisation fournaise', 'heater automation'] },

  // === Ventilation ===
  { fr: 'Ventilation avancée', en: 'Advanced Ventilation', keys: ['advanced ventilation', 'ventilation avancée'] },
  { fr: 'Ventilation avancée (inverseur non inclus)', en: 'Advanced Ventilation (inverter not included)',
    keys: ['advanced ventilation (inverter not included)', 'ventilation avancée (inverseur non inclus)'] },
  { fr: 'Ventilation par roll-up', en: 'Roll-Up Ventilation',
    keys: ['roll-up ventilation', 'rollup ventilation', 'ventilation par rollup', 'ventilation par roll-up'] },
  { fr: 'Ventilation par roll-up (moteurs non inclus)', en: 'Roll-Up Ventilation (motors not included)',
    keys: ['roll-up ventilation (motors not included)', 'ventilation par rollup (moteurs non inclus)',
      'ventilation par roll-up (moteurs non inclus)'] },
  { fr: 'Ventilation des côtés', en: 'Side Ventilation', keys: ['side ventilation', 'ventilation des côtés'] },
  { fr: 'Ventilation des côtés (moteurs inclus)', en: 'Side ventilation (motors included)',
    keys: ['side ventilation (motors included)', 'ventilation des côtés (moteurs inclus)'] },
  { fr: 'Ventilation des côtés (moteurs non inclus)', en: 'Side ventilation (motors not included)',
    keys: ['side ventilation (motors not included)', 'ventilation des côtés (moteurs non inclus)',
      'ventilation par côtés ouvrants (moteurs non inclus)'] },
  { fr: 'Ventilation par ventilateurs', en: 'Fan ventilation', keys: ['ventilation par ventilateurs'] },
  { fr: 'Ventilation des toits', en: 'Roof ventilation', keys: ['ventilation des toits'] },

  // === Protection ===
  { fr: 'Protection contre le vent', en: 'Wind Protection', keys: ['wind protection', 'protection contre le vent'] },
  { fr: 'Protection contre la pluie', en: 'Rain Protection', keys: ['rain protection', 'protection contre la pluie'] },

  // === Irrigation ===
  { fr: 'Irrigation', en: 'Irrigation', keys: ['irrigation'] },

  // === Tunnel ===
  { fr: 'Orisha dans le tunnel', en: 'Get Orisha in the tunnel',
    keys: ['get orisha in the tunnel', 'orisha in the tunnel', 'get orisha in your tunnel'] },

  // === Custom / divers commerciaux ===
  { fr: 'Sur mesure', en: 'Custom', keys: ['custom', 'sur mesure'] },
  { fr: 'Projet sur mesure - couverture de rang', en: 'Custom project automated row cover',
    keys: ['custom project automated row cover'] },
  { fr: 'Frais de livraison', en: 'Delivery fee',
    keys: ['frais de livraison', 'delivery fee', 'livraison', 'frais livraison expédition prioritaire',
      'envoi commande express', 'shipping for 2 missing multifucntion boxes', 'shipping back of harnois inverters',
      'frais de transport retour erroné', 'return shipping labels'] },
  { fr: 'Location', en: 'Rent', keys: ['location', 'rent'] },
  { fr: 'Installation', en: 'Installation',
    keys: ['installation (incluant temps de déplacement)', "temps d'installation"] },

  // === Contrôleur central ===
  { fr: 'Contrôleur central', en: 'Central controller',
    keys: ['central controller', 'contrôleur central', 'antenne pour le contrôleur central',
      'rallonge antenne contrôleur central'] },
  { fr: 'Contrôleur central de remplacement', en: 'Replacement central controller',
    keys: ['contrôleur central de remplacement'] },
  { fr: 'Option accès réseau mobile du contrôleur central', en: 'Mobile network option for central controller',
    keys: ['option accès réseau mobile du contrôleur central'] },

  // === Capteurs ===
  { fr: 'Capteur de température et humidité', en: 'Temperature and humidity sensor',
    keys: ['capteur de température et humidité', "capteur de température et d'humidité",
      'temperature and humidity sensor', 'sonde de température et humidité',
      'capteur température et humidité de remplacement'] },
  { fr: 'Sonde BME280', en: 'BME280 probe',
    keys: ['sonde bme-280', 'sonde bme280', 'sonde bme280 pour capteur de température et humidité',
      'sonde bme de remplacement', 'sonde de capteur de température et humidité bme280',
      'sonde bme 280 température et humidité', 'bme probe replacement part'] },
  { fr: 'Capteur de climat extérieur', en: 'Outdoor Climate Sensor',
    keys: ['outdoor climate sensor', 'capteur de la climat extérieur', 'capteur de climat extérieur',
      'option capteur de climat avancé', 'outside temperature and humidity probe'] },
  { fr: 'Capteur de sol', en: 'Soil sensor', keys: ['capteur de sol', 'soil temp probe'] },
  { fr: 'Capteur bulbe sec / bulbe humide', en: 'Dry bulb / wet bulb sensor',
    keys: ['capteur bulbe sec bulbe humide', 'wet/ dry bulb', 'mèche capteur bulbe sec/humide'] },

  // === Tensiomètre ===
  { fr: 'Tensiomètre 12 po', en: '12 in tensiometer',
    keys: ['12 in tensiometer', 'tensiomètre 12 po avec émetteur', 'tensiomètre irrometer 12 po rsu-v'] },
  { fr: 'Tensiomètre', en: 'Tensiometer', keys: ['tensiomètre'] },

  // === Valves ===
  { fr: 'Valve (automatisation et relais)', en: 'Valve (automation and relays)',
    keys: ['valve (automation and relays)', 'valve (automatisation et relais)'] },
  { fr: 'Valve électrique 24V AC', en: '24V AC electric valve',
    keys: ['valve électrique 24v ac', '24v ac electric valve', 'valve solénoïde 24v ac',
      'valve électrique 24 volts 1 pouce fpt irritrol'] },
  { fr: 'Automatisation valve', en: 'Valve automation',
    keys: ['valve automation', 'automatisation valve', 'automatisation de valve', "automatisation d'une valve"] },

  // === Toit / côtés ouvrants ===
  { fr: 'Automatisation toit ouvrant', en: 'Roof automation',
    keys: ['roof automation', 'automatisation toit ouvrant', 'automatisation de toit ouvrant'] },
  { fr: 'Automatisation côté ouvrant', en: 'Side curtain automation',
    keys: ['side curtain automation', 'automatisation côté ouvrant', 'automatisation côté ouvrany',
      'automatisation des côtés ouvrants'] },
  { fr: 'Automatisation lumières', en: 'Lighting automation', keys: ['automatisation lumières'] },
  { fr: 'Côté ouvrant', en: 'Side curtain',
    keys: ['côté ouvrant', 'side curtains', 'module de côté ouvrant',
      'circuit imprimé module de côté ouvrant (pour remplacement endommagé par la foudre)'] },
  { fr: 'Toit ouvrant 240V', en: 'Roof 240V', keys: ['roof 240 v', 'roof 240v', 'toit ouvrant 240v'] },
  { fr: 'Inverseur de toit ouvrant 240V', en: 'Roof 240V inverter',
    keys: ['inverseur de toit ouvrant 240v', '24v dc 10 a inverter', 'opening with 24v inverter'] },

  // === HAF / pression ===
  { fr: 'Automatisation des HAF', en: 'HAF automation',
    keys: ['haf automation', 'automatisation des haf', 'haf'] },
  { fr: 'Pression positive/négative', en: 'Positive/negative pressure vent',
    keys: ['positive/negative pressure vent', 'pression positive/négative', 'positive pressure and louvers'] },
  { fr: 'Automatisation pression positive', en: 'Positive pressure automation',
    keys: ['positive pressure automation', 'automatisation pression positive',
      'automatisation des pressions positives'] },

  // === Misc structural / climat ===
  { fr: 'Brumisateur', en: 'Mister', keys: ['brumisateur'] },
  { fr: "Conservation de l'humidité", en: 'Humidity Conservation',
    keys: ["conservation de l'humidité", 'humidity conservation'] },
  { fr: 'Toile thermique', en: 'Thermal screen', keys: ['toile thermique', 'thermal screen'] },
  { fr: 'Automatisation de batterie thermique', en: 'Thermal battery automation',
    keys: ['automatisation de batterie thermique'] },

  // === Moteurs / extensions ===
  { fr: 'Moteur 24V DC', en: '24V DC motor', keys: ['moteur 24v dc', 'motor 24v dc', 'motors 24vdc'] },
  { fr: 'Kit de moteurs roll-up', en: 'Roll-up motors kit',
    keys: ['roll motors kit', 'roll-up motor set', 'roll-up motors with manual overide'] },
  { fr: 'Roll-Up', en: 'Roll-Up', keys: ['roll-up'] },
  { fr: 'Rallonge pour moteur', en: 'Motor extension', keys: ['rallonge pour moteur 25 pi'] },
  { fr: 'Transformateur 24V AC', en: '24V AC transformer', keys: ['transformateur 24v ac'] },
  { fr: 'Transformateur 24V DC 10A', en: '24V DC 10A transformer', keys: ['transformateur 24 v dc 10a'] },

  // === Boîtiers ===
  { fr: 'Boîtier multifonction', en: 'Multifunction box',
    keys: ['boitier multifonction', 'reprogrammation boitier multifonction',
      'fusible de remplacement pour boitier multifonction', 'carte pcb boitier multifonction'] },
  { fr: 'Boîtier ventilateur et louvre custom', en: 'Custom fan & louver box',
    keys: ['boitier custom fan & louvre', 'fan & louvers relay box', 'boitier custom louvre',
      'boitier louvres custom'] },
  { fr: 'Boîtier de relais 110V', en: '110V relay box', keys: ['boitier relais 110v', '240 v relay'] },

  // === Composants électroniques divers ===
  { fr: 'Carte PCB de remplacement', en: 'PCB board replacement', keys: ['pcb board replacement'] },
  { fr: 'Fusible 4A 250V', en: '4A 250V fuse', keys: ['fusible 4a 250v'] },
  { fr: 'Fusible', en: 'Fuse', keys: ['fusible'] },
  { fr: 'Mèche de remplacement (mètre)', en: 'Replacement wick (meter)', keys: ['mèche de remplacement (mètre)'] },
  { fr: 'Lampes HPS', en: 'HPS Lamps', keys: ['lampes hps', 'lumières', 'lumière + boitier 110v'] },
  { fr: 'Relais semiconducteur', en: 'Semiconductor relay', keys: ['relais semiconducteur'] },
  { fr: 'Pompe à eau chaude', en: 'Hot water pump', keys: ['hot water pump'] },
  { fr: 'Carte SD', en: 'SD card', keys: ['carte sd'] },
  { fr: 'Escabeau', en: 'Ladder', keys: ['escabeau'] },
]

// Construire l'index : nom lowercased → règle
const RULE_BY_KEY = new Map()
for (const rule of RULES) {
  for (const k of rule.keys) {
    if (RULE_BY_KEY.has(k)) {
      console.warn(`⚠ Doublon dans RULES: "${k}" déjà mappé`)
    }
    RULE_BY_KEY.set(k, rule)
  }
}

// === TEST bucket (créé dynamiquement)
const TEST_RULE = { fr: 'TEST', en: 'TEST' }

// --------- Chargement données ---------
const items = db.prepare(`SELECT id, description, product_id FROM stripe_invoice_items`).all()
const products = db.prepare(`SELECT id, sku, name_fr, name_en, active FROM products`).all()

const productByName = new Map() // lowercased name → product
for (const p of products) {
  for (const n of [p.name_fr, p.name_en]) {
    if (!n) continue
    const k = lower(n)
    if (!productByName.has(k)) productByName.set(k, p)
  }
}
const productBySku = new Map(products.filter(p => p.sku).map(p => [p.sku, p]))

// --------- Résolution cible pour chaque item ---------
function resolveTarget(rawDescription) {
  // 1. TEST: contient "test" (case insensitive) dans la description brute
  if (/test/i.test(rawDescription || '')) {
    return { type: 'rule', rule: TEST_RULE }
  }
  const cleaned = extractName(rawDescription)
  const key = lower(cleaned)
  if (!key) return { type: 'skip' }

  // 2. Règle explicite ?
  const rule = RULE_BY_KEY.get(key)
  if (rule) return { type: 'rule', rule }

  // 3. Fallback : match exact sur produit existant via le nom nettoyé
  const existing = productByName.get(key)
  if (existing) return { type: 'existing', product: existing }

  // 4. Standalone : créer un produit avec le nom nettoyé en FR (et EN identique)
  return { type: 'rule', rule: { fr: cleaned, en: cleaned } }
}

// --------- Collecte ---------
const unlinked = items.filter(i => !i.product_id)
const alreadyLinkedCount = items.length - unlinked.length

// Map: targetKey ("sku:XXX" ou "new:fr|en") → { rule|existing, items[] }
const targets = new Map()
let skipped = 0
for (const it of unlinked) {
  const t = resolveTarget(it.description)
  if (t.type === 'skip') { skipped++; continue }
  let key
  if (t.type === 'existing') {
    key = `sku:${t.product.id}`
  } else if (t.rule.existingSku) {
    const p = productBySku.get(t.rule.existingSku)
    if (!p) { console.error(`❌ existingSku "${t.rule.existingSku}" introuvable`); continue }
    key = `sku:${p.id}`
    t.product = p
    t.type = 'existing'
  } else {
    key = `new:${lower(t.rule.fr)}|${lower(t.rule.en)}`
  }
  if (!targets.has(key)) targets.set(key, { ...t, items: [] })
  targets.get(key).items.push(it)
}

// --------- Pour chaque cible "new", vérifier si un produit existe déjà par nom ---------
const toCreate = [] // [{fr, en, items}]
const toLinkExisting = [] // [{product, items}]
for (const [key, t] of targets.entries()) {
  if (t.type === 'existing') {
    toLinkExisting.push({ product: t.product, items: t.items })
    continue
  }
  // type === 'rule', new
  const fr = t.rule.fr
  const en = t.rule.en
  const existing = productByName.get(lower(fr)) || productByName.get(lower(en))
  if (existing) {
    toLinkExisting.push({ product: existing, items: t.items })
  } else {
    toCreate.push({ fr, en, items: t.items })
  }
}

// --------- Affichage ---------
console.log('='.repeat(60))
console.log(`MODE: ${APPLY ? 'APPLY' : 'DRY RUN'}`)
console.log('='.repeat(60))
console.log(`Total items                    : ${items.length}`)
console.log(`Déjà liés (intouchés)          : ${alreadyLinkedCount}`)
console.log(`Non liés                       : ${unlinked.length}`)
console.log(`  - skipped (sans description) : ${skipped}`)
console.log(`  - cibles produit existant    : ${toLinkExisting.length} groupes`)
console.log(`  - produits À CRÉER           : ${toCreate.length}`)
console.log()

console.log('--- Liaisons vers produits existants ---')
toLinkExisting.sort((a, b) => b.items.length - a.items.length)
for (const t of toLinkExisting) {
  console.log(`  [${t.items.length.toString().padStart(4)}x] -> ${t.product.name_fr || t.product.name_en} (${t.product.sku || '—'})`)
}
console.log()

console.log(`--- Produits à créer (${toCreate.length}) ---`)
toCreate.sort((a, b) => b.items.length - a.items.length)
for (const c of toCreate) {
  console.log(`  [${c.items.length.toString().padStart(4)}x] FR="${c.fr}" / EN="${c.en}"`)
}
console.log()

if (!APPLY) {
  console.log('Dry run — relance avec --apply pour exécuter.')
  process.exit(0)
}

// --------- APPLY ---------
console.log('Application en cours…')
const insertProduct = db.prepare(`
  INSERT INTO products (id, name_fr, name_en, active)
  VALUES (?, ?, ?, 1)
`)
const linkItem = db.prepare(`
  UPDATE stripe_invoice_items
  SET product_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`)

const tx = db.transaction(() => {
  let createdCount = 0
  let linkedCount = 0

  // Créer les nouveaux produits
  for (const c of toCreate) {
    const id = uuidv4()
    insertProduct.run(id, c.fr, c.en)
    createdCount++
    for (const it of c.items) {
      linkItem.run(id, it.id)
      linkedCount++
    }
  }
  // Lier vers existants
  for (const t of toLinkExisting) {
    for (const it of t.items) {
      linkItem.run(t.product.id, it.id)
      linkedCount++
    }
  }
  return { createdCount, linkedCount }
})

const result = tx()
console.log(`✅ ${result.createdCount} produits créés`)
console.log(`✅ ${result.linkedCount} items liés`)
process.exit(0)
