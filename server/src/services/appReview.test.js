import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { collectReviewSamples, reviewPrompt, validateReviewFinding, normalizeReviewCriteria, DEFAULT_REVIEW_CRITERIA, MAX_REVIEW_CRITERIA_LENGTH } from './appReview.js'

test('critères utilisateur prioritaires, défaut et validation de la saisie', () => {
  const criteria = 'Priorité à la lisibilité des formulaires. Ignorer les couleurs.'
  const prompt = reviewPrompt([], '', criteria)
  assert.ok(prompt.includes(criteria))
  assert.ok(!prompt.includes(DEFAULT_REVIEW_CRITERIA), 'les critères choisis remplacent la recherche de bugs par défaut')
  assert.doesNotMatch(prompt, /Ne propose pas de changements cosmétiques/)
  assert.match(prompt, /obligation de citer une preuve exacte/)
  assert.ok(reviewPrompt([], '', '  ').includes(DEFAULT_REVIEW_CRITERIA))
  assert.equal(normalizeReviewCriteria('  Ergonomie\nPerformance  '), 'Ergonomie\nPerformance')
  assert.equal(normalizeReviewCriteria('  '), '')
  for (const value of [null, 7, {}, 'x'.repeat(MAX_REVIEW_CRITERIA_LENGTH + 1)]) {
    assert.throws(() => normalizeReviewCriteria(value))
  }
})

test('rotation, budget et exclusion des fichiers privés, non suivis et liens symboliques', () => {
  const repo = mkdtempSync(join(tmpdir(), 'erp-review-'))
  try {
    mkdirSync(join(repo, 'server/src/config'), { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: repo })
    for (let i = 0; i < 10; i++) writeFileSync(join(repo, `server/src/source${i}.js`), `const value = ${i}`)
    writeFileSync(join(repo, 'server/src/config/secrets.js'), 'SECRET')
    symlinkSync('/etc/passwd', join(repo, 'server/src/link.js'))
    execFileSync('git', ['add', '.'], { cwd: repo })
    writeFileSync(join(repo, 'server/src/private.js'), 'PRIVATE')
    const first = collectReviewSamples({ repo, now: 0 })
    const next = collectReviewSamples({ repo, now: 86400000 })
    assert.equal(first.length, 7)
    assert.notDeepEqual(first, next)
    assert.equal(new Set([...first, ...next].map(s => s.path)).size, 10)
    assert.doesNotMatch(JSON.stringify([...first, ...next]), /SECRET|PRIVATE|passwd/)
    assert.ok(collectReviewSamples({ repo, now: 0, maxChars: 10 }).reduce((n, s) => n + s.code.length, 0) <= 10)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('seules les preuves exactes du contexte sont acceptées', () => {
  const samples = [{ path: 'server/src/a.js', line: 10, code: 'const a = null\na.value()' }]
  const finding = { title: 'Erreur', severity: 'P2', path: 'server/src/a.js', line: 11,
    evidence: 'a.value()', rationale: 'Plantage', solution: 'Vérifier a', verification: 'Test avec null' }
  assert.equal(validateReviewFinding(finding, samples), true)
  for (const patch of [{ line: 12 }, { path: '../../etc/passwd' }, { evidence: 'inventé' }, { severity: 'P0' }, { solution: '' }]) {
    assert.equal(validateReviewFinding({ ...finding, ...patch }, samples), false)
  }
  assert.equal(validateReviewFinding(null, samples), false)
  assert.match(reviewPrompt(samples, 'Déjà proposé'), /Déjà proposé/)
})
