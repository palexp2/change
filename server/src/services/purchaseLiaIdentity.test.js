// Sur QUOI repose l'identification « ligne de facture ↔ pièce Airtable ».
//
// Le nom Orisha d'une pièce n'est presque jamais celui imprimé par le fournisseur, et le
// coût unitaire d'Airtable est une moyenne : ni l'un ni l'autre ne prouve quoi que ce
// soit à l'œil. Ces tests fixent ce que `scoreLine` déclare comme preuve — c'est ce que
// la fiche reçu affiche à la place de la comparaison de libellés.
import test from 'node:test'
import assert from 'node:assert/strict'
import { scoreLine } from './purchaseLiaMatch.js'

const PART = {
  id: 'p1', lia_ref: 'LIA-1870', part_name: 'TOGGLE FULL BOOT BLACK RUBBER',
  part_sku: 'ORI-1030', part_mpn: '759D02000', part_refs: ['759d02000'], qty_ordered: 187, unit_cost: 1.2,
  linked_receipts: [],
}

test('référence fabricant imprimée sur la facture = identification certaine', () => {
  const line = { description: 'Composants C&K, Part Number: 759D02000', quantity: 187 }
  const { identity } = scoreLine(line, PART, {})
  assert.equal(identity.kind, 'ref')
  assert.equal(identity.label, '759D02000')
})

test('SKU alphanumérique présent dans la description', () => {
  const line = { description: 'ORI-1030 sealing boot', quantity: 187 }
  const { identity } = scoreLine(line, { ...PART, part_mpn: null, part_refs: [] }, {})
  assert.equal(identity.kind, 'sku')
  assert.equal(identity.label, 'ORI-1030')
})

test('libellé déjà employé par ce fournisseur pour cette pièce (vocabulaire appris)', () => {
  const aliasesByPart = new Map([['toggle full boot black rubber', ['SEALING BOOT H*']]])
  const line = { description: 'SEALING BOOT H*', quantity: 187 }
  const { identity } = scoreLine(line, { ...PART, part_mpn: null, part_sku: null, part_refs: [] }, { aliasesByPart })
  assert.equal(identity.kind, 'alias')
  assert.equal(identity.label, 'SEALING BOOT H*')
})

test('libellé proche du nom de la pièce, à défaut de mieux', () => {
  const line = { description: 'TOGGLE BOOT RUBBER BLACK', quantity: 187 }
  const { identity } = scoreLine(line, { ...PART, part_mpn: null, part_sku: null, part_refs: [] }, {})
  assert.equal(identity.kind, 'name')
  assert.ok(identity.score > 0.3)
})

test('rien ne relie la ligne à la pièce', () => {
  const line = { description: 'MoKo MagSafe Tripod Mount', quantity: 187 }
  const { identity, score } = scoreLine(line, { ...PART, part_mpn: null, part_sku: null, part_refs: [] }, {})
  assert.equal(identity.kind, 'none')
  assert.equal(score, 0)
})

test('un prix unitaire très différent n’empêche pas l’identification', () => {
  // Le coût Airtable (moyenne) est à 1,20 $, la facture à 1,838 $ : sans importance
  // dès lors que la référence identifie la pièce.
  const line = { description: 'Part Number: 759D02000', quantity: 187, unit_price: 1.838 }
  const { identity, score } = scoreLine(line, PART, {})
  assert.equal(identity.kind, 'ref')
  assert.ok(score > 0.5)
})
