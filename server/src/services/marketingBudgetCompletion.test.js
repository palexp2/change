import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Base éphémère et Slack simulé : aucun envoi ni donnée de production.
const testDir = mkdtempSync(join(tmpdir(), 'erp-marketing-completion-'))
process.env.DATABASE_PATH = join(testDir, 'test.db')
const { default: db } = await import('../db/database.js')
const { checkWeeklyMarketingSlack, previewWeeklyMarketingSlack, EMILIE_RECURRING_TASK_ID } = await import('./marketingBudget.js')

db.exec(`
  CREATE TABLE automations (id TEXT PRIMARY KEY, system INTEGER, active INTEGER, action_config TEXT, last_run_at TEXT, last_run_status TEXT);
  CREATE TABLE automation_logs (id TEXT PRIMARY KEY, automation_id TEXT, status TEXT, trigger_data TEXT, result TEXT, error TEXT, duration_ms INTEGER);
  CREATE TABLE marketing_expenses (id TEXT PRIMARY KEY, status TEXT, notified_at TEXT, deleted_at TEXT, txn_date TEXT, vendor TEXT, updated_at TEXT);
  CREATE TABLE recurring_tasks (id TEXT PRIMARY KEY, cadence TEXT, active INTEGER, deleted_at TEXT, period_offset INTEGER);
  CREATE TABLE recurring_task_completions (id TEXT PRIMARY KEY, task_id TEXT, period_key TEXT, done_by TEXT, note TEXT, source TEXT, UNIQUE(task_id, period_key));
`)
const originalFetch = globalThis.fetch
let sends
beforeEach(() => {
  db.exec(`DELETE FROM automations; DELETE FROM automation_logs; DELETE FROM marketing_expenses; DELETE FROM recurring_tasks; DELETE FROM recurring_task_completions;
    INSERT INTO automations (id, system, active, action_config) VALUES ('sys_marketing_weekly_slack', 1, 1, '{"slack_webhook_env":"TEST_MARKETING_SLACK"}');`)
  db.prepare('INSERT INTO recurring_tasks VALUES (?, ?, 1, NULL, 0)').run(EMILIE_RECURRING_TASK_ID, 'hebdo')
  process.env.TEST_MARKETING_SLACK = 'https://slack.invalid/test'
  sends = 0
  globalThis.fetch = async url => {
    assert.equal(url, process.env.TEST_MARKETING_SLACK)
    sends++
    return { ok: true }
  }
})
after(() => {
  globalThis.fetch = originalFetch
  delete process.env.TEST_MARKETING_SLACK
  db.close()
  rmSync(testDir, { recursive: true, force: true })
})
const send = () => checkWeeklyMarketingSlack({ force: true, today: '2026-09-15' })
const completions = () => db.prepare('SELECT * FROM recurring_task_completions').all()

test('envoi manuel réussi : coche la semaine courante et confirme le résultat', async () => {
  const out = await send()
  assert.equal(out.sent, true)
  assert.equal(sends, 1)
  assert.deepEqual(out.completion, { task_id: EMILIE_RECURRING_TASK_ID, period_key: '2026-W38', created: true, done: true })
  assert.equal(completions()[0].source, 'auto')
  assert.match(db.prepare('SELECT result FROM automation_logs').get().result, /travail récurrent coché/)
})

test('nouvel envoi : conserve le cochage humain existant', async () => {
  db.prepare('INSERT INTO recurring_task_completions VALUES (?, ?, ?, ?, ?, NULL)').run('human', EMILIE_RECURRING_TASK_ID, '2026-W38', 'antoine', 'Fait')
  const before = completions()
  const out = await send()
  assert.equal(out.completion.done, true)
  assert.equal(out.completion.created, false)
  assert.deepEqual(completions(), before)
})

test('échec Slack : aucune tâche cochée', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503 })
  const out = await send()
  assert.match(out.error, /Slack HTTP 503/)
  assert.equal(completions().length, 0)
})

test('aperçu et automation désactivée : aucun envoi ni cochage', async () => {
  previewWeeklyMarketingSlack()
  db.exec('UPDATE automations SET active=0')
  // L'envoi manuel (force) passe outre l'interrupteur ; seul le passage planifié est bloqué.
  assert.equal((await checkWeeklyMarketingSlack({ today: '2026-09-15' })).skipped, 'inactive')
  assert.equal(sends, 0)
  assert.equal(completions().length, 0)
})

test('tâche désactivée : envoi réussi, avertissement visible et journalisé', async () => {
  db.exec('UPDATE recurring_tasks SET active=0')
  const out = await send()
  assert.equal(out.sent, true)
  assert.equal(out.completion.done, false)
  assert.match(out.completion.warning, /absente ou désactivée/)
  assert.equal(completions().length, 0)
  assert.match(db.prepare('SELECT result FROM automation_logs').get().result, /Tâche non cochée/)
})

test('échec du cochage : préserve le succès Slack et retourne un avertissement', async () => {
  db.exec("CREATE TRIGGER reject_completion BEFORE INSERT ON recurring_task_completions BEGIN SELECT RAISE(FAIL, 'cochage indisponible'); END")
  try {
    const out = await send()
    assert.equal(out.sent, true)
    assert.equal(out.error, undefined)
    assert.equal(out.completion.done, false)
    assert.match(out.completion.warning, /n’a pas pu être cochée/)
    assert.equal(sends, 1)
    assert.equal(completions().length, 0)
  } finally { db.exec('DROP TRIGGER reject_completion') }
})
