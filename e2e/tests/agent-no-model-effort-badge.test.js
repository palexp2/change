// Agent autonome — le modèle et l'effort ne sont PLUS affichés sur les cartes.
//
// Demande utilisateur : « Retirez le modèle utilisé et l'effort des cartes.
// Ce n'est plus pertinent. » Revert du badge « Opus · effort élevé »
// (data-testid="card-model-effort") introduit par une demande antérieure.
// model/effort restent stockés sur les tâches côté serveur ; seul l'affichage
// est retiré. Le badge « Effort : Petit/Moyen/Gros » des propositions (concept
// distinct : estimation d'effort d'une suggestion) n'est pas concerné.
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

const SEED_DESC = `E2E absence badge modèle+effort ${Date.now()}`

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

describe('Agent autonome — plus de badge modèle + effort sur les cartes', () => {
  let browser, ctx, page
  let originalEnabled = false
  let seedId = null
  let seedTaskId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)

    const s = await apiGet(page, '/agent/settings')
    originalEnabled = !!s.enabled
    await apiFetch(page, 'PUT', '/agent/settings', { enabled: false })

    // Seed une suggestion : le POST auto-approuve → tâche liée « approved » qui
    // porte model/effort côté serveur. Agent OFF → aucune exécution.
    const created = await apiFetch(page, 'POST', '/agent/backlog', { text: SEED_DESC })
    seedId = created.id
    seedTaskId = created.task_id || null
  })

  after(async () => {
    try { if (seedId && page) await apiFetch(page, 'DELETE', `/agent/backlog/${seedId}`) } catch {}
    try { if (seedTaskId && page) await apiFetch(page, 'DELETE', `/agent/tasks/${seedTaskId}`) } catch {}
    try { if (page) await apiFetch(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('la tâche seedée porte model/effort côté serveur (données conservées)', async () => {
    assert.ok(seedTaskId, 'le POST /backlog doit créer une tâche liée')
    const task = (await apiGet(page, '/agent/tasks')).find(t => t.id === seedTaskId)
    assert.ok(task, 'tâche liée introuvable')
    // Le stockage serveur n'est pas touché par le retrait d'affichage.
    assert.ok(task.model, 'model doit rester stocké sur la tâche')
    assert.ok(task.effort, 'effort doit rester stocké sur la tâche')
  })

  test('aucun badge modèle/effort sur la carte de la suggestion ni ailleurs sur la page', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Agent autonome', { timeout: 10000 })

    const card = page.locator('[data-testid="suggestion-card"]', { hasText: SEED_DESC })
    await card.waitFor({ timeout: 5000 })

    // Le badge retiré ne doit plus exister — sur cette carte ni nulle part.
    assert.equal(await page.locator('[data-testid="card-model-effort"]').count(), 0,
      'le badge card-model-effort ne doit plus être rendu')

    // Aucun libellé de modèle ou d'effort d'exécution sur la carte.
    const cardText = (await card.innerText()).replace(/\s+/g, ' ')
    for (const label of ['Haiku', 'Sonnet', 'Opus', 'effort faible', 'effort moyen', 'effort élevé']) {
      assert.ok(!cardText.includes(label), `« ${label} » ne doit plus apparaître sur la carte (reçu: « ${cardText} »)`)
    }
  })
})
