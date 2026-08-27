import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeVendorKey, strippedVendorKey, findVendorMatch } from './vendorProfiles.js'

test('normalizeVendorKey — minuscules, sans accents ni ponctuation', () => {
  assert.equal(normalizeVendorKey('Bell (Internet)'), 'bellinternet')
  assert.equal(normalizeVendorKey('Antoine Létourneau '), 'antoineletourneau')
  assert.equal(normalizeVendorKey('McMaster- Carr'), 'mcmastercarr')
  assert.equal(normalizeVendorKey(null), '')
})

test('strippedVendorKey — suffixes légaux retirés, jamais au point de vider la clé', () => {
  assert.equal(strippedVendorKey('Anthropic, PBC'), 'anthropic')
  assert.equal(strippedVendorKey('Sticker Mule, LLC'), 'stickermule')
  assert.equal(strippedVendorKey('ByteDance Pte. Ltd.'), 'bytedance')
  assert.equal(strippedVendorKey('Wix.com LTD'), 'wixcom')
  assert.equal(strippedVendorKey('Twilio, Inc.'), 'twilio')
  assert.equal(strippedVendorKey('PERFECT TAPE ENTERPRISE CO., LIMITED'), 'perfecttapeenterprise')
  // Suffixe au milieu du nom : intouché (seuls les suffixes de FIN sont retirés)
  assert.equal(strippedVendorKey('Co Op Fédérée'), 'coopfederee')
  // Nom réduit à un sigle trop court après retrait → repli sur la clé complète
  assert.equal(strippedVendorKey('GM Corp'), 'gmcorp')
  assert.equal(strippedVendorKey(null), '')
})

test('findVendorMatch — exact à la normalisation près, jamais partiel', () => {
  const vendors = [{ name: 'Adafruit' }, { name: 'Bell (Internet)' }, { name: 'Antoine Létourneau' }]

  assert.equal(findVendorMatch('adafruit', vendors)?.name, 'Adafruit')
  assert.equal(findVendorMatch('ANTOINE LETOURNEAU', vendors)?.name, 'Antoine Létourneau')
  assert.equal(findVendorMatch('Bell Internet', vendors)?.name, 'Bell (Internet)')

  // Pas de match partiel : « Adafruit Industries LLC » ≠ « Adafruit » (le fuzzy
  // est délégué au modèle d'extraction, qui reçoit les noms canoniques en contexte)
  assert.equal(findVendorMatch('Adafruit Industries LLC', vendors), null)
  assert.equal(findVendorMatch('', vendors), null)
  assert.equal(findVendorMatch(null, vendors), null)
})
