// Suffixe de période sur les lignes d'articles : « Abonnement Slack — juillet 2026 ».
// Filet déterministe derrière le prompt (l'IA remplit service_period mais oublie
// souvent d'annoter les lignes).

import test from 'node:test'
import assert from 'node:assert/strict'

const { annotateItemsWithPeriod } = await import('./saleReceiptExtraction.js')

test('suffixe la période sur chaque ligne', () => {
  const out = annotateItemsWithPeriod(
    [{ description: 'Abonnement Slack', total: 100 }, { description: 'Frais de service', total: 5 }],
    'juillet 2026',
  )
  assert.deepEqual(out.map(i => i.description), ['Abonnement Slack — juillet 2026', 'Frais de service — juillet 2026'])
  assert.equal(out[0].total, 100)
})

test('ligne mentionnant déjà la période : inchangée', () => {
  const out = annotateItemsWithPeriod([{ description: 'Slack — Juillet 2026' }], 'juillet 2026')
  assert.equal(out[0].description, 'Slack — Juillet 2026')
  // Accents/ponctuation ignorés à la comparaison.
  assert.equal(annotateItemsWithPeriod([{ description: 'Forfait aout 2026' }], 'août 2026')[0].description, 'Forfait aout 2026')
})

test('ligne qui porte déjà sa propre période : pas de 2e période empilée', () => {
  const out = annotateItemsWithPeriod(
    [{ description: 'Prorata — 15 juil. – 31 juil. 2026' }, { description: 'Mois d’avance' }],
    'juillet–août 2026',
  )
  assert.equal(out[0].description, 'Prorata — 15 juil. – 31 juil. 2026')
  assert.equal(out[1].description, 'Mois d’avance — juillet–août 2026')
})

test('sans période ou sans articles : tableau inchangé', () => {
  const items = [{ description: 'Câble HDMI' }]
  assert.equal(annotateItemsWithPeriod(items, null), items)
  assert.equal(annotateItemsWithPeriod(items, '  '), items)
  assert.deepEqual(annotateItemsWithPeriod([], 'juillet 2026'), [])
  assert.deepEqual(annotateItemsWithPeriod(null, 'juillet 2026'), [])
})

test('ligne sans description : intouchée', () => {
  const out = annotateItemsWithPeriod([{ total: 10 }, { description: '  ', total: 5 }], 'juillet 2026')
  assert.equal(out[0].description, undefined)
  assert.equal(out[1].description, '  ')
})

// Description principale : la période s'y intègre (« … — juillet 2026 ») au lieu de
// vivre dans un champ séparé — c'est cette phrase qui devient le mémo QuickBooks.
const { annotateDescriptionWithPeriod } = await import('./saleReceiptExtraction.js')

test('description principale : période intégrée en suffixe', () => {
  assert.equal(annotateDescriptionWithPeriod('Abonnement téléphonie IP', 'juillet 2026'), 'Abonnement téléphonie IP — juillet 2026')
})

test('description mentionnant déjà la période ou une date : inchangée', () => {
  assert.equal(annotateDescriptionWithPeriod('Téléphonie — Juillet 2026', 'juillet 2026'), 'Téléphonie — Juillet 2026')
  assert.equal(annotateDescriptionWithPeriod('Licences août 2026', 'juillet 2026'), 'Licences août 2026')
})

test('sans période ou sans description : valeur d\'origine (null si vide)', () => {
  assert.equal(annotateDescriptionWithPeriod('Pièces de plomberie', null), 'Pièces de plomberie')
  assert.equal(annotateDescriptionWithPeriod(null, 'juillet 2026'), null)
})
