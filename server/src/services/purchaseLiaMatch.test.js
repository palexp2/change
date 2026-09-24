// Rattachement « ligne de facture fournisseur ↔ achat LIA ». Ces tests couvrent la
// mécanique SANS base de données : libellé LIA, reconnaissance du fournisseur,
// classement du sélecteur, et le fait qu'un candidat sans le moindre signal ne soit
// jamais proposé ni réécrit d'office. Le scoring lui-même (et ce qui identifie
// vraiment une pièce) est couvert par purchaseLiaIdentity.test.js.
import test from 'node:test'
import assert from 'node:assert'
import {
  buildLiaLabel, completeLiaDescription, normalizeVendorKey, sameVendor,
  matchLines, autoLinkReceiptItems, candidateTier, hasLiaRef,
  splitCoveredPurchases, allocateAmount,
} from './purchaseLiaMatch.js'

const candidat = over => ({ id: 'p1', lia_ref: 'LIA-1987', linked_receipts: [], ...over })

test('libellé LIA = code + nom de la pièce', () => {
  assert.equal(buildLiaLabel('LIA-1991', 'SIM Simplex CAN (Carrier 1)'), 'LIA-1991\tSIM Simplex CAN (Carrier 1)')
  // Achat sans pièce liée : le code seul, pas de tabulation orpheline. C'est
  // devenu le cas NORMAL — un achat ne cite plus aucune pièce.
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

test('code LIA seul : le nom de la pièce est retrouvé en base, sinon le code seul', () => {
  // Achat inexistant : rien à compléter, le code reste nu (et la casse est normalisée).
  assert.equal(completeLiaDescription('LIA-999999'), 'LIA-999999')
  assert.equal(completeLiaDescription('  lia-999999  '), 'LIA-999999')
  // Achat existant : partNameByLiaRef() recolle le nom de la pièce derrière le code.
  // Dépend de la base, donc on vérifie la FORME, pas un nom en particulier.
  const filled = completeLiaDescription('LIA-1961')
  assert.ok(filled === 'LIA-1961' || /^LIA-1961\t.+/.test(filled), filled)
})

test('clé fournisseur — suffixes de devise et formes juridiques ignorés', () => {
  assert.equal(normalizeVendorKey('Takachi USD'), 'takachi')
  assert.equal(normalizeVendorKey('Hydreon Corporation - USD'), 'hydreon')
  assert.ok(sameVendor('Fabrique Manic', 'Fabrique Manic Electronique'))
  assert.ok(!sameVendor('Digikey', 'Mouser'))
})

test('reconnaissance d’un code LIA déjà écrit sur une ligne', () => {
  assert.ok(hasLiaRef('LIA-1987\tCONN HEADER'))
  assert.ok(!hasLiaRef('Transport Purolator'))
  assert.ok(!hasLiaRef(''))
})

test('aucune proposition : chaque ligne revient sans appariement', () => {
  const items = [{ description: 'CONN HEADER VERT 10POS 2.54MM', quantity: 50, unit_price: 0.72 }]
  const { lines, candidates } = matchLines({ items, candidates: [candidat()] })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].match, null)
  // Le candidat est bien passé au score, mais un achat sans pièce, sans quantité et
  // sans prix ne porte aucun signal : score nul, et rien ne l'identifie.
  assert.equal(lines[0].candidates.length, 1)
  assert.equal(lines[0].candidates[0].score, 0)
  assert.equal(lines[0].candidates[0].identity.kind, 'none')
  // Les candidats restent servis tels quels : c'est eux qui alimentent le
  // sélecteur manuel de la fiche reçu.
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].lia_ref, 'LIA-1987')
})

test('ligne déjà rattachée (ou portant déjà un code) : marquée « locked »', () => {
  const { lines } = matchLines({
    items: [
      { description: 'Pièce quelconque' },
      { description: 'Autre pièce', purchase_id: 'p9' },
      { description: 'LIA-1987\tCONN HEADER' },
    ],
    candidates: [candidat()],
  })
  assert.equal(lines[0].locked, false)
  assert.equal(lines[1].locked, true)
  assert.equal(lines[2].locked, true)
})

test('sans candidat ni ligne : la forme du retour tient quand même', () => {
  assert.deepEqual(matchLines({ items: [], candidates: [] }), { lines: [], candidates: [] })
  assert.deepEqual(matchLines({ items: null, candidates: [] }).lines, [])
})

test('extraction d’un reçu : aucune ligne n’est réécrite d’office', () => {
  const items = [{ description: 'CONN HEADER VERT 10POS 2.54MM', quantity: 50 }]
  const out = autoLinkReceiptItems({ items })
  assert.deepEqual(out.applied, [])
  assert.deepEqual(out.items, items)
  assert.deepEqual(autoLinkReceiptItems({ items: null }).items, [])
})

test('classement du sélecteur : les codes libres avant l’historique facturé', () => {
  assert.equal(candidateTier({ consumed: false }), 0)
  assert.equal(candidateTier({ consumed: true }), 2)
})

// ── Une ligne de facture qui couvre plusieurs achats ─────────────────────────
const achat = (ref, over = {}) => ({ id: ref, lia_ref: ref, linked_receipts: [], consumed: false, order_date: '2026-09-03', ...over })

test('répartition d’un montant : la somme des parts retombe au cent près', () => {
  assert.deepEqual(allocateAmount(173.21, [287.16, 96.08]), [129.79, 43.42])
  assert.deepEqual(allocateAmount(100, [1, 1, 1]), [33.34, 33.33, 33.33])
  // Sans poids exploitable : parts égales.
  assert.deepEqual(allocateAmount(10, [0, 0]), [5, 5])
})

test('ligne « incluant » une autre pièce : l’achat orphelin reçoit sa part', () => {
  const tuyau = achat('LIA-2010', { part_name: 'Tuyau guide', qty_ordered: 6, part_unit_value: 47.86 })
  const kit = achat('LIA-2011', { part_name: 'Kit eye bolt', qty_ordered: 4, part_unit_value: 24.02 })
  const items = [{ description: 'Guide Pipe Assembly - includes guide pipe hardware', quantity: 6, total: 173.21, purchase_id: 'LIA-2011', lia_ref: 'LIA-2011' }]
  const lines = [{ index: 0, match: null, candidates: [{ purchase: tuyau, score: 0.71 }, { purchase: kit, score: 0.83 }] }]
  const out = splitCoveredPurchases({ items, lines, candidates: [tuyau, kit] })
  assert.equal(out.items.length, 2)
  assert.deepEqual(out.items.map(i => i.lia_ref), ['LIA-2010', 'LIA-2011'])
  assert.deepEqual(out.items.map(i => i.total), [129.79, 43.42])
  // Le libellé imprimé par le fournisseur suit sur chaque part (vocabulaire appris).
  assert.ok(out.items.every(i => i.source_description === 'Guide Pipe Assembly - includes guide pipe hardware'))
})

test('quantité conservée : une ligne de 6 facture les deux achats de 3', () => {
  const ancre = achat('LIA-2011', { part_name: 'Kit', qty_ordered: 4 })
  const gauche = achat('LIA-2008', { part_name: 'Moteur gauche', qty_ordered: 3, part_unit_value: 484.67 })
  const droit = achat('LIA-2009', { part_name: 'Moteur droit', qty_ordered: 3, part_unit_value: 484.67 })
  const items = [
    { description: '60 NM motor', quantity: 6, total: 1816.88 },
    { description: 'Guide pipe', quantity: 4, total: 100, purchase_id: 'LIA-2011', lia_ref: 'LIA-2011' },
  ]
  const lines = [{ index: 0, match: null, candidates: [] }, { index: 1, match: null, candidates: [] }]
  const out = splitCoveredPurchases({ items, lines, candidates: [ancre, gauche, droit] })
  assert.deepEqual(out.items.map(i => i.lia_ref), ['LIA-2008', 'LIA-2009', 'LIA-2011'])
  assert.deepEqual(out.items.slice(0, 2).map(i => i.total), [908.44, 908.44])
  assert.deepEqual(out.items.slice(0, 2).map(i => i.quantity), [3, 3])
})

test('aucun découpage quand rien ne le justifie', () => {
  const orphelin = achat('LIA-2020', { part_name: 'Autre pièce', qty_ordered: 2, order_date: '2026-01-01' })
  const ancre = achat('LIA-2021', { part_name: 'Pièce', qty_ordered: 1 })
  const items = [{ description: 'Pièce', quantity: 1, total: 50, purchase_id: 'LIA-2021', lia_ref: 'LIA-2021' }]
  // Score sous le seuil ET bon de commande différent : l'orphelin reste orphelin.
  const lines = [{ index: 0, match: null, candidates: [{ purchase: orphelin, score: 0.1 }] }]
  const out = splitCoveredPurchases({ items, lines, candidates: [ancre, orphelin] })
  assert.deepEqual(out.splits, [])
  assert.equal(out.items.length, 1)
})

// ─── Fenêtre de date et départage (cas réel DigiKey 132580242, 2026-09-11) ───

const heatSink = over => candidat({
  part_name: 'HEAT SINK KIT FOR RASPBERRY PI 4', pending_reception: true, ...over,
})
const heatSinkLine = { description: 'HEAT SINK KIT FOR RASPBERRY PI 4', quantity: 30, unit_price: 1.55, total: 46.5 }

// L'achat de 2025 est REÇU (date sentinelle 1970-01-01) : hors section « À recevoir ».
const oldHeatSink = () => heatSink({ id: 'old', lia_ref: 'LIA-1687', qty_ordered: 15, unit_cost: 1.54, order_date: '2025-09-10',
  received_date: '1970-01-01T00:00:00.000Z', pending_reception: false })

test('HEAT SINK KIT : la dépense du 2026-09-11 prend l\'achat de 2026, pas celui de 2025', () => {
  const old = oldHeatSink()
  const cur = heatSink({ id: 'new', lia_ref: 'LIA-2018', qty_ordered: 30, unit_cost: null, order_date: '2026-09-11' })
  for (const candidates of [[old, cur], [cur, old]]) {
    const { lines } = matchLines({ items: [heatSinkLine], candidates, receiptDate: '2026-09-11' })
    assert.equal(lines[0].match?.purchase_id, 'new')
  }
})

test('achat déjà reçu seul : jamais rattaché, même au nom identique', () => {
  const { lines } = matchLines({ items: [heatSinkLine], candidates: [oldHeatSink()], receiptDate: '2026-09-11' })
  assert.equal(lines[0].match, null)
})

test('achat déjà relié à une autre dépense : jamais repris, même plus proche', () => {
  const taken = heatSink({ id: 'taken', lia_ref: 'LIA-2018', qty_ordered: 30, order_date: '2026-09-11',
    linked_receipts: [{ receipt_id: 'r0', receipt_number: 'X' }] })
  const other = heatSink({ id: 'other', lia_ref: 'LIA-2030', qty_ordered: 30, order_date: '2026-08-20' })
  const { lines } = matchLines({ items: [heatSinkLine], candidates: [taken, other], receiptDate: '2026-09-11' })
  assert.notEqual(lines[0].match?.purchase_id, 'taken')
})

test('deux achats jumeaux : le plus proche en date gagne, égalité parfaite = rien', () => {
  const a = heatSink({ id: 'a', lia_ref: 'LIA-3001', qty_ordered: 30, order_date: '2026-09-01' })
  const b = heatSink({ id: 'b', lia_ref: 'LIA-3002', qty_ordered: 30, order_date: '2026-09-10' })
  let { lines } = matchLines({ items: [heatSinkLine], candidates: [a, b], receiptDate: '2026-09-11' })
  assert.equal(lines[0].match?.purchase_id, 'b')

  const c = heatSink({ id: 'c', lia_ref: 'LIA-3003', qty_ordered: 30, order_date: '2026-09-10' })
  ;({ lines } = matchLines({ items: [heatSinkLine], candidates: [b, c], receiptDate: '2026-09-11' }))
  assert.equal(lines[0].match, null)
  assert.equal(lines[0].review?.reason, 'egalite')
})

// Sticker Mule : « circle stickers » face à « Autocollant … » — le lexique relie les deux,
// la quantité départage.
test('Sticker Mule : stickers = autocollant, la quantité choisit l’achat', () => {
  const fan = candidat({ id: 'fan', lia_ref: 'LIA-2028', part_name: 'Autocollant fan', qty_ordered: 100, pending_reception: true })
  const tens = candidat({ id: 'tens', lia_ref: 'LIA-2027', part_name: 'Autocollant tensiomètre', qty_ordered: 30, pending_reception: true })
  const items = [
    { description: 'Custom 1.97″ × 1.97″ circle stickers — motif vert', quantity: 100, unit_price: 0.73, total: 72.62 },
    { description: 'Custom 1.97″ × 1.97″ circle stickers — motif bleu', quantity: 30, unit_price: 1.38, total: 41.38 },
  ]
  const { lines } = matchLines({ items, candidates: [fan, tens], receiptDate: '2026-09-22' })
  assert.equal(lines[0].match?.lia_ref, 'LIA-2028')
  assert.equal(lines[1].match?.lia_ref, 'LIA-2027')
  assert.equal(lines[0].match.auto, false)
})

test('Dernier recours quantité : un seul achat ouvert à cette quantité → proposé, jamais écrit', () => {
  const a = candidat({ id: 'a', lia_ref: 'LIA-1', part_name: 'Bidule', qty_ordered: 40, pending_reception: true })
  const b = candidat({ id: 'b', lia_ref: 'LIA-2', part_name: 'Machin', qty_ordered: 12, pending_reception: true })
  const { lines } = matchLines({ items: [{ description: 'XQ-77 widget', quantity: 12 }], candidates: [a, b] })
  assert.equal(lines[0].match?.lia_ref, 'LIA-2')
  assert.equal(lines[0].match.auto, false)
  assert.equal(lines[0].match.identity.kind, 'qty')
})

test('Dernier recours quantité : quantité ambiguë ou de 1 → rien', () => {
  const a = candidat({ id: 'a', lia_ref: 'LIA-1', part_name: 'Bidule', qty_ordered: 12, pending_reception: true })
  const b = candidat({ id: 'b', lia_ref: 'LIA-2', part_name: 'Machin', qty_ordered: 12, pending_reception: true })
  const c = candidat({ id: 'c', lia_ref: 'LIA-3', part_name: 'Truc', qty_ordered: 1, pending_reception: true })
  let { lines } = matchLines({ items: [{ description: 'XQ-77 widget', quantity: 12 }], candidates: [a, b] })
  assert.equal(lines[0].match, null)
  ;({ lines } = matchLines({ items: [{ description: 'XQ-77 widget', quantity: 1 }], candidates: [a, c] }))
  assert.equal(lines[0].match, null)
})
