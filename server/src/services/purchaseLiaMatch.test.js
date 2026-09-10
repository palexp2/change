// Rattachement « ligne de facture fournisseur ↔ achat LIA ». Depuis la migration
// 035 (suppression définitive des champs Airtable gérés en code des achats), il
// n'y a plus de scoring : la pièce, la quantité, le prix et les dates d'un achat
// n'existent plus en colonne, donc plus aucun signal à comparer. Ce qui reste, et
// que ces tests couvrent : le libellé LIA, la reconnaissance du fournisseur, et
// le fait que rien ne soit JAMAIS proposé ni réécrit d'office.
import test from 'node:test'
import assert from 'node:assert'
import {
  buildLiaLabel, completeLiaDescription, normalizeVendorKey, sameVendor,
  matchLines, autoLinkReceiptItems, candidateTier, hasLiaRef,
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

test('code LIA seul : le nom ne se retrouve plus (colonne pièce droppée)', () => {
  assert.equal(completeLiaDescription('LIA-1961'), 'LIA-1961')
  assert.equal(completeLiaDescription('  lia-1961  '), 'LIA-1961')
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
  assert.deepEqual(lines[0].candidates, [])
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
