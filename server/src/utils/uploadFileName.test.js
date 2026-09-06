import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUploadName, repairLatin1Mojibake } from './uploadFileName.js'

test('redécode un nom UTF-8 lu en latin1', () => {
  const vrai = 'Capture d’écran, le 2026-09-04 à 09.49.27.png'
  const abîmé = Buffer.from(vrai, 'utf8').toString('latin1')
  assert.notEqual(abîmé, vrai)
  assert.equal(repairLatin1Mojibake(abîmé), vrai)
})

test('laisse intact un nom déjà correct', () => {
  for (const nom of ['Café.png', 'facture 2026.pdf', 'reçu — août.pdf', '発注書.pdf', '']) {
    assert.equal(normalizeUploadName(nom), nom.normalize('NFC'))
  }
})

test('ramène les accents décomposés (macOS) en NFC', () => {
  const nfd = 'e\u0301te\u0301.png' // « été » décomposé, comme l'envoie macOS
  assert.notEqual(nfd, 'été.png')
  assert.equal(normalizeUploadName(nfd), 'été.png')
})

test('tolère les valeurs absentes', () => {
  assert.equal(normalizeUploadName(null), null)
  assert.equal(normalizeUploadName(undefined), undefined)
})
