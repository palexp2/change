import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideQuotaGuard, lowestRemaining, QUOTA_FLOOR_PCT } from './quotaGuard.js'

// ── Quel plafond compte ───────────────────────────────────────────────────────

test('le plafond le plus serré gagne, et le plafond d\'un modèle est ignoré', () => {
  const worst = lowestRemaining({
    session: { utilizationPct: 40 },
    week: { utilizationPct: 82, resetsAt: '2026-09-05T01:59:59Z' },
    weekScoped: { utilizationPct: 99 },   // a son repli automatique : jamais bloquant
  })
  assert.equal(worst.remaining, 18)
  assert.equal(worst.label, 'semaine')
})

test('aucun pourcentage lisible → aucune décision possible', () => {
  assert.equal(lowestRemaining({ session: {}, week: {} }), null)
  // Plafond présent mais sans chiffre (lecture des quotas en échec) : surtout ne pas
  // le lire comme « 0 % consommé », ce qui vaudrait 100 % de marge.
  assert.equal(lowestRemaining({ session: { utilizationPct: null }, week: { utilizationPct: null } }), null)
  assert.equal(lowestRemaining({ session: { utilizationPct: null }, week: { utilizationPct: 90 } }).remaining, 10)
  assert.equal(decideQuotaGuard({ remaining: null, paused: false, active: false, muted: false }).action, null)
})

// ── Pause automatique ─────────────────────────────────────────────────────────

test(`sous ${QUOTA_FLOOR_PCT} % de marge, la file est mise en pause`, () => {
  const out = decideQuotaGuard({ remaining: 24, paused: false, active: false, muted: false })
  assert.equal(out.action, 'pause')
  assert.equal(out.active, true)
})

test('pile au seuil : rien ne bouge (c\'est SOUS le seuil qui coupe)', () => {
  assert.equal(decideQuotaGuard({ remaining: 25, paused: false, active: false, muted: false }).action, null)
})

test('file déjà en pause : le garde-fou ne repose pas de pause', () => {
  const out = decideQuotaGuard({ remaining: 10, paused: true, active: false, muted: false })
  assert.equal(out.action, null)
  assert.equal(out.active, false, 'une pause posée à la main ne devient pas la sienne')
})

// ── Reprise ───────────────────────────────────────────────────────────────────

test('quota remonté : la pause du garde-fou se lève toute seule', () => {
  const out = decideQuotaGuard({ remaining: 100, paused: true, active: true, muted: false })
  assert.equal(out.action, 'resume')
  assert.equal(out.active, false)
})

test('quota remonté : une pause posée à la main reste en place', () => {
  assert.equal(decideQuotaGuard({ remaining: 100, paused: true, active: false, muted: false }).action, null)
})

// ── Reprise manuelle pendant la pénurie ───────────────────────────────────────

test('l\'utilisateur reprend la file malgré le quota bas : le garde-fou se tait', () => {
  const out = decideQuotaGuard({ remaining: 12, paused: false, active: true, muted: false })
  assert.equal(out.action, null, 'ne pas annuler le clic de l\'utilisateur')
  assert.equal(out.muted, true)
  assert.equal(out.active, false)
  // Et il reste muet aux passages suivants, tant que le quota n'est pas remonté.
  assert.equal(decideQuotaGuard({ remaining: 8, paused: false, active: false, muted: true }).action, null)
})

test('la sourdine expire dès que le quota repasse au-dessus du seuil', () => {
  const out = decideQuotaGuard({ remaining: 60, paused: false, active: false, muted: true })
  assert.equal(out.muted, false)
  // …et le garde-fou reprend son rôle à la prochaine descente.
  assert.equal(decideQuotaGuard({ remaining: 5, paused: false, active: false, muted: out.muted }).action, 'pause')
})
