import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import Database from 'better-sqlite3'

// Isole les dépendances du service : SQLite en mémoire et ordonnanceur simulé.
// Aucun import du runner réel, ni lecture/écriture de ses fichiers de tâches.
const queueSource = readFileSync(new URL('./promptQueue.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*? from '[^']+'\n/gm, '')
  .replace(/^export /gm, '')
const runnerSource = readFileSync(new URL('./taskRunner.js', import.meta.url), 'utf8')
const pendingUpdate = runnerSource.slice(
  runnerSource.indexOf('export function updatePendingAgentTask('),
  runnerSource.indexOf('\n/**', runnerSource.indexOf('export function updatePendingAgentTask(')),
).replace(/^export /, '')

function fixture(t, { status = 'queued', agentStatus = 'approved', model = 'opus', followUp = false } = {}) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.exec(`
    CREATE TABLE users (id TEXT, name TEXT);
    CREATE TABLE work_prompts (
      id TEXT PRIMARY KEY, title TEXT, prompt TEXT, status TEXT, model TEXT,
      preset TEXT, preset_auto INTEGER, mode TEXT, created_by TEXT,
      deleted_at TEXT, updated_at TEXT, agent_task_id TEXT, follow_up INTEGER
    );
    CREATE TABLE work_prompt_messages (id TEXT, prompt_id TEXT, role TEXT, text TEXT, created_at TEXT, author TEXT);
  `)
  db.prepare(`INSERT INTO work_prompts VALUES (
    'p', 'Titre', 'Demande originale', ?, ?, 'deep', 0, 'implement',
    NULL, NULL, NULL, 'task', ?
  )`).run(status, model, followUp ? 1 : 0)
  db.exec(`INSERT INTO work_prompt_messages VALUES ('m', 'p', 'user', 'Complément utilisateur', '2026-09-10', NULL)`)
  const task = { id: 'task', status: agentStatus, model, resume_session_id: 'session' }
  const context = {
    db,
    KNOWN_MODELS: ['opus', 'sonnet', 'haiku'],
    getMaxParallelQuestions: () => 2,
    getExecLaneCount: () => 4,
    findAgentTask: () => ({ ...task }),
    readTasks: () => [task],
    updateTask: (_id, patch) => Object.assign(task, patch),
    broadcastTask: () => {},
    broadcastAll: () => {},
    presetFor: () => ({ model: 'opus', effort: 'high' }),
  }
  const api = runInNewContext(`${pendingUpdate}\n${queueSource}\n({ updatePrompt, getPrompt })`, context)
  return { ...api, task }
}

for (const status of ['queued', 'paused', 'running']) {
  test(`modèle modifiable avant exécution : ${status}`, t => {
    const { updatePrompt, getPrompt, task } = fixture(t, { status })
    const updated = updatePrompt('p', { model: 'HAIKU' })
    assert.equal(updated.model, 'haiku')
    assert.equal(getPrompt('p').model, 'haiku')
    assert.equal(updated.status, status)
    assert.equal(updated.prompt, 'Demande originale')
    assert.equal(updated.preset, 'deep')
    if (status === 'running') {
      assert.equal(task.model, 'haiku')
      assert.equal(task.effort, 'high')
      assert.equal(task.description, 'Demande originale')
    }
  })
}

for (const value of [null, '']) {
  test(`retour au modèle du calibre : ${JSON.stringify(value)}`, t => {
    const { updatePrompt, task } = fixture(t, { status: 'running', model: 'haiku' })
    assert.equal(updatePrompt('p', { model: value }).model, null)
    assert.equal(task.model, 'opus')
  })
}

test('un changement entre modèles Claude conserve la session', t => {
  const { updatePrompt, task } = fixture(t, { status: 'running' })
  updatePrompt('p', { model: 'sonnet' })
  assert.equal(task.model, 'sonnet')
  assert.equal(task.resume_session_id, 'session')
})

test('une relance conserve le fil lors d’un changement de modèle', t => {
  const { updatePrompt, task } = fixture(t, { status: 'running', followUp: true })
  updatePrompt('p', { model: 'haiku' })
  assert.match(task.description, /Demande originale/)
  assert.match(task.description, /Complément utilisateur/)
})

for (const model of ['inconnu', 'codex', false, 42, {}, undefined]) {
  test(`modèle invalide refusé : ${JSON.stringify(model)}`, t => {
    const { updatePrompt, getPrompt } = fixture(t)
    assert.throws(() => updatePrompt('p', { model, title: 'Ne pas appliquer' }), { status: 400 })
    assert.equal(getPrompt('p').model, 'opus')
    assert.equal(getPrompt('p').title, 'Titre')
  })
}

for (const status of ['running', 'done', 'blocked', 'cancelled']) {
  test(`refus après départ ou fin : ${status}`, t => {
    const { updatePrompt, getPrompt, task } = fixture(t, { status, agentStatus: 'in_progress' })
    assert.throws(() => updatePrompt('p', { model: 'haiku' }), { status: 409 })
    assert.equal(getPrompt('p').model, 'opus')
    assert.equal(task.model, 'opus')
  })
}

test('tâche inconnue : aucun changement', t => {
  assert.equal(fixture(t).updatePrompt('absente', { model: 'haiku' }), null)
})
