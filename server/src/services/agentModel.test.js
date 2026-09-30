// Modèle de l'agent : Opus 5.5 par défaut, registre des quotas épuisés par modèle —
// une tâche n'attend que si SON modèle est à sec.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  AGENT_MODEL, normalizeModel, resolveModel, chainAvailableAt, isModelLimited,
  noteModelLimit, clearModelLimit, resetModelLimits, purgeExpiredLimits,
  nextLimitExpiryAt, agentModelState, attributeLimitScope,
  preferredAgentModel, setPreferredAgentModel, KNOWN_MODELS,
} from './agentModel.js'

const HOUR = 3600_000

beforeEach(() => { resetModelLimits(); setPreferredAgentModel(AGENT_MODEL) })

test('l\'agent tourne sur opus ; fable n\'est plus proposé', () => {
  assert.equal(AGENT_MODEL, 'opus')
  assert.equal(resolveModel(), 'opus')
  assert.equal(KNOWN_MODELS.includes('fable'), false)
})

test('un modèle retiré inscrit sur une vieille tâche passe au préféré', () => {
  assert.equal(normalizeModel('fable'), 'opus')
  assert.equal(resolveModel('fable'), 'opus')
  assert.equal(normalizeModel('sonnet'), 'sonnet')
})

test('changer le modèle préféré redirige tous les défauts (résolution, état UI)', () => {
  setPreferredAgentModel('sonnet')
  assert.equal(preferredAgentModel(), 'sonnet')
  assert.equal(resolveModel(), 'sonnet')
  const s = agentModelState()
  assert.equal(s.preferred, 'sonnet')
  assert.equal(s.active, 'sonnet')
  assert.deepEqual(s.models, [...KNOWN_MODELS], 'l\'état UI liste les choix offerts')
})

test('un modèle inconnu est ignoré : on garde le préféré courant', () => {
  setPreferredAgentModel('fable')
  assert.equal(preferredAgentModel(), 'opus')
  setPreferredAgentModel(undefined)
  assert.equal(preferredAgentModel(), 'opus')
})

test('quota opus épuisé → rien ne démarre sur opus, reprise à la réinit.', () => {
  const now = Date.now()
  noteModelLimit(['opus'], { resetAt: now + 2 * HOUR, label: '5 h' })
  assert.equal(resolveModel('opus'), null)
  assert.equal(chainAvailableAt('opus'), now + 2 * HOUR)
  assert.equal(nextLimitExpiryAt(), now + 2 * HOUR)
  assert.equal(resolveModel('sonnet'), 'sonnet', 'les autres modèles continuent')
  assert.equal(agentModelState('opus').active, null)
})

test('une marque plus lointaine ne recule jamais', () => {
  const now = Date.now()
  noteModelLimit(['opus'], { resetAt: now + 10 * HOUR })
  assert.equal(noteModelLimit(['opus'], { resetAt: now + 1 * HOUR }), false)
  assert.equal(chainAvailableAt('opus'), now + 10 * HOUR)
})

test('réinitialisation passée → la marque tombe', () => {
  const now = Date.now()
  noteModelLimit(['opus'], { resetAt: now + HOUR })
  assert.equal(isModelLimited('opus', now + 2 * HOUR), false)
  assert.equal(resolveModel('opus', now + 2 * HOUR), 'opus')
})

test('heure de reprise illisible ou déjà passée → jamais de reprise immédiate', () => {
  const now = Date.now()
  noteModelLimit(['opus'], { resetAt: now - 60_000 }, now)
  assert.equal(isModelLimited('opus', now), true, 'sinon la file se rebrûle en boucle')
  assert.equal(isModelLimited('opus', now + 16 * 60_000), false)
})

test('purge et lever manuel nettoient le registre', () => {
  const now = Date.now()
  noteModelLimit(['opus'], { resetAt: now + HOUR })
  assert.equal(purgeExpiredLimits(now + 2 * HOUR), true)
  noteModelLimit(['opus'], { resetAt: now + HOUR, source: 'run' })
  assert.deepEqual(agentModelState().limited.map(l => l.model), ['opus'])
  assert.equal(clearModelLimit('opus'), true)
  assert.equal(resolveModel('opus'), 'opus')
})

test('fenêtre de 5 h ou semaine à 100 % → plafond de COMPTE', () => {
  assert.equal(attributeLimitScope({ session: { utilizationPct: 100 }, week: { utilizationPct: 40 } }), 'account')
  assert.equal(attributeLimitScope({ session: { utilizationPct: 12 }, week: { utilizationPct: 100 } }), 'account')
})

test('compte au vert, quotas illisibles ou crédits actifs → plafond du modèle seul', () => {
  assert.equal(attributeLimitScope({ session: { utilizationPct: 34 }, week: { utilizationPct: 59 } }), 'model')
  assert.equal(attributeLimitScope(null), 'model')
  assert.equal(attributeLimitScope({}), 'model')
  assert.equal(attributeLimitScope({ session: { utilizationPct: 100 }, extraUsageEnabled: true }), 'model')
})
