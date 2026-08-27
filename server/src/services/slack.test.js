// Voie bot token de sendSlack : précédence et résolution des cibles.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendSlack, resolveSlackChannelId, clearSlackChannelCache } from './slack.js'

function mockFetch(handler) {
  const original = global.fetch
  global.fetch = handler
  return () => { global.fetch = original }
}

test('un canal nommé passe par chat.postMessage quand le bot token existe', async () => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test'
  clearSlackChannelCache()
  const calls = []
  const restore = mockFetch(async (url, opts) => {
    calls.push({ url, body: Object.fromEntries(new URLSearchParams(opts.body)) })
    return { ok: true, json: async () => ({ ok: true }) }
  })
  try {
    const res = await sendSlack({ channel: 'C0123456', text: 'coucou', envName: 'SLACK_WEBHOOK_ABSENT' })
    assert.equal(res.sent, true)
    assert.equal(res.via, 'bot')
    assert.equal(res.fallback, false)
    assert.match(calls[0].url, /chat\.postMessage$/)
    assert.equal(calls[0].body.channel, 'C0123456')
  } finally { restore(); delete process.env.SLACK_BOT_TOKEN }
})

test('sans bot token, le webhook reste utilisé', async () => {
  delete process.env.SLACK_BOT_TOKEN
  process.env.SLACK_WEBHOOK_TEST_X = 'https://hooks.slack.com/services/X'
  const restore = mockFetch(async () => ({ ok: true, json: async () => ({}) }))
  try {
    const res = await sendSlack({ channel: '#support', envName: 'SLACK_WEBHOOK_TEST_X', text: 'coucou' })
    assert.equal(res.via, 'webhook')
    assert.equal(res.env, 'SLACK_WEBHOOK_TEST_X')
  } finally { restore(); delete process.env.SLACK_WEBHOOK_TEST_X }
})

test('un courriel est résolu en identifiant d\'utilisateur (DM implicite)', async () => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test'
  clearSlackChannelCache()
  const seen = []
  const restore = mockFetch(async (url) => {
    seen.push(url.split('/').pop())
    return { ok: true, json: async () => ({ ok: true, user: { id: 'U9' } }) }
  })
  try {
    // Pas de conversations.open : chat.postMessage vers « U9 » ouvre le DM seul,
    // ce qui évite d'exiger le scope im:write.
    assert.equal(await resolveSlackChannelId('philippe@orisha.io'), 'U9')
    assert.deepEqual(seen, ['users.lookupByEmail'])
    // Second appel : servi par le cache, aucun appel réseau de plus.
    assert.equal(await resolveSlackChannelId('philippe@orisha.io'), 'U9')
    assert.equal(seen.length, 1)
  } finally { restore(); delete process.env.SLACK_BOT_TOKEN }
})

test('une erreur Slack remonte plutôt que de partir au mauvais endroit', async () => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test'
  clearSlackChannelCache()
  const restore = mockFetch(async () => ({ ok: true, json: async () => ({ ok: false, error: 'channel_not_found' }) }))
  try {
    await assert.rejects(() => sendSlack({ channel: 'C0000001', text: 'x' }), /channel_not_found/)
  } finally { restore(); delete process.env.SLACK_BOT_TOKEN }
})
