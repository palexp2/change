// Lecture IA de la facture entière : la réponse est filtrée (achats connus, un achat par
// facture, confiance minimale) et matchLines s'en sert sans lâcher ses garde-fous.
import test from 'node:test'
import assert from 'node:assert'
import { buildLiaPrompt, parseLiaAnswer } from './purchaseLiaAi.js'
import { matchLines, partRefs } from './purchaseLiaMatch.js'

const pi = { id: 'p1', lia_ref: 'LIA-2002', part_name: 'Raspberry Pi 4B', qty_ordered: '1.0', pending_reception: true, linked_receipts: [] }
const fuse = { id: 'p2', lia_ref: 'LIA-2001', part_name: 'Fusible 4A', qty_ordered: '10.0', pending_reception: true, linked_receipts: [] }
const items = [
  { description: 'SBC QUAD CORE 2GB RAM BCM2711', quantity: 1, unit_price: 70, total: 70 },
  { description: 'Shipping', quantity: 1, total: 12 },
]

test('prompt : toute la facture et les indices de chaque achat', () => {
  const p = buildLiaPrompt({ receipt: { company: 'Digikey', notes: 'Commande 123' }, items, candidates: [{ ...pi, po_part_ref: '2648-SC0193(9)-ND' }] })
  assert.match(p, /#0 « SBC QUAD CORE/)
  assert.match(p, /#1 « Shipping/)
  assert.match(p, /n° distributeur 2648-SC0193\(9\)-ND/)
  assert.match(p, /Notes : Commande 123/)
})

test('réponse : achats inconnus, doute et doublons écartés', () => {
  const text = JSON.stringify({ lines: [
    { line: 0, lia: 'lia-2002', confidence: 0.82, clues: '2GB, BCM2711 = Pi 4' },
    { line: 1, lia: 'LIA-2002', confidence: 0.7 },  // même achat : la plus sûre gagne
    { line: 1, lia: 'LIA-9999', confidence: 0.99 }, // achat hors liste
    { line: 5, lia: 'LIA-2001', confidence: 0.99 }, // ligne inexistante
  ] })
  const m = parseLiaAnswer(text, { items, candidates: [pi, fuse] })
  assert.deepEqual([...m.keys()], [0])
  assert.equal(m.get(0).lia_ref, 'LIA-2002')
  assert.equal(parseLiaAnswer('pas du json', { items, candidates: [pi] }).size, 0)
  assert.equal(parseLiaAnswer(JSON.stringify({ lines: [{ line: 0, lia: 'LIA-2002', confidence: 0.4 }] }), { items, candidates: [pi] }).size, 0)
})

test('matchLines : la lecture IA propose là où les libellés ne se ressemblent pas', () => {
  const without = matchLines({ items, candidates: [pi, fuse] })
  assert.equal(without.lines[0].match, null)
  const aiPicks = new Map([[0, { lia_ref: 'LIA-2002', confidence: 0.95, clues: '2GB, BCM2711' }]])
  const { lines } = matchLines({ items, candidates: [pi, fuse], aiPicks })
  assert.equal(lines[0].match.lia_ref, 'LIA-2002')
  assert.equal(lines[0].match.identity.kind, 'ai')
  // Très sûre + quantité identique : écrit d'office.
  assert.equal(lines[0].match.auto, true)
  assert.equal(lines[1].match, null)
})

test('matchLines : quantité différente → proposition seulement', () => {
  const aiPicks = new Map([[0, { lia_ref: 'LIA-2001', confidence: 0.95, clues: 'x' }]])
  const { lines } = matchLines({ items, candidates: [pi, fuse], aiPicks })
  assert.equal(lines[0].match.lia_ref, 'LIA-2001')
  assert.equal(lines[0].match.auto, false)
})

test('matchLines : une référence fabricant identifiée prime sur l\'IA', () => {
  const withRef = { ...pi, part_refs: ['bcm2711'] }
  const aiPicks = new Map([[0, { lia_ref: 'LIA-2001', confidence: 0.95, clues: 'x' }]])
  const { lines } = matchLines({ items, candidates: [withRef, fuse], aiPicks })
  assert.equal(lines[0].match.lia_ref, 'LIA-2002')
})

test('matchLines : jamais un achat déjà facturé ni d\'un autre fournisseur', () => {
  const aiPicks = new Map([[0, { lia_ref: 'LIA-2002', confidence: 0.95, clues: 'x' }]])
  for (const c of [{ ...pi, already_expensed: true }, { ...pi, other_vendor: true }]) {
    assert.equal(matchLines({ items, candidates: [c, fuse], aiPicks }).lines[0].match, null)
  }
})

test('références : n° distributeur de l\'achat, son lien et les liens de ses notes', () => {
  const refs = partRefs({ po_part_ref: '2648-SC0193(9)-ND', notes: 'à tester\nhttps://www.digikey.ca/en/products/detail/raspberry-pi/SC0193-13/29190229' })
  assert.ok(refs.includes('2648sc01939nd'))
  assert.ok(refs.includes('sc019313'))
  assert.ok(refs.includes('29190229'))
})
