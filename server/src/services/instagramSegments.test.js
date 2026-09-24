import { test } from 'node:test'
import assert from 'node:assert/strict'
import { botSignals, isStoryOnly } from './instagramSegments.js'

// Seules les fonctions pures sont testées ici : le reste écrit en base, et la
// base de prod EST la base de test dans ce projet.

test('botSignals : un vrai maraîcher maladroit ne déclenche rien', () => {
  const { score } = botSignals({
    ig_username: 'pleasant_river_produce', full_name: 'Pleasant River Produce',
    text: 'We grow tomatoes in Maine, what would this cost for a 30x96?',
  })
  assert.equal(score, 0)
})

test('botSignals : le démarcheur cumule assez d’indices pour être écarté', () => {
  const { score, reasons } = botSignals({
    ig_username: 'seo_growth_2024891', full_name: null,
    text: 'Hello sir, check my profile, I can boost your followers — t.me/xyz',
  })
  assert.ok(score >= 4, `score trop bas : ${score} (${reasons.join(', ')})`)
})

test('botSignals : une fiche muette seule ne suffit pas à condamner', () => {
  const { score } = botSignals({ ig_username: 'jhall822', full_name: null, text: '' })
  assert.ok(score < 4, `une fiche sans mot ne doit pas atteindre le seuil (${score})`)
})

test('isStoryOnly : la réponse à une story seule sort, accompagnée elle reste', () => {
  const story = { kind: 'story_reply_to', text: '💬 A répondu à une story' }
  assert.equal(isStoryOnly({ incoming: [story] }), true)
  assert.equal(isStoryOnly({ incoming: [story, { kind: 'msgin_instagram', text: 'Do you ship to Vermont?' }] }), false)
  assert.equal(isStoryOnly({ first_comment_text: 'Coach', incoming: [story] }), false)
  assert.equal(isStoryOnly({ incoming: [] }), false)
})

test('botSignals : profil vide + fiche muette reste sous le seuil, bio de vendeur le franchit', () => {
  const empty = { status: 'ok', bio: '', media_count: 0 }
  assert.ok(botSignals({ ig_username: 'jhall', full_name: null, text: '', profile: empty }).score < 4)
  const seller = { status: 'ok', bio: 'Buy real followers & likes 💯 DM for promo', media_count: 3 }
  assert.ok(botSignals({ ig_username: 'jhall', full_name: null, text: '', profile: seller }).score >= 4)
  const farm = { status: 'ok', bio: 'Market garden · flowers & veggies · thanks to our followers', media_count: 80 }
  assert.equal(botSignals({ ig_username: 'farm', full_name: 'Farm', text: 'Nice', profile: farm }).score, 0)
})
