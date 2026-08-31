// Régression : une exécution agent ne doit PAS rester « bloquée » quand elle a en
// fait réussi (cas typique : la tâche touche server/src/ et lance `pm2 restart
// erp-server`, ce qui tue le process parent et perdait jadis le callback de succès).
//
// On vérifie la finalisation DURABLE (wrapper + fichiers .log/.code) directement via
// monitorExecution() — le même chemin utilisé à la reprise après un redémarrage :
//   - .code == 0  → la tâche passe à `done` avec le rapport extrait du log
//   - .code != 0  → `blocked` avec le code de sortie
//   - pas de .code + process mort (crash) → `blocked`
//
// L'agent est forcé OFF (capturé/restauré), la tâche est seedée dans le vrai store
// puis nettoyée — pattern identique à e2e/tests/agent-autonomous.test.js.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'fs'
import { resolve } from 'path'

import { monitorExecution } from './taskRunner.js'

const ROOT = '/home/ec2-user/erp'
const TASKS_FILE = resolve(ROOT, 'agent-tasks.json')
const SETTINGS_FILE = resolve(ROOT, 'agent-settings.json')
const PID_FILE = resolve(ROOT, '.agent-pid')
const LOG = id => resolve(ROOT, `.agent-exec-${id}.log`)
const CODE = id => resolve(ROOT, `.agent-exec-${id}.code`)
const PROMPT = id => resolve(ROOT, `.agent-exec-${id}.prompt`)

const DEAD_PID = 999999 // quasi-certainement pas un process vivant

function readTasks() { try { return JSON.parse(readFileSync(TASKS_FILE, 'utf8')) } catch { return [] } }
function writeTasksAtomic(tasks) {
  const tmp = TASKS_FILE + '.exectest.tmp'
  writeFileSync(tmp, JSON.stringify(tasks, null, 2) + '\n', 'utf8')
  renameSync(tmp, TASKS_FILE)
}
function seedInProgress(id) {
  const now = new Date().toISOString()
  const tasks = readTasks()
  tasks.push({
    id, kind: 'proposal', title: `E2E exec ${id}`, description: 'exec test',
    status: 'in_progress', priority: 0, messages: [], user_comment: null,
    agent_result: null, created_at: now, updated_at: now, completed_at: null,
  })
  writeTasksAtomic(tasks)
}
function getTask(id) { return readTasks().find(t => t.id === id) }
function cleanupTask(id) {
  try { writeTasksAtomic(readTasks().filter(t => t.id !== id)) } catch {}
  for (const f of [LOG(id), CODE(id), PROMPT(id)]) { try { if (existsSync(f)) unlinkSync(f) } catch {} }
}

// Une ligne de transcript stream-json valide (bloc texte assistant).
function transcript(text) {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n'
}

async function waitFor(fn, timeoutMs = 12000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = fn()
    if (v) return v
    await new Promise(r => setTimeout(r, 200))
  }
  return fn()
}

// IMPORTANT : on NE passe PAS par setSettings(), qui appelle kick() et pourrait lancer
// une VRAIE exécution (l'agent de prod tourne sur la même DB/le même store). On écrit
// directement le fichier de settings, en sauvegardant/restaurant la valeur réelle.
let originalSettingsRaw
// `.agent-pid` est PARTAGÉ avec l'exécution réelle en cours (prod = dev ici) et
// deploy.sh s'en sert pour attendre l'agent. Le détruire faisait déclarer « bloquée »
// au redémarrage suivant une tâche parfaitement vivante, et libérait son slot. On
// sauvegarde donc son contenu et on le restaure à l'identique.
let originalPidRaw = null
function writeSettingsAtomic(obj) {
  const tmp = SETTINGS_FILE + '.exectest.tmp'
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8')
  renameSync(tmp, SETTINGS_FILE)
}
before(() => {
  originalPidRaw = existsSync(PID_FILE) ? readFileSync(PID_FILE, 'utf8') : null
  originalSettingsRaw = existsSync(SETTINGS_FILE) ? readFileSync(SETTINGS_FILE, 'utf8') : null
  // Forcer OFF pendant le test : finalize()→releaseSlot()→kick() lit ce fichier et ne
  // doit donc rien démarrer.
  const cur = (() => { try { return JSON.parse(originalSettingsRaw || '{}') } catch { return {} } })()
  writeSettingsAtomic({ ...cur, enabled: false })
  // Filet de sécurité : `after()` ne tourne pas si la suite est interrompue (Ctrl-C,
  // timeout du runner, crash). Sans ça, l'agent de PROD restait coupé (`enabled:false`)
  // et `.agent-pid` gardait le faux PID du test — l'ordonnanceur croyait alors qu'une
  // exécution tournait et la file n'avançait plus. Ces handlers sont synchrones, donc
  // valides dans 'exit'.
  process.on('exit', restoreRealState)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { restoreRealState(); process.exit(1) })
  }
})
after(restoreRealState)

// Restauration idempotente de l'état réel (settings + PID). Appelée par after(), et
// à nouveau à la sortie du process quel qu'en soit le motif.
let restored = false
function restoreRealState() {
  if (restored) return
  restored = true
  // Restaurer le fichier de settings réel à l'identique (sans déclencher kick()).
  try { if (originalSettingsRaw !== null) writeSettingsAtomic(JSON.parse(originalSettingsRaw)) } catch {}
  // Rendre le fichier PID à son propriétaire (exécution réelle en cours), ou le
  // retirer s'il n'en avait pas avant le test.
  try {
    if (originalPidRaw !== null) writeFileSync(PID_FILE, originalPidRaw, 'utf8')
    else if (existsSync(PID_FILE)) unlinkSync(PID_FILE)
  } catch {}
}

test('exit code 0 → done avec rapport (réussite préservée malgré un restart)', async () => {
  const id = `e2e-exec-ok-${Date.now()}`
  try {
    seedInProgress(id)
    writeFileSync(LOG(id), transcript('RAPPORT: build vert, tests E2E verts.'), 'utf8')
    writeFileSync(CODE(id), '0\n', 'utf8')
    writeFileSync(PID_FILE, `${DEAD_PID}\n${id}`, 'utf8')

    monitorExecution(id, DEAD_PID)

    const t = await waitFor(() => { const x = getTask(id); return x && x.status !== 'in_progress' ? x : null })
    assert.equal(t.status, 'done', 'doit être DONE quand le code de sortie est 0')
    assert.match(t.agent_result, /RAPPORT: build vert/, 'le rapport doit être extrait du log')
    assert.ok(!existsSync(LOG(id)) && !existsSync(CODE(id)), 'les artefacts .log/.code doivent être nettoyés')
  } finally { cleanupTask(id) }
})

test('exit code non nul → blocked avec le code', async () => {
  const id = `e2e-exec-fail-${Date.now()}`
  try {
    seedInProgress(id)
    writeFileSync(LOG(id), transcript('Échec à l\'étape 2.'), 'utf8')
    writeFileSync(CODE(id), '2\n', 'utf8')
    writeFileSync(PID_FILE, `${DEAD_PID}\n${id}`, 'utf8')

    monitorExecution(id, DEAD_PID)

    const t = await waitFor(() => { const x = getTask(id); return x && x.status !== 'in_progress' ? x : null })
    assert.equal(t.status, 'blocked', 'code != 0 → blocked')
    assert.match(t.agent_result, /exit code: 2/, 'le code de sortie doit apparaître dans le rapport')
  } finally { cleanupTask(id) }
})

test('process mort sans .code (crash) → blocked', async () => {
  const id = `e2e-exec-crash-${Date.now()}`
  try {
    seedInProgress(id)
    writeFileSync(LOG(id), transcript('travail partiel'), 'utf8')
    // Pas de fichier .code → simule un kill/crash sans sortie propre.
    writeFileSync(PID_FILE, `${DEAD_PID}\n${id}`, 'utf8')

    monitorExecution(id, DEAD_PID)

    const t = await waitFor(() => { const x = getTask(id); return x && x.status !== 'in_progress' ? x : null }, 15000)
    assert.equal(t.status, 'blocked', 'crash sans code → blocked')
    assert.match(t.agent_result, /sans code de sortie/, 'message de blocage explicite attendu')
  } finally { cleanupTask(id) }
})

// Régression du 9 août 2026 : `.agent-pid` est unique pour toute la voie exec. La
// finalisation d'une tâche le supprimait sans regarder à qui il appartenait —
// l'exécution réellement en cours perdait son fichier de suivi et le redémarrage
// suivant la déclarait « bloquée » alors qu'elle tournait toujours (et libérait son
// slot : une 2e implémentation démarrait dans le même arbre de travail).
test('la finalisation ne supprime pas le fichier PID d\'une AUTRE exécution', async () => {
  const id = `e2e-exec-pid-${Date.now()}`
  const foreign = `e2e-exec-autre-${Date.now()}`
  try {
    seedInProgress(id)
    writeFileSync(LOG(id), transcript('rapport'), 'utf8')
    writeFileSync(CODE(id), '0\n', 'utf8')
    // Le fichier PID porte une AUTRE tâche (comme lorsqu'une exécution suivante a
    // déjà démarré, ou qu'un test l'a réécrit).
    writeFileSync(PID_FILE, `${DEAD_PID}\n${foreign}`, 'utf8')

    monitorExecution(id, DEAD_PID)

    const t = await waitFor(() => { const x = getTask(id); return x && x.status !== 'in_progress' ? x : null })
    assert.equal(t.status, 'done')
    assert.ok(existsSync(PID_FILE), 'le fichier PID de l\'autre exécution doit survivre')
    assert.match(readFileSync(PID_FILE, 'utf8'), new RegExp(foreign), 'il doit toujours porter l\'autre tâche')
  } finally { cleanupTask(id) }
})
