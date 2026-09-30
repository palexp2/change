import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'ai-cost-'))
process.env.DATABASE_PATH = path.join(dir, 'test.db')
delete process.env.OPENAI_ADMIN_KEY
const { default: db } = await import('../db/database.js')
const meter = await import('./aiCostMeter.js')

db.exec(`
  CREATE TABLE ai_usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), provider TEXT NOT NULL, model TEXT NOT NULL,
    feature TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE ai_model_prices (model TEXT PRIMARY KEY, input_per_m REAL, output_per_m REAL, updated_at TEXT);
  CREATE TABLE calls (id TEXT PRIMARY KEY, duration_seconds INTEGER);
  CREATE TABLE transcription_jobs (id TEXT PRIMARY KEY, call_id TEXT, status TEXT, completed_at TEXT);
`)
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('parseAiResponse lit les jetons OpenAI et Gemini, ignore le reste', () => {
  assert.deepEqual(
    meter.parseAiResponse('https://api.openai.com/v1/chat/completions', { model: 'gpt-4o-mini-2024-07-18', usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    { provider: 'openai', model: 'gpt-4o-mini-2024-07-18', usage: { input: 10, output: 5 } })
  assert.deepEqual(
    meter.parseAiResponse('https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent', { usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 2 } }),
    { provider: 'gemini', model: 'gemini-x', usage: { input: 7, output: 5 } })
  assert.equal(meter.parseAiResponse('https://api.openai.com/v1/audio/transcriptions', { text: 'x' }), null)
  assert.equal(meter.normalizeModel('gpt-4o-mini-2024-07-18'), 'gpt-4o-mini')
})

test('le compteur mesure un appel sans altérer la réponse', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ model: 'gpt-4o', usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }), { status: 200 })
  try {
    meter.installAiFetchMeter()
    const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST' })
    assert.equal((await r.json()).model, 'gpt-4o')
    await new Promise(res => setTimeout(res, 20))
  } finally { globalThis.fetch = orig }
  const row = db.prepare(`SELECT * FROM ai_usage_events`).get()
  assert.equal(row.model, 'gpt-4o')
  assert.equal(row.input_tokens, 1_000_000)
  assert.equal(row.feature, 'aiCostMeter.test')
})

test('facture OpenAI répartie par fonctionnalité au prorata des jetons', () => {
  const usage = [
    { feature: 'whisper', model: 'gpt-4o-mini', input: 300, output: 10 },
    { feature: 'relanceEmail', model: 'gpt-4o-mini', input: 100, output: 30 },
  ]
  assert.deepEqual(meter.allocateBilledItem('gpt-4o-mini-2024-07-18, input', 4, usage), { whisper: 3, relanceEmail: 1 })
  assert.deepEqual(meter.allocateBilledItem('gpt-4o-mini-2024-07-18, output', 4, usage), { whisper: 1, relanceEmail: 3 })
  assert.deepEqual(meter.allocateBilledItem('whisper-1', 2, usage), { whisper: 2 })
  assert.deepEqual(meter.allocateBilledItem('gpt-5, input', 2, usage), { __horsErp: 2 })
})

test('rapport : Gemini au prix Google, sans clé admin pas de coût OpenAI', async () => {
  const today = new Date().toISOString().slice(0, 10)
  db.prepare(`DELETE FROM ai_usage_events`).run()
  db.prepare(`INSERT INTO ai_usage_events (provider, model, feature, input_tokens, output_tokens) VALUES ('gemini', 'gemini-3.5-flash-lite', 'textSpellfix', 1000000, 1000000)`).run()
  db.prepare(`INSERT INTO ai_usage_events (provider, model, feature, input_tokens, output_tokens) VALUES ('openai', 'gpt-4o-mini', 'whisper', 5, 5)`).run()
  const r = await meter.aiCostReport({ days: 30 })
  assert.equal(r.days.length, 30)
  assert.equal(r.days.at(-1).date, today)
  assert.ok(Math.abs(r.total - 2.8) < 1e-9)
  assert.equal(r.billing.configured, false)
  assert.equal(r.features.find(f => f.label === 'Autocorrection').cost.toFixed(2), '2.80')
  assert.equal(r.features.find(f => f.label === 'Transcription').cost, 0)
})
