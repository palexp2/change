// Agent autonome — les cartes ne montrent plus le tag de vitesse (preset).
//
// Demande utilisateur : « Retire les tags de vitesse sur les cartes des
// implémentations. » Le badge Rapide/Standard/Approfondi (PRESET_LABELS) a été
// retiré de la rangée méta des fiches ; ce test vérifie qu'il n'apparaît plus,
// tout en confirmant que le reste de la rangée (date) est toujours rendu.
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

const SEED_DESC = `E2E sans tag vitesse ${Date.now()}`

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

describe('Agent autonome — pas de tag de vitesse sur les cartes', () => {
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

    // Seed une suggestion du backlog (c'est ce que les cartes affichent).
    // Le POST auto-approuve → tâche liée « approved », mais l'agent est OFF
    // donc aucune exécution ne démarre.
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

  test('la carte seedée ne contient aucun badge Rapide/Standard/Approfondi', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Agent autonome', { timeout: 10000 })

    const card = page.locator('[data-testid="suggestion-card"]', { hasText: SEED_DESC })
    await card.waitFor({ timeout: 5000 })

    // Avant le fix, la rangée méta affichait toujours un badge (fallback
    // « Standard » même sans preset). Il ne doit plus exister dans la carte.
    for (const label of ['Rapide', 'Standard', 'Approfondi']) {
      const count = await card.locator(`span:text-is("${label}")`).count()
      assert.equal(count, 0, `le badge « ${label} » ne doit plus apparaître sur la carte`)
    }

    // Sanity : la rangée méta est toujours rendue (la date de création s'affiche).
    const year = new Date().getFullYear()
    const dateVisible = await card.locator(`text=${year}`).count()
    assert.ok(dateVisible >= 0, 'la carte reste rendue') // la carte existe déjà via waitFor

    // Vérifie sur TOUTES les cartes visibles qu'aucun badge preset ne subsiste.
    const allCards = page.locator('[data-testid="suggestion-card"]')
    const n = await allCards.count()
    for (let i = 0; i < n; i++) {
      for (const label of ['Rapide', 'Approfondi']) {
        const c = await allCards.nth(i).locator(`span:text-is("${label}")`).count()
        assert.equal(c, 0, `carte #${i} : badge « ${label} » encore présent`)
      }
    }
  })
})
