// Hook de steering (server/scripts/agent-steer-hook.mjs) : livre à Claude les
// messages envoyés depuis /travaux PENDANT une exécution de l'agent.
//
// On teste le script en subprocess réel (c'est comme ça que Claude Code l'appelle),
// avec un faux task id — l'inbox correspondante n'existe pour aucune vraie tâche,
// donc rien du store de l'agent n'est touché. Chaque test nettoie son inbox.
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPT = resolve(ROOT, 'server/scripts/agent-steer-hook.mjs')
const TASK_ID = 'test-steer-hook-0000'
const INBOX = resolve(ROOT, `.agent-exec-${TASK_ID}.inbox`)

function runHook({ taskId = TASK_ID, event = 'PostToolUse' } = {}) {
  return execFileSync('node', [SCRIPT], {
    input: JSON.stringify({ hook_event_name: event }),
    env: { ...process.env, ERP_AGENT_TASK_ID: taskId },
    encoding: 'utf8',
  })
}

describe('hook de steering', () => {
  afterEach(() => { try { if (existsSync(INBOX)) unlinkSync(INBOX) } catch {} })

  test('silencieux sans ERP_AGENT_TASK_ID (sessions interactives)', () => {
    const out = execFileSync('node', [SCRIPT], { input: '{}', encoding: 'utf8', env: { ...process.env, ERP_AGENT_TASK_ID: '' } })
    assert.equal(out, '')
  })

  test('silencieux quand l\'inbox n\'existe pas', () => {
    assert.equal(runHook(), '')
  })

  test('livre le message en decision:block et consomme l\'inbox', () => {
    writeFileSync(INBOX, JSON.stringify({ text: 'Ajoute aussi la colonne TVQ', at: '2026-08-05T00:00:00Z' }) + '\n')
    const out = JSON.parse(runHook())
    assert.equal(out.decision, 'block')
    assert.match(out.reason, /MESSAGE DE L'UTILISATEUR/)
    assert.match(out.reason, /Ajoute aussi la colonne TVQ/)
    // Consigne PostToolUse : continuer la tâche, pas la terminer.
    assert.match(out.reason, /poursuis la tâche/)
    // Consommée : un second déclenchement (ex. Stop juste après) ne relivre rien.
    assert.equal(existsSync(INBOX), false)
    assert.equal(runHook({ event: 'Stop' }), '')
  })

  test('événement Stop : consigne de traiter le message AVANT de terminer', () => {
    writeFileSync(INBOX, JSON.stringify({ text: 'Vérifie le total avant de finir' }) + '\n')
    const out = JSON.parse(runHook({ event: 'Stop' }))
    assert.equal(out.decision, 'block')
    assert.match(out.reason, /AVANT de terminer/)
  })

  test('plusieurs messages accumulés sont livrés ensemble', () => {
    writeFileSync(INBOX, [
      JSON.stringify({ text: 'Premier message' }),
      JSON.stringify({ text: 'Deuxième message' }),
    ].join('\n') + '\n')
    const out = JSON.parse(runHook())
    assert.match(out.reason, /Premier message/)
    assert.match(out.reason, /Deuxième message/)
  })

  test('ligne illisible : livrée telle quelle plutôt que perdue', () => {
    writeFileSync(INBOX, 'texte brut sans JSON\n')
    const out = JSON.parse(runHook())
    assert.match(out.reason, /texte brut sans JSON/)
  })
})
