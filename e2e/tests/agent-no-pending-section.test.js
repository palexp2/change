// Agent autonome — retrait de la section « Suggestions & correctifs » (en attente).
//
// Les suggestions sont implémentées immédiatement (POST /backlog auto-approuve),
// donc la zone « en attente » n'a plus de raison d'être. Ce test vérifie :
//   1. la zone « Suggestions & correctifs » n'apparaît plus sur /agent ;
//   2. une fiche bloquée (cas qui vivait dans cette zone) reste visible,
//      repliée dans « En cours d'implémentation » (triée en tête).
//
// L'agent est forcé OFF pour tout le run → aucune exécution Claude réelle.
// Seed et cleanup passent par l'API ; le toggle est restauré (règle CLAUDE.md).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const SEED_TEXT = `E2E fiche bloquée sans section attente ${Date.now()}`

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

describe('Agent autonome — plus de section « Suggestions & correctifs »', () => {
  let browser, ctx, page
  let originalEnabled = false
  let seedItemId = null
  let seedTaskId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)

    // Forcer l'agent OFF : la tâche auto-approuvée créée par le seed ne
    // déclenchera aucune exécution Claude.
    const s = await apiGet(page, '/agent/settings')
    originalEnabled = !!s.enabled
    await apiFetch(page, 'PUT', '/agent/settings', { enabled: false })

    // Seed : une suggestion (auto-approuvée → tâche liée) puis forcer la tâche
    // en « bloquée » — le cas qui vivait dans l'ancienne zone « en attente ».
    const item = await apiFetch(page, 'POST', '/agent/backlog', { text: SEED_TEXT })
    seedItemId = item.id
    seedTaskId = item.task_id
    assert.ok(seedTaskId, 'le POST /backlog doit auto-approuver et lier une tâche')
    await apiFetch(page, 'PATCH', `/agent/tasks/${seedTaskId}`, {
      status: 'blocked',
      agent_result: '(seed E2E — tâche marquée bloquée pour le test)',
    })
  })

  after(async () => {
    // Toujours retirer le seed et restaurer le toggle, même en cas d'échec.
    try { if (seedTaskId && page) await apiFetch(page, 'DELETE', `/agent/tasks/${seedTaskId}`) } catch {}
    try { if (seedItemId && page) await apiFetch(page, 'DELETE', `/agent/backlog/${seedItemId}`) } catch {}
    try { if (page) await apiFetch(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('la zone « Suggestions & correctifs » a disparu', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Agent autonome', { timeout: 10000 })

    assert.equal(await page.locator('text=Suggestions & correctifs').count(), 0,
      'la zone « Suggestions & correctifs » ne doit plus être rendue')
    assert.equal(await page.locator('text=Aucune suggestion en attente').count(), 0,
      'l\'état vide « Aucune suggestion en attente » ne doit plus être rendu')
  })

  test('une fiche bloquée reste visible dans « En cours d\'implémentation »', async () => {
    // (page déjà sur /agent après le test précédent — recharger pour un état propre)
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Agent autonome', { timeout: 10000 })

    // Scoper sur le titre h2 : le texte d'une carte peut lui aussi contenir
    // « en cours d'implémentation » (strict mode violation sinon).
    const zone = page.locator('h2', { hasText: 'En cours d\'implémentation' })
    await zone.waitFor({ timeout: 5000 })

    const card = page.locator(`[data-testid="col-en-cours"] [data-testid="suggestion-card"]:has-text("${SEED_TEXT}")`)
    await card.waitFor({ timeout: 5000 })
    assert.equal(await card.count(), 1, 'la fiche bloquée doit rester visible')
    assert.ok(await card.locator('text=Bloqué').count() >= 1, 'la fiche doit porter le badge Bloqué')
  })
})
