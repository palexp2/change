import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSplits, allocateByWeights } from './paieRepartition.js'

test('parseSplits : format compte:poids, virgules décimales tolérées', () => {
  assert.deepEqual(parseSplits('62100:33.6, 62200:5.1'), [
    { acctnum: '62100', weight: 33.6 },
    { acctnum: '62200', weight: 5.1 },
  ])
  assert.deepEqual(parseSplits('62100:2,6; 62300:3,7'), [
    { acctnum: '62100', weight: 2.6 },
    { acctnum: '62300', weight: 3.7 },
  ])
  assert.throws(() => parseSplits('62100=33'), /illisible|Aucune répartition/)
  assert.throws(() => parseSplits(''), /Aucune répartition/)
})

test('allocateByWeights : parts arrondies, dernière = reste (somme exacte)', () => {
  // Cas réel de l'onglet Salaires : 23 545,19 $ réparti 33,6/5,1/11,8/49,5.
  const shares = allocateByWeights(23545.19, parseSplits('62100:33.6, 62200:5.1, 62201:11.8, 62300:49.5'))
  const sum = shares.reduce((s, x) => s + x.amount, 0)
  assert.equal(Math.round(sum * 100) / 100, 23545.19)
  assert.equal(shares[0].amount, 7911.18) // Marketing — même valeur que le fichier
  assert.equal(shares[1].amount, 1200.8)  // Opérations
  assert.equal(shares[2].amount, 2778.33) // Administration
  // R&D absorbe l'arrondi résiduel.
  assert.equal(shares[3].amount, Math.round((23545.19 - 7911.18 - 1200.8 - 2778.33) * 100) / 100)
})

test('allocateByWeights : cas AGA (poids = nb employés assurés)', () => {
  const shares = allocateByWeights(2737.95, parseSplits('62100:2.6, 62200:0.9, 62201:0.8, 62300:3.7'))
  assert.equal(shares[0].amount, 889.83)  // 2737.95 × 2.6/8
  assert.equal(shares.reduce((s, x) => s + x.amount, 0).toFixed(2), '2737.95')
  assert.equal(shares[0].pct, 32.5)
})
