// Repli de modèle de l'agent : fable tant qu'il a du quota, opus quand SON plafond
// hebdomadaire est épuisé, pause seulement quand plus rien n'est disponible.
//
// C'est la règle que ces tests verrouillent — avant, n'importe quel refus de quota
// mettait toute la file en pause pendant des jours (jusqu'à la réinitialisation
// hebdomadaire du modèle), alors qu'opus était encore parfaitement disponible.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  AGENT_MODEL, modelChain, resolveModel, chainAvailableAt, isModelLimited,
  noteModelLimit, clearModelLimit, resetModelLimits, purgeExpiredLimits,
  nextLimitExpiryAt, agentModelState, attributeLimitScope, scopedLimitFromUsage,
  preferredAgentModel, setPreferredAgentModel, KNOWN_MODELS,
} from './agentModel.js'

const HOUR = 3600_000

beforeEach(() => { resetModelLimits(); setPreferredAgentModel(AGENT_MODEL) })

// ── Chaîne de repli ───────────────────────────────────────────────────────────

test('l\'agent tourne sur fable, avec opus en repli', () => {
  assert.equal(AGENT_MODEL, 'fable')
  assert.deepEqual(modelChain('fable'), ['fable', 'opus'])
  assert.equal(resolveModel(), 'fable')
})

test('un modèle sans repli reste seul dans sa chaîne', () => {
  assert.deepEqual(modelChain('opus'), ['opus'])
  assert.deepEqual(modelChain('sonnet'), ['sonnet'])
})

// ── Modèle préféré réglable (sélecteur du bandeau quotas) ─────────────────────

test('changer le modèle préféré redirige tous les défauts (chaîne, résolution, état UI)', () => {
  assert.equal(preferredAgentModel(), 'fable')
  setPreferredAgentModel('sonnet')
  assert.equal(preferredAgentModel(), 'sonnet')
  assert.equal(resolveModel(), 'sonnet')
  assert.deepEqual(modelChain(), ['sonnet'])
  const s = agentModelState()
  assert.equal(s.preferred, 'sonnet')
  assert.equal(s.active, 'sonnet')
  assert.deepEqual(s.models, [...KNOWN_MODELS], 'l\'état UI liste les choix offerts')
})

test('un modèle inconnu est ignoré : on garde le préféré courant', () => {
  setPreferredAgentModel('gpt-9')
  assert.equal(preferredAgentModel(), 'fable')
  setPreferredAgentModel(undefined)
  assert.equal(preferredAgentModel(), 'fable')
})

// ── Repli quand le quota du modèle préféré est épuisé ─────────────────────────

test('quota fable épuisé → le travail part sur opus, la file n\'est PAS en pause', () => {
  const resetAt = Date.now() + 48 * HOUR
  noteModelLimit(['fable'], { resetAt, label: '01:59 UTC' })
  assert.equal(isModelLimited('fable'), true)
  assert.equal(resolveModel('fable'), 'opus')
  assert.equal(chainAvailableAt('fable'), 0, 'un repli disponible = aucune pause forcée')
})

test('les deux quotas épuisés → plus rien ne démarre, reprise à la plus proche réinit.', () => {
  const now = Date.now()
  noteModelLimit(['fable'], { resetAt: now + 48 * HOUR, label: 'hebdo' })
  noteModelLimit(['opus'], { resetAt: now + 2 * HOUR, label: '5 h' })
  assert.equal(resolveModel('fable'), null)
  assert.equal(chainAvailableAt('fable'), now + 2 * HOUR)
  assert.equal(nextLimitExpiryAt(), now + 2 * HOUR)
})

test('une marque plus lointaine ne recule jamais', () => {
  const now = Date.now()
  noteModelLimit(['fable'], { resetAt: now + 10 * HOUR })
  assert.equal(noteModelLimit(['fable'], { resetAt: now + 1 * HOUR }), false)
  assert.equal(chainAvailableAt('opus'), 0)
  assert.equal(agentModelState('fable').preferredResetAt, new Date(now + 10 * HOUR).toISOString())
})

test('réinitialisation passée → la marque tombe et fable reprend la main', () => {
  const now = Date.now()
  noteModelLimit(['fable'], { resetAt: now + HOUR })
  assert.equal(isModelLimited('fable', now + 2 * HOUR), false)
  assert.equal(resolveModel('fable', now + 2 * HOUR), 'fable')
})

test('heure de reprise illisible ou déjà passée → jamais de reprise immédiate', () => {
  const now = Date.now()
  noteModelLimit(['fable'], { resetAt: now - 60_000 }, now)
  assert.equal(isModelLimited('fable', now), true, 'sinon la file se rebrûle en boucle')
  assert.equal(isModelLimited('fable', now + 16 * 60_000), false)
})

test('purge et lever manuel nettoient le registre', () => {
  const now = Date.now()
  noteModelLimit(['fable'], { resetAt: now + HOUR })
  assert.equal(purgeExpiredLimits(now + 2 * HOUR), true)
  noteModelLimit(['fable'], { resetAt: now + HOUR })
  assert.equal(clearModelLimit('fable'), true)
  assert.equal(resolveModel('fable'), 'fable')
})

// ── État exposé à l'interface ─────────────────────────────────────────────────

test('état affiché : modèle préféré, modèle actif, repli signalé', () => {
  let s = agentModelState('fable')
  assert.equal(s.active, 'fable')
  assert.equal(s.fallbackActive, false)
  assert.equal(s.fallback, 'opus')

  noteModelLimit(['fable'], { resetAt: Date.now() + 24 * HOUR, source: 'usage' })
  s = agentModelState('fable')
  assert.equal(s.preferred, 'fable')
  assert.equal(s.active, 'opus')
  assert.equal(s.fallbackActive, true)
  assert.deepEqual(s.limited.map(l => l.model), ['fable'])
  assert.equal(s.limited[0].source, 'usage')
})

// ── Attribution : plafond du modèle ou plafond du compte ? ────────────────────

test('fenêtre de 5 h ou semaine à 100 % → plafond de COMPTE (aucun repli ne passera)', () => {
  assert.equal(attributeLimitScope({ session: { utilizationPct: 100 }, week: { utilizationPct: 40 } }), 'account')
  assert.equal(attributeLimitScope({ session: { utilizationPct: 12 }, week: { utilizationPct: 100 } }), 'account')
})

test('compte au vert → le refus vient du plafond du modèle, le repli a sa chance', () => {
  const usage = {
    session: { utilizationPct: 34 }, week: { utilizationPct: 59 },
    weekScoped: { utilizationPct: 100, label: 'Fable' },
  }
  assert.equal(attributeLimitScope(usage), 'model')
})

test('quotas illisibles → on tente le repli plutôt que d\'arrêter la file', () => {
  assert.equal(attributeLimitScope(null), 'model')
  assert.equal(attributeLimitScope({}), 'model')
})

test('crédits de dépassement actifs → un plafond n\'arrête rien', () => {
  assert.equal(attributeLimitScope({ session: { utilizationPct: 100 }, extraUsageEnabled: true }), 'model')
})

// ── Lecture proactive du plafond par modèle ──────────────────────────────────

test('plafond hebdo Fable à 100 % → fable marqué jusqu\'à sa réinitialisation', () => {
  const resetsAt = '2026-08-07T01:59:59.000Z'
  const v = scopedLimitFromUsage({ weekScoped: { utilizationPct: 100, label: 'Fable', resetsAt } },
    Date.parse('2026-08-04T12:00:00Z'))
  assert.equal(v.model, 'fable')
  assert.equal(v.limited, true)
  assert.equal(v.resetAt, Date.parse(resetsAt))
  assert.equal(v.label, '01:59 UTC')
})

test('plafond hebdo Fable au vert → aucun quota épuisé', () => {
  const v = scopedLimitFromUsage({ weekScoped: { utilizationPct: 8, label: 'Fable', resetsAt: '2026-08-07T01:59:59.000Z' } },
    Date.parse('2026-08-04T12:00:00Z'))
  assert.deepEqual(v, { model: 'fable', limited: false })
})

test('libellé de modèle inconnu ou absent → on ne conclut rien', () => {
  assert.equal(scopedLimitFromUsage({}), null)
  assert.equal(scopedLimitFromUsage({ weekScoped: { utilizationPct: 100, label: 'Machin' } }), null)
})
