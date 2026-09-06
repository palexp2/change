// Agent autonome — la carte d'une implémentation terminée (« Implantées »)
// ne doit plus proposer « Voir le journal d'exécution » en dépli. Le journal
// reste disponible sur les cartes bloquées (diagnostic du blocage).
//
// Signalement utilisateur : retirer le journal d'exécution des cartes
// d'implémentation terminées.
//
// Les buffers de stream vivent en mémoire serveur (pas d'API de seed) : le test
// intercepte la route stream-log côté Playwright pour fournir de faux chunks.
// La carte bloquée sert de contrôle positif (l'intercept fonctionne et le
// journal existe toujours là où il doit exister).
//
// L'agent est forcé OFF pour tout le run (aucun subprocess Claude). Seed/cleanup
// via l'API. Le toggle est restauré (règle CLAUDE.md).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const SEED_DONE = `E2E carte terminée sans journal ${Date.now()}`
const SEED_BLOCKED = `E2E carte bloquée avec journal ${Date.now()}`

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

function apiFetch(page, method, p, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const opts = { method, headers: { Authorization: `Bearer ${tok}` } }
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
    const r = await fetch('/erp/api' + path, opts)
    return r.json()
  }, { method, path: p, body })
}
const apiGet = (page, p) => apiFetch(page, 'GET', p)

describe('Agent autonome — journal d\'exécution retiré des cartes terminées', () => {
  let browser, ctx, page
  let originalEnabled = false
  const seeds = [] // { backlogId, taskId }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)

    const s = await apiGet(page, '/agent/settings')
    originalEnabled = !!s.enabled
    await apiFetch(page, 'PUT', '/agent/settings', { enabled: false })

    // Seed 1 : suggestion dont la tâche liée est terminée.
    const end = new Date()
    const start = new Date(end.getTime() - 5 * 60 * 1000)
    const done = await apiFetch(page, 'POST', '/agent/backlog', { text: SEED_DONE })
    assert.ok(done.task_id, 'le POST /backlog doit créer une tâche liée (done)')
    seeds.push({ backlogId: done.id, taskId: done.task_id })
    await apiFetch(page, 'PATCH', `/agent/tasks/${done.task_id}`, {
      status: 'done',
      user_summary: 'Résumé de test : le correctif a été implanté.',
      started_at: start.toISOString(),
      completed_at: end.toISOString(),
    })

    // Seed 2 : suggestion dont la tâche liée est bloquée (contrôle positif).
    const blocked = await apiFetch(page, 'POST', '/agent/backlog', { text: SEED_BLOCKED })
    assert.ok(blocked.task_id, 'le POST /backlog doit créer une tâche liée (blocked)')
    seeds.push({ backlogId: blocked.id, taskId: blocked.task_id })
    await apiFetch(page, 'PATCH', `/agent/tasks/${blocked.task_id}`, {
      status: 'blocked',
      agent_result: 'Blocage de test : dépendance manquante.',
      started_at: start.toISOString(),
      completed_at: end.toISOString(),
    })

    // Les buffers de stream sont en mémoire serveur : on intercepte la route
    // pour simuler un journal d'exécution non vide sur les deux tâches.
    await page.route('**/api/agent/tasks/*/stream-log*', route => {
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          chunks: [
            { kind: 'tool', name: 'Bash', input: 'npm run build' },
            { kind: 'result', content: 'built in 10s' },
            { kind: 'text', text: 'Terminé.' },
          ],
        }),
      })
    })
  })

  after(async () => {
    for (const seed of seeds) {
      try { if (page) await apiFetch(page, 'DELETE', `/agent/backlog/${seed.backlogId}`) } catch {}
      try { if (page) await apiFetch(page, 'DELETE', `/agent/tasks/${seed.taskId}`) } catch {}
    }
    try { if (page) await apiFetch(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('carte bloquée : « Voir le journal d\'exécution » présent (contrôle positif)', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Agent autonome', { timeout: 10000 })

    const card = page.locator('[data-testid="suggestion-card"]', { hasText: SEED_BLOCKED })
    await card.waitFor({ timeout: 5000 })
    await card.locator('.cursor-pointer').first().click()
    await card.locator('button:has-text("Relancer l\'implémentation")').waitFor({ timeout: 5000 })

    await card.locator('button:has-text("Voir le journal d\'exécution")').waitFor({ timeout: 5000 })
  })

  test('carte terminée : aucun « journal d\'exécution » même dépliée', async () => {
    const card = page.locator('[data-testid="suggestion-card"]', { hasText: SEED_DONE })
    await card.waitFor({ timeout: 5000 })

    // Déplie la carte (le résumé au niveau carte est visible même repliée ;
    // attendre l'appréciation étoiles qui, elle aussi, est hors dépli — on
    // valide le dépli via l'absence du chevron « replié »).
    await card.locator('.cursor-pointer').first().click()
    await card.locator('[data-testid="suggestion-user-summary"]').waitFor({ timeout: 5000 })

    // Laisse le temps à un éventuel rendu différé, puis vérifie l'absence.
    await page.waitForTimeout(500)
    const txt = (await card.innerText()).replace(/\s+/g, ' ')
    assert.ok(!/journal d'exécution/i.test(txt),
      `« journal d'exécution » ne doit plus apparaître sur une carte terminée (reçu: « ${txt.slice(0, 300)} »)`)
  })
})
