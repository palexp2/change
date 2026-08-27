// Conversion de devise d'une facture (onglet « USD_CAD » du sheet CTB - Suivi).
// Exécution : `node --test client/src/lib/currencyConversion.test.js`
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeConversion, conversionSpreadPct, parseAmount, round2 } from './currencyConversion.js'

test('saisie FR : la virgule décimale est acceptée', () => {
  assert.equal(parseAmount('196,14'), 196.14)
  assert.equal(parseAmount('196.14'), 196.14)
  assert.equal(parseAmount('0,5'), 0.5)
  assert.equal(parseAmount(',5'), 0.5)
})

test('séparateurs de milliers : espace, point ou virgule', () => {
  assert.equal(parseAmount('1 196,14'), 1196.14)   // FR
  assert.equal(parseAmount('1 196.14'), 1196.14)
  assert.equal(parseAmount('1,196.14'), 1196.14)   // EN
  assert.equal(parseAmount('1.196,14'), 1196.14)   // EU
  assert.equal(parseAmount('1 234 567,89'), 1234567.89)
  assert.equal(parseAmount('1,196'), 1196)         // ambigu → milliers
  assert.equal(parseAmount('1,196,200'), 1196200)
})

test('symboles de devise, espaces et signe', () => {
  assert.equal(parseAmount(' 196,14 $ '), 196.14)
  assert.equal(parseAmount('135,45 USD'), 135.45)
  assert.equal(parseAmount('-12,50'), -12.5)
  assert.equal(parseAmount(196.14), 196.14)
})

test('saisie vide ou non numérique → null', () => {
  assert.equal(parseAmount(''), null)
  assert.equal(parseAmount(null), null)
  assert.equal(parseAmount('abc'), null)
  assert.equal(parseAmount('12abc'), null)
})

test('les montants avec virgule traversent tout le calcul', () => {
  const r = computeConversion({ subtotal: '135,45', tps: '', tvq: '', targetTotal: '196,14' })
  assert.equal(r.ok, true)
  assert.equal(r.sourceTotal, 135.45)
  assert.equal(r.targetTotal, 196.14)
  assert.equal(r.lines.subtotal, 196.14)
})

test('cas Circle : facture 135,45 USD, carte débitée 196,14 CAD', () => {
  const r = computeConversion({ subtotal: 135.45, tps: 0, tvq: 0, targetTotal: 196.14 })
  assert.equal(r.ok, true)
  assert.equal(round2(r.rate * 10000) / 10000, round2((196.14 / 135.45) * 10000) / 10000)
  assert.equal(r.targetTotal, 196.14)
  assert.equal(r.lines.subtotal, 196.14)
  assert.equal(r.control, 0)
})

test('exemple du sheet : 249,90 ventilé en 238,00 + 11,90 de TPS', () => {
  const r = computeConversion({ subtotal: 238, tps: 11.9, tvq: 0, total: 249.9, targetTotal: 135.45 })
  assert.equal(r.ok, true)
  assert.equal(r.lines.subtotal, 129)
  assert.equal(r.lines.tps, 6.45)
  assert.equal(r.lines.tvq, 0)
  assert.equal(round2(r.lines.subtotal + r.lines.tps), 135.45)
  assert.equal(r.control, 0)
})

test('la ventilation retombe TOUJOURS au cent près sur le montant débité', () => {
  const r = computeConversion({ subtotal: 100.01, tps: 5, tvq: 9.98, targetTotal: 200 })
  assert.equal(r.lines.subtotal + r.lines.tps + r.lines.tvq, 200)
  assert.equal(r.control, 0)
  assert.ok(Math.abs(r.adjustment) <= 0.03) // résidu d'arrondi seulement
})

test('total omis → déduit de la somme des composantes', () => {
  const r = computeConversion({ subtotal: 100, tps: 5, tvq: 9.98, targetTotal: 160 })
  assert.equal(r.sourceTotal, 114.98)
  assert.equal(r.ok, true)
})

test('taux fourni au lieu du montant débité → montant cible projeté', () => {
  const r = computeConversion({ subtotal: 100, tps: 5, tvq: 9.98, rate: 1.38 })
  assert.equal(r.targetTotal, round2(114.98 * 1.38))
  assert.equal(r.control, 0)
  assert.equal(r.rate, 1.38)
})

test('les taxes converties restent le produit exact de leur base par le taux', () => {
  const r = computeConversion({ subtotal: 238, tps: 11.9, targetTotal: 500 })
  assert.equal(r.lines.tps, round2(11.9 * r.rate))
})

test('entrées invalides', () => {
  assert.match(computeConversion({ subtotal: 0, targetTotal: 100 }).error, /total de la facture/i)
  assert.match(computeConversion({ subtotal: 100, targetTotal: 0 }).error, /montant débité/i)
  assert.match(computeConversion({ subtotal: 100 }).error, /montant débité ou un taux/i)
  assert.match(computeConversion({ subtotal: 100, rate: -2 }).error, /montant débité ou un taux/i)
})

test('écart au taux du marché = commission de conversion de la carte', () => {
  assert.equal(conversionSpreadPct(1.448, 1.38), 4.93)
  assert.equal(conversionSpreadPct(1.38, 1.38), 0)
  assert.equal(conversionSpreadPct(1.38, null), null)
})
