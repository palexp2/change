import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptCorrection } from './textSpellfix.js'

test('accepte une correction de fautes', () => {
  assert.equal(acceptCorrection('Ajoute un boutton ici', 'Ajoute un bouton ici'), 'Ajoute un bouton ici')
})

test('garde les blancs de début et de fin de la saisie', () => {
  assert.equal(acceptCorrection('  la page es lente ', 'La page est lente'), '  La page est lente ')
})

test('refuse une reformulation qui change beaucoup la longueur', () => {
  const src = 'corrige le bug'
  assert.equal(acceptCorrection(src, 'Bien sûr ! Voici comment corriger le bogue dans votre application.'), src)
})

test('refuse une réponse vide ou absente', () => {
  assert.equal(acceptCorrection('texte', ''), 'texte')
  assert.equal(acceptCorrection('texte', undefined), 'texte')
})

test('retire les guillemets ajoutés par le modèle', () => {
  assert.equal(acceptCorrection('ajoute un filtre', '« Ajoute un filtre »'), 'Ajoute un filtre')
})
