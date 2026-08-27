// Appariement « ligne de facture fournisseur ↔ achat LIA ». Ces tests couvrent le
// scoring pur (aucune DB) : la fonction scoreLine et l'affectation des couples.
import test from 'node:test'
import assert from 'node:assert'
import {
  buildLiaLabel, completeLiaDescription, normalizeVendorKey, sameVendor, tokenSimilarity,
  scoreLine, applyAutoMatches, isConfidentMatch, matchLines, partRefs, LIA_AUTO_THRESHOLD, LIA_SUGGEST_THRESHOLD,
} from './purchaseLiaMatch.js'

// Appariement sans base de données : les candidats sont fournis tels quels.
const matchWith = (items, candidates, receiptDate) => matchLines({ items, candidates, receiptDate })

const RECEIPT_DATE = '2026-07-30'
const ctx = { receiptDate: RECEIPT_DATE }

// Achat type : pièce nommée, quantité et coût unitaire connus.
const achat = over => ({
  id: 'p1', lia_ref: 'LIA-1987', part_name: 'CONN HEADER VERT 10POS 2.54MM', part_sku: '1150',
  qty_ordered: 50, unit_cost: 0.72, order_date: '2026-07-09', linked_receipts: [], ...over,
})

test('libellé LIA = code + nom de la pièce', () => {
  assert.equal(buildLiaLabel('LIA-1991', 'SIM Simplex CAN (Carrier 1)'), 'LIA-1991\tSIM Simplex CAN (Carrier 1)')
  // Achat sans pièce liée : le code seul, pas de tabulation orpheline.
  assert.equal(buildLiaLabel('LIA-1991', null), 'LIA-1991')
  assert.equal(buildLiaLabel(' LIA-1991 ', null), 'LIA-1991')
  assert.equal(buildLiaLabel(null, null), '')
})

test('description complétée : le séparateur est normalisé, le nom conservé', () => {
  assert.equal(completeLiaDescription('LIA-1991\tSIM Simplex CAN (Carrier 1)'), 'LIA-1991\tSIM Simplex CAN (Carrier 1)')
  assert.equal(completeLiaDescription('LIA-1966 - LVM60 Automatisation'), 'LIA-1966\tLVM60 Automatisation')
  assert.equal(completeLiaDescription('lia-1966 moteur'), 'LIA-1966\tmoteur')
  // Aucune référence LIA : description intouchée.
  assert.equal(completeLiaDescription('Transport Purolator'), 'Transport Purolator')
  assert.equal(completeLiaDescription('Liaison série RS485'), 'Liaison série RS485')
})

test('clé fournisseur — suffixes de devise et formes juridiques ignorés', () => {
  assert.equal(normalizeVendorKey('Takachi USD'), 'takachi')
  assert.equal(normalizeVendorKey('Hydreon Corporation - USD'), 'hydreon')
  assert.equal(normalizeVendorKey('Fabrique Manic inc.'), 'fabrique manic')
  assert.ok(sameVendor('Takachi', 'Takachi USD'))
  assert.ok(sameVendor('McMaster-Carr USD', 'McMaster Carr'))
  assert.ok(!sameVendor('Mouser Electronics', 'Newark'))
})

test('similarité — les références alphanumériques pèsent plus que les mots courants', () => {
  const withRef = tokenSimilarity('TD191-B 4G LTE dongle', 'Dongle TD191-B')
  const withoutRef = tokenSimilarity('Module de contrôle', 'Module de commande')
  assert.ok(withRef > withoutRef, `${withRef} devrait dépasser ${withoutRef}`)
})

test('nom + prix unitaire + montant + quantité concordants → écriture automatique', () => {
  const line = { description: 'CONN HEADER VERT 10POS 2.54MM', quantity: 50, unit_price: 0.72, total: 36 }
  const scored = scoreLine(line, achat(), ctx)
  assert.ok(scored.score >= LIA_AUTO_THRESHOLD, `score ${scored.score} attendu ≥ ${LIA_AUTO_THRESHOLD}`)
  assert.ok(isConfidentMatch(scored, 0), `détail ${JSON.stringify(scored.detail)} attendu comme certain`)
})

test('argent concordant mais libellé étranger → rien du tout (garde-fou de nom)', () => {
  // Cas réel : une facture Amazon « MoKo MagSafe Tripod Mount » se faisait apparier à un
  // achat de thermostat au montant voisin. Le prix seul n'identifie pas une pièce.
  const thermostat = achat({ part_name: 'Thermostat de secours / Honeywell Home RTH111B', part_sku: '1088' })
  const line = { description: 'MoKo MagSafe Tripod Mount', quantity: 50, unit_price: 0.72, total: 36 }
  const { score } = scoreLine(line, thermostat, ctx)
  assert.equal(score, 0)
})

test('deux achats jumeaux (même pièce, même prix) → jamais écrit d\'office', () => {
  // Moteur LVM60 gauche/droit, ou deux PO successifs de la même valve : l'écart de score
  // est infime, l'arbitrage revient à l'opérateur.
  const line = { description: 'CONN HEADER VERT 10POS 2.54MM', quantity: 50, unit_price: 0.72, total: 36 }
  const scored = scoreLine(line, achat(), ctx)
  assert.ok(!isConfidentMatch(scored, scored.score - 0.01), 'un 2e candidat quasi ex æquo bloque l\'automatisme')
})

test('deux commandes de la MÊME pièce : celle reçue la semaine de la facture l\'emporte', () => {
  // Cas réel Dubois Agrinovation : la valve Rainbird a été commandée en mars (LIA-1877,
  // reçue le 17 mars) puis en juillet (LIA-1983, reçue le 15 juillet). La facture du
  // 10 juillet ne peut être que la seconde — quantité et prix sont pourtant identiques.
  const valve = { part_name: 'Rainbird - Valve 24V 1 Pouce', part_sku: '1402', qty_ordered: 20, linked_receipts: [] }
  const line = { description: 'RB.VALVE ELECTRIQUE 1"FT.24 V.', quantity: 20, unit_price: 35.33, total: 706.56 }
  const c = { receiptDate: '2026-07-10' }
  const juillet = scoreLine(line, { ...valve, id: 'p2', lia_ref: 'LIA-1983', unit_cost: 36.128, order_date: '2026-07-09', received_date: '2026-07-15' }, c)
  const mars = scoreLine(line, { ...valve, id: 'p3', lia_ref: 'LIA-1877', unit_cost: 34.498, order_date: '2026-03-11', received_date: '2026-03-17' }, c)
  assert.ok(juillet.score - mars.score >= 0.05, `écart ${(juillet.score - mars.score).toFixed(3)} trop faible pour départager`)
  assert.ok(isConfidentMatch(juillet, mars.score), 'la commande de juillet doit être écrite d\'office')
  assert.ok(!isConfidentMatch(mars, juillet.score), 'la commande de mars ne doit jamais être écrite')
})

test('achat pas encore reçu : le signal de réception est absent, pas pénalisant', () => {
  const line = { description: 'CONN HEADER VERT 10POS 2.54MM', quantity: 50, unit_price: 0.72, total: 36 }
  const scored = scoreLine(line, achat({ received_date: null }), ctx)
  assert.equal(scored.detail.recv, undefined)
  assert.ok(isConfidentMatch(scored, 0), 'une commande non encore reçue reste appariable d\'office')
})

test('libellé concordant seul (prix et quantité absents) → suggestion, pas écriture', () => {
  const sansPrix = achat({ unit_cost: 0, qty_ordered: 0 })
  const line = { description: 'CONN HEADER VERT 10POS 2.54MM' }
  const scored = scoreLine(line, sansPrix, ctx)
  assert.ok(scored.score >= LIA_SUGGEST_THRESHOLD)
  assert.ok(!isConfidentMatch(scored, 0), 'sans corroboration monétaire, pas d\'écriture automatique')
})

test('ligne sans rapport (frais de transport) → sous le seuil de suggestion', () => {
  const line = { description: 'Frais de transport', quantity: 1, unit_price: 45, total: 45 }
  const { score } = scoreLine(line, achat(), ctx)
  assert.ok(score < LIA_SUGGEST_THRESHOLD, `score ${score} attendu < ${LIA_SUGGEST_THRESHOLD}`)
})

test('coût unitaire pas encore connu : jugé sur nom + quantité, sans pénalité', () => {
  // Achat de PCB saisi avant que le prix soit connu (unit_cost = 0), facturé 3 mois plus tard.
  const pcb = achat({ lia_ref: 'LIA-1961', part_name: "PCB Module d'activation V2", part_sku: '1459', qty_ordered: 100, unit_cost: 0, order_date: '2026-05-25' })
  const line = { description: 'Assemblage unitaire de ACTIVATION_UNIT', quantity: 100, unit_price: 20.0458, total: 2004.58 }
  const { score } = scoreLine(line, pcb, ctx)
  // Concordance partielle (quantité + un mot) : proposé, jamais écrit d'office.
  assert.ok(score >= LIA_SUGGEST_THRESHOLD, `score ${score} attendu ≥ ${LIA_SUGGEST_THRESHOLD}`)
  assert.ok(score < LIA_AUTO_THRESHOLD, `score ${score} attendu < ${LIA_AUTO_THRESHOLD}`)
})

test('achat déjà rattaché à une autre facture : candidat, mais derrière un achat libre', () => {
  const line = { description: 'CONN HEADER VERT 10POS 2.54MM', quantity: 50, unit_price: 0.72, total: 36 }
  const libre = scoreLine(line, achat(), ctx).score
  const reuse = scoreLine(line, achat({ id: 'p2', linked_receipts: [{ receipt_id: 'r9' }] }), ctx)
  assert.ok(reuse.score < libre)
  assert.ok(reuse.reasons.includes('déjà rattaché à une autre facture'))
})

test('achat trop ancien (hors fenêtre) : le signal de date tombe à zéro', () => {
  const line = { description: 'CONN HEADER VERT 10POS 2.54MM', quantity: 50, unit_price: 0.72, total: 36 }
  const vieux = scoreLine(line, achat({ order_date: '2019-01-01' }), ctx).score
  const recent = scoreLine(line, achat(), ctx).score
  assert.ok(vieux < recent)
})

test('un achat déjà facturé n\'est jamais proposé, et n\'est pas remplacé par un code libre moins bon', () => {
  // Règle métier : seul un code LIA encore libre (aucune dépense rattachée dans Airtable,
  // aucun reçu de l'ERP) peut être proposé. Mais écarter le bon code ne doit pas faire
  // remonter un code libre moins pertinent à sa place — cas réel Dubois, où la valve
  // Rainbird déjà facturée laissait proposer une valve Irritrol de 2025 restée libre.
  const line = { description: 'RB.VALVE ELECTRIQUE 1"FT.24 V.', quantity: 20, unit_price: 35.33, total: 706.56 }
  const rainbird = {
    id: 'p-rainbird', lia_ref: 'LIA-1983', part_name: 'Rainbird - Valve 24V 1 Pouce', part_sku: '1402',
    qty_ordered: 20, unit_cost: 36.128, order_date: '2026-07-09', received_date: '2026-07-15',
    already_expensed: true, linked_receipts: [],
  }
  const irritrol = {
    id: 'p-irritrol', lia_ref: 'LIA-1528', part_name: 'Irritrol - Valve électrique 24 Volts 1 Pouce FPT', part_sku: '1403',
    qty_ordered: 20, unit_cost: 32.8, order_date: '2025-08-14', received_date: '2025-08-20',
    already_expensed: false, linked_receipts: [],
  }
  const { lines } = matchWith([line], [rainbird, irritrol], '2026-07-10')
  assert.equal(lines[0].match, null, 'aucun code libre ne doit être proposé à la place du bon')
  assert.equal(lines[0].blocked_by?.lia_ref, 'LIA-1983')
  assert.match(lines[0].blocked_by.reason, /Airtable/)
})

test('code libre nettement meilleur : proposé normalement malgré un achat facturé voisin', () => {
  const line = { description: 'CONN HEADER VERT 10POS 2.54MM', quantity: 50, unit_price: 0.72, total: 36 }
  const libre = { ...achat(), id: 'p-libre', already_expensed: false }
  const factureAilleurs = {
    ...achat(), id: 'p-vieux', lia_ref: 'LIA-1400', part_name: 'Boîtier ABS 120x80', part_sku: '1201',
    unit_cost: 12.5, order_date: '2026-01-04', already_expensed: true,
  }
  const { lines } = matchWith([line], [libre, factureAilleurs], RECEIPT_DATE)
  assert.equal(lines[0].match?.purchase_id, 'p-libre')
  assert.equal(lines[0].blocked_by, undefined)
  // La description proposée porte le code ET le nom de la pièce, jamais le code seul.
  assert.equal(lines[0].match.description, 'LIA-1987\tCONN HEADER VERT 10POS 2.54MM')
})

test('applyAutoMatches ne réécrit que les appariements certains', () => {
  const items = [
    { description: 'CONN HEADER VERT 10POS 2.54MM', total: 36 },
    { description: 'Frais de transport', total: 45 },
    { description: 'Assemblage unitaire de ACTIVATION_UNIT', total: 2004.58 },
  ]
  const lines = [
    { index: 0, match: { purchase_id: 'p1', lia_ref: 'LIA-1987', part_name: 'CONN HEADER VERT 10POS 2.54MM', description: buildLiaLabel('LIA-1987', 'CONN HEADER VERT 10POS 2.54MM'), auto: true, score: 0.9 } },
    { index: 1, match: null },
    { index: 2, match: { purchase_id: 'p3', lia_ref: 'LIA-1961', part_name: "PCB Module d'activation V2", description: buildLiaLabel('LIA-1961', "PCB Module d'activation V2"), auto: false, score: 0.45 } },
  ]
  const { items: out, applied } = applyAutoMatches(items, lines)
  assert.equal(out[0].description, 'LIA-1987\tCONN HEADER VERT 10POS 2.54MM', 'le code ET le nom de la pièce sont écrits sur la ligne')
  assert.equal(out[0].purchase_id, 'p1')
  assert.equal(out[1].description, 'Frais de transport', 'ligne non appariée intouchée')
  assert.equal(out[2].description, 'Assemblage unitaire de ACTIVATION_UNIT', 'suggestion non appliquée')
  assert.equal(out[2].purchase_id, undefined)
  assert.equal(applied.length, 1)
})

test('référence fabricant imprimée sur la facture → identification, même sans prix connu', () => {
  // Cas réel Digikey / LIA-1994 : la commande est encore « à recevoir », son prix
  // unitaire vaut 0 tant que la facture n'est pas entrée. Le libellé de la facture ne
  // reprend jamais le nom Orisha (« Transfo AC/AC 24V 1.8A ») mais toujours la référence
  // fabricant — c'est elle qui identifie la pièce.
  const transfo = {
    id: 'p-1994', lia_ref: 'LIA-1994', part_name: 'Transfo AC/AC 24V 1.8A', part_sku: '1221',
    part_mpn: 'WAU24-1800', part_refs: partRefs({ part_mpn: 'WAU24-1800', part_url: 'https://www.digikey.ca/en/products/detail/triad-magnetics/WAU24-1800/4915305' }),
    qty_ordered: 5, unit_cost: 0, order_date: '2026-08-17', received_date: null,
    pending_reception: true, linked_receipts: [],
  }
  const line = { description: 'WAU24-1800-ND XFRMR 24V 1.8A', quantity: 5, unit_price: 24.51, total: 122.55 }
  const scored = scoreLine(line, transfo, { receiptDate: '2026-08-20' })
  assert.equal(scored.detail.ident, 1, 'la référence fabricant vaut identification')
  assert.ok(isConfidentMatch(scored, 0), `détail ${JSON.stringify(scored.detail)} attendu comme certain`)
  // Le numéro de catalogue du distributeur, seul imprimé sur certaines factures, suffit aussi.
  assert.equal(scoreLine({ ...line, description: 'Digi-Key 4915305 transformer' }, transfo, {}).detail.ident, 1)
})

test('référence fabricant mais quantité contredisante → suggestion, pas écriture', () => {
  const relais = {
    id: 'p-1995', lia_ref: 'LIA-1995', part_name: 'Relais NC/NO', part_sku: '1568',
    part_mpn: 'G7J-2A2B-B-DC24', part_refs: partRefs({ part_mpn: 'G7J-2A2B-B-DC24' }),
    qty_ordered: 10, unit_cost: 0, pending_reception: true, order_date: '2026-08-17', linked_receipts: [],
  }
  // 3 facturés sur 10 commandés : livraison partielle probable — l'opérateur tranche.
  const scored = scoreLine({ description: 'G7J-2A2B-B-DC24 RELAY', quantity: 3, unit_price: 41.2, total: 123.6 }, relais, {})
  assert.equal(scored.detail.ident, 1)
  assert.ok(!isConfidentMatch(scored, 0))
})

test('cadrage « à recevoir » : un achat déjà reçu ne passe pas devant une commande en attente', () => {
  const line = { description: 'CONN HEADER VERT 10POS 2.54MM', quantity: 50, unit_price: 0.72, total: 36 }
  const enAttente = achat({ id: 'p-attente', lia_ref: 'LIA-1994', unit_cost: null, received_date: null, pending_reception: true, order_date: '2026-07-25' })
  const dejaRecu = achat({ id: 'p-recu', lia_ref: 'LIA-1900', received_date: '2026-07-15' })
  const { lines } = matchWith([line], [dejaRecu, enAttente], RECEIPT_DATE)
  assert.equal(lines[0].match?.purchase_id, 'p-attente')
  assert.equal(lines[0].match.pending_reception, true)
})

test('aucune commande en attente ne colle : filet sur les achats reçus non facturés', () => {
  // La facture arrive après que la réception a été cochée (cas Simplex/Digikey) : sans
  // ce filet la ligne resterait sans code alors que l'achat existe, non facturé.
  const line = { description: 'CONN HEADER VERT 10POS 2.54MM', quantity: 50, unit_price: 0.72, total: 36 }
  const autreEnAttente = achat({ id: 'p-autre', lia_ref: 'LIA-1996', part_name: 'Support relais', part_sku: '1569', unit_cost: null, received_date: null, pending_reception: true })
  const recuNonFacture = achat({ id: 'p-recu', received_date: '2026-07-15' })
  const { lines } = matchWith([line], [autreEnAttente, recuNonFacture], RECEIPT_DATE)
  assert.equal(lines[0].match?.purchase_id, 'p-recu')
  assert.equal(lines[0].match.pending_reception, false, "la proposition dit qu'elle vient d'un achat déjà reçu")
})
