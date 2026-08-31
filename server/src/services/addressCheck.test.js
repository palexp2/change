import test from 'node:test'
import assert from 'node:assert/strict'
import { validateAddress, normalizeCountry, normalizeProvince, formatAddress } from './addressCheck.js'

const VALID = { line1: '1234 rue Principale', city: 'Québec', province: 'QC', postal_code: 'G1V 0B3', country: 'CA' }

const codes = addr => validateAddress(addr).issues.map(i => i.code)

test('une adresse canadienne complète et cohérente passe', () => {
  const out = validateAddress(VALID)
  assert.equal(out.status, 'ok')
  assert.deepEqual(out.issues, [])
})

test('code postal accepté avec ou sans espace, en minuscules', () => {
  assert.equal(validateAddress({ ...VALID, postal_code: 'g1v0b3' }).status, 'ok')
  assert.equal(validateAddress({ ...VALID, postal_code: ' G1V-0B3 ' }).status, 'ok')
})

test('champ obligatoire manquant → erreur ciblée sur le champ', () => {
  assert.deepEqual(codes({ ...VALID, city: '' }), ['city_missing'])
  assert.deepEqual(codes({ ...VALID, line1: '   ' }), ['line1_missing'])
  assert.deepEqual(codes({ ...VALID, postal_code: '' }), ['postal_missing'])
  assert.deepEqual(codes({ ...VALID, province: '' }), ['province_missing'])
  assert.deepEqual(codes({ ...VALID, country: '' }), ['country_missing'])
  assert.equal(validateAddress({ ...VALID, city: '' }).issues[0].field, 'city')
})

test('code postal absent rétrogradé en avertissement quand il n\'est pas exigé', () => {
  const out = validateAddress({ ...VALID, postal_code: '' }, { requirePostalCode: false })
  assert.equal(out.status, 'warning')
  assert.equal(out.issues[0].severity, 'warning')
})

test('valeur bouche-trou détectée comme erreur, pas comme adresse', () => {
  assert.deepEqual(codes({ ...VALID, line1: 'à venir' }), ['line1_placeholder'])
  assert.deepEqual(codes({ ...VALID, line1: 'N/A' }), ['line1_placeholder'])
  assert.deepEqual(codes({ ...VALID, city: 'xxx' }), ['city_placeholder'])
})

test('code postal canadien mal formé → erreur de format', () => {
  for (const pc of ['G1V', 'G1V 0B', '12345', 'D1V 0B3', 'G1V 0B33', 'G1I 0B3']) {
    assert.deepEqual(codes({ ...VALID, postal_code: pc }), ['postal_format'], `attendu invalide : ${pc}`)
  }
})

test('code postal qui ne correspond pas à la province → erreur explicite', () => {
  const out = validateAddress({ ...VALID, province: 'ON' })
  assert.deepEqual(out.issues.map(i => i.code), ['postal_province_mismatch'])
  assert.match(out.issues[0].message, /Québec/)
  // Un code postal ontarien déclaré en Ontario reste valide.
  assert.equal(validateAddress({ ...VALID, province: 'ON', postal_code: 'M5V 2T6' }).status, 'ok')
  // X couvre deux territoires : les deux sont acceptés.
  assert.equal(validateAddress({ ...VALID, province: 'NT', postal_code: 'X1A 1A1' }).status, 'ok')
  assert.equal(validateAddress({ ...VALID, province: 'NU', postal_code: 'X0A 0H0' }).status, 'ok')
})

test('province inexistante → erreur (et pas de faux positif sur le code postal)', () => {
  assert.deepEqual(codes({ ...VALID, province: 'ZZ' }), ['province_invalid'])
  assert.deepEqual(codes({ ...VALID, province: 'QUÉBEC' }), [])
})

test('adresse américaine : ZIP et État validés selon le pays', () => {
  const us = { line1: '1600 Pennsylvania Ave NW', city: 'Washington', province: 'DC', postal_code: '20500', country: 'US' }
  assert.equal(validateAddress(us).status, 'ok')
  assert.equal(validateAddress({ ...us, postal_code: '20500-0003' }).status, 'ok')
  assert.deepEqual(codes({ ...us, postal_code: 'G1V 0B3' }), ['postal_format'])
  // QC n'est pas un État américain.
  assert.deepEqual(codes({ ...us, province: 'QC' }), ['province_invalid'])
})

test('pays non reconnu → erreur, et aucune règle de format appliquée à l\'aveugle', () => {
  assert.deepEqual(codes({ ...VALID, country: 'Belgique' }), ['country_unknown'])
})

test('rue sans numéro civique → avertissement seulement', () => {
  const out = validateAddress({ ...VALID, line1: 'Rang Saint-Joseph' })
  assert.equal(out.status, 'warning')
  assert.deepEqual(out.issues.map(i => i.code), ['line1_no_number'])
})

test('normalisation du pays et de la province', () => {
  assert.equal(normalizeCountry('Canada'), 'CA')
  assert.equal(normalizeCountry(' ca '), 'CA')
  assert.equal(normalizeCountry('États-Unis'), 'US')
  assert.equal(normalizeCountry('USA'), 'US')
  assert.equal(normalizeCountry('Mexique'), '')
  assert.equal(normalizeProvince('québec', 'CA'), 'QC')
  assert.equal(normalizeProvince('Quebec', 'CA'), 'QC')
  assert.equal(normalizeProvince('qc', 'CA'), 'QC')
  assert.equal(normalizeProvince('CA', 'US'), 'CA')
  assert.equal(normalizeProvince('QC', 'US'), '')
})

test('formatAddress reste lisible même sur une adresse vide', () => {
  assert.equal(formatAddress(VALID), '1234 rue Principale, Québec, QC, G1V 0B3, CA')
  assert.equal(formatAddress({}), '(adresse vide)')
})
