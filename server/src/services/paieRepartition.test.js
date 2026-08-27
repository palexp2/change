import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSplits, allocateByWeights, parseAmount, computeAgaRepartition, PAIE_REPARTITION_DEFAULT_CONFIG } from './paieRepartition.js'

test('parseAmount : virgule décimale et séparateurs de milliers', () => {
  assert.equal(parseAmount('2 737,95'), 2737.95)   // clavier fr-CA + espace fine
  assert.equal(parseAmount('2 737,95 $'), 2737.95)
  assert.equal(parseAmount('2737.95'), 2737.95)
  assert.equal(parseAmount('1.234,56'), 1234.56)
  assert.equal(parseAmount(2737.95), 2737.95)
  assert.equal(parseAmount(''), null)
  assert.equal(parseAmount('abc'), null)
  assert.equal(parseAmount(null), null)
})

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

test('computeAgaRepartition : dépense ventilée, pas de compte d\'assurance', () => {
  // Le montant peut arriver avec une virgule décimale (saisie fr-CA).
  const p = computeAgaRepartition('2 737,95', '2026-08-11')
  assert.equal(p.amount, 2737.95)
  assert.deepEqual(p.warnings, [])
  assert.equal(p.txn_date, '2026-08-11')
  // Toutes les lignes sont des débits dans les comptes de salaires ; la banque
  // n'est pas une ligne (elle est portée par la dépense QB elle-même).
  assert.ok(p.lines.every(l => l.type === 'Debit'))
  assert.equal(p.lines.reduce((s, l) => s + l.amount, 0).toFixed(2), '2737.95')
  assert.ok(!p.lines.some(l => l.acctnum === p.bank_acctnum))
  assert.ok(p.bank_acctnum && p.vendor_name && p.taxcode)
  assert.throws(() => computeAgaRepartition('abc'), /illisible/)
  assert.throws(() => computeAgaRepartition(0), /requis/)
})

test('computeAgaRepartition : reproduit les dépenses QB d\'avril à juillet 2026', () => {
  // Purchases QB 16848 / 17287 / 17519 / 17667 — 2 737,95 $ ventilés à l'identique.
  const p = computeAgaRepartition(2737.95)
  const byAcct = Object.fromEntries(p.lines.map(l => [l.acctnum, l.amount]))
  assert.deepEqual(byAcct, { 62100: 890.86, 62200: 311.78, 62201: 260.11, 62300: 1275.20 })
})

test('config AGA par défaut : banque, fournisseur et code de taxe', () => {
  assert.equal(PAIE_REPARTITION_DEFAULT_CONFIG.aga_source_acctnum, '10000')
  assert.equal(PAIE_REPARTITION_DEFAULT_CONFIG.aga_vendor_name, 'Groupe Financier AGA')
  assert.equal(PAIE_REPARTITION_DEFAULT_CONFIG.aga_taxcode, 'Exonéré')
  assert.equal(PAIE_REPARTITION_DEFAULT_CONFIG.aga_splits, '62100:890.86, 62200:311.78, 62201:260.11, 62300:1275.20')
})

test('allocateByWeights : cas AGA (poids = nb employés assurés)', () => {
  const shares = allocateByWeights(2737.95, parseSplits('62100:2.6, 62200:0.9, 62201:0.8, 62300:3.7'))
  assert.equal(shares[0].amount, 889.83)  // 2737.95 × 2.6/8
  assert.equal(shares.reduce((s, x) => s + x.amount, 0).toFixed(2), '2737.95')
  assert.equal(shares[0].pct, 32.5)
})
