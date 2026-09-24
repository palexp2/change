import { test } from 'node:test'
import assert from 'node:assert/strict'
import { arrivalOf } from './instagramProfiles.js'

test('arrivalOf : dit en une ligne comment la personne est arrivée', () => {
  const c = arrivalOf({ first_comment_text: 'Those plants look so healthy', first_comment_at: '2026-09-17T12:00:00Z', first_post_url: 'https://www.instagram.com/p/X/' })
  assert.match(c.text, /^A commenté le 17 sept\. : « Those plants/)
  assert.equal(c.url, 'https://www.instagram.com/p/X/')
  assert.equal(arrivalOf({ capture_label: '💬 A répondu à une story' }).text, 'Réponse à une story')
  assert.equal(arrivalOf({ capture_label: '👤 Aucune activité' }).text, 'Abonnée, n’a rien écrit')
  assert.equal(arrivalOf({ capture_label: '💬 A écrit : « Tomato »' }).text, 'Écrit en DM : « Tomato »')
  assert.equal(arrivalOf({ capture_label: '📝 A commenté « Coach »' }).text, 'A commenté : « Coach »')
})
