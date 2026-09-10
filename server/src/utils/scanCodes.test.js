import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseScanCodes, normalizeScanCodes, matchesScanCode, addScanCode } from './scanCodes.js'

test('parseScanCodes — virgules, points-virgules, retours de ligne', () => {
  assert.deepEqual(parseScanCodes('X004XVENE7'), ['X004XVENE7'])
  assert.deepEqual(parseScanCodes(' A1 , B2 ;\nC3 '), ['A1', 'B2', 'C3'])
  assert.deepEqual(parseScanCodes(''), [])
  assert.deepEqual(parseScanCodes(null), [])
})

test('normalizeScanCodes — dédoublonne sans tenir compte de la casse', () => {
  assert.equal(normalizeScanCodes('A1, a1 , B2'), 'A1, B2')
  assert.equal(normalizeScanCodes('  ,  '), null)
})

test('matchesScanCode — insensible à la casse et aux espaces', () => {
  assert.equal(matchesScanCode('X004XVENE7, 12345', 'x004xvene7'), true)
  assert.equal(matchesScanCode('X004XVENE7, 12345', ' 12345 '), true)
  assert.equal(matchesScanCode('X004XVENE7', '004XVENE'), false)
  assert.equal(matchesScanCode(null, 'X004XVENE7'), false)
  assert.equal(matchesScanCode('X004XVENE7', ''), false)
})

test('addScanCode — ajoute une fois, jamais en double', () => {
  assert.equal(addScanCode(null, 'X004XVENE7'), 'X004XVENE7')
  assert.equal(addScanCode('12345', 'X004XVENE7'), '12345, X004XVENE7')
  assert.equal(addScanCode('12345, X004XVENE7', 'x004xvene7'), '12345, X004XVENE7')
})
