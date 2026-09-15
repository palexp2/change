import { test } from 'node:test'
import assert from 'node:assert/strict'
import { postInvolvesUs } from './instagramCommentScrape.js'

const ours = new Set(['orisha_auto'])

test('publication du partenaire seul : écartée', () => {
  assert.equal(postInvolvesUs({ user: { username: 'growingformarketmagazine' } }, ours), false)
})

test('notre publication : retenue', () => {
  assert.equal(postInvolvesUs({ user: { username: 'orisha_auto' } }, ours), true)
})

test('collab — nous co-auteur chez le partenaire : retenue', () => {
  assert.equal(postInvolvesUs({
    user: { username: 'growingformarketmagazine' },
    coauthor_producers: [{ username: 'orisha_auto' }],
  }, ours), true)
})

test('collab non encore acceptée : retenue aussi', () => {
  assert.equal(postInvolvesUs({
    user: { username: 'growingformarketmagazine' },
    invited_coauthor_producers: [{ username: 'Orisha_Auto' }],
  }, ours), true)
})

test('aucun compte configuré : aucun filtre', () => {
  assert.equal(postInvolvesUs({ user: { username: 'nimporte_qui' } }, new Set()), true)
})
