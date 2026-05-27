import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  generateShortToken,
  normalizeShortToken,
  formatShortTokenForDisplay,
} from './shortToken.js'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

test('generateShortToken — longueur par défaut 10 et alphabet Crockford', () => {
  const t = generateShortToken()
  assert.equal(t.length, 10)
  for (const c of t) assert.ok(ALPHABET.includes(c), `char ${c} hors alphabet`)
})

test('generateShortToken — longueur configurable', () => {
  assert.equal(generateShortToken(6).length, 6)
  assert.equal(generateShortToken(16).length, 16)
})

test('generateShortToken — entropie suffisante (pas de collisions sur 1000 tirages)', () => {
  const seen = new Set()
  for (let i = 0; i < 1000; i++) seen.add(generateShortToken())
  assert.equal(seen.size, 1000)
})

test('normalizeShortToken — uppercase et retire tirets/espaces', () => {
  assert.equal(normalizeShortToken('ab12-cde3-4f'), 'AB12CDE34F')
  assert.equal(normalizeShortToken('AB 12 CD E3 4F'), 'AB12CDE34F')
})

test('normalizeShortToken — corrige confusions Crockford', () => {
  assert.equal(normalizeShortToken('O01l'), '0011')
  assert.equal(normalizeShortToken('iIlLoO'), '111100')
  assert.equal(normalizeShortToken('uU'), 'VV')
})

test('normalizeShortToken — vide ou null retourne ""', () => {
  assert.equal(normalizeShortToken(''), '')
  assert.equal(normalizeShortToken(null), '')
  assert.equal(normalizeShortToken(undefined), '')
})

test('formatShortTokenForDisplay — groupes de 4', () => {
  assert.equal(formatShortTokenForDisplay('AB12CDE34F'), 'AB12-CDE3-4F')
  assert.equal(formatShortTokenForDisplay('ABCD'), 'ABCD')
  assert.equal(formatShortTokenForDisplay('ABCDEFGH'), 'ABCD-EFGH')
})
