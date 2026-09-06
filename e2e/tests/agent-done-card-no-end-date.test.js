// Agent autonome — la carte d'une implémentation terminée, une fois dépliée,
// ne doit plus afficher la date/heure de fin (« terminé le … ») ni le rappel
// « Durée d'exécution : … ». La durée reste visible via le badge en tête de
// carte (data-testid card-duration) et l'heure de début est déjà affichée.
//
// Signalement utilisateur : ces infos en dépli étaient redondantes.
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

const SEED_DESC = `E2E carte terminée sans date de fin ${Date.now()}`

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

describe('Agent autonome — carte terminée sans date de fin ni durée en dépli', () => {
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

    // Seed : suggestion auto-approuvée + tâche liée marquée terminée avec des
    // horodatages début/fin distincts (pour que durée et date de fin existent).
    const created = await apiFetch(page, 'POST', '/agent/backlog', { text: SEED_DESC })
    seedId = created.id
    seedTaskId = created.task_id || null
    assert.ok(seedTaskId, 'le POST /backlog doit créer une tâche liée')

    const end = new Date()
    const start = new Date(end.getTime() - 5 * 60 * 1000)
    await apiFetch(page, 'PATCH', `/agent/tasks/${seedTaskId}`, {
      status: 'done',
      user_summary: 'Résumé de test : le correctif a été implanté.',
      started_at: start.toISOString(),
      completed_at: end.toISOString(),
    })
  })

  after(async () => {
    try { if (seedId && page) await apiFetch(page, 'DELETE', `/agent/backlog/${seedId}`) } catch {}
    try { if (seedTaskId && page) await apiFetch(page, 'DELETE', `/agent/tasks/${seedTaskId}`) } catch {}
    try { if (page) await apiFetch(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('le badge de durée reste en tête de carte, mais le dépli ne répète ni durée ni date de fin', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Agent autonome', { timeout: 10000 })

    const card = page.locator('[data-testid="suggestion-card"]', { hasText: SEED_DESC })
    await card.waitFor({ timeout: 5000 })

    // Le badge de durée en tête de carte doit rester présent.
    assert.equal(await card.locator('[data-testid="card-duration"]').count(), 1,
      'le badge de durée doit rester visible en tête de carte')

    // Déplie la carte et attend le contenu déplié.
    await card.locator('.cursor-pointer').first().click()
    await card.locator('[data-testid="suggestion-user-summary"]').waitFor({ timeout: 5000 })

    // Ni « Durée d'exécution » ni « terminé le » ne doivent apparaître.
    const txt = (await card.innerText()).replace(/\s+/g, ' ')
    assert.ok(!txt.includes('Durée d\'exécution'),
      `« Durée d'exécution » ne doit plus apparaître en dépli (reçu: « ${txt.slice(0, 300)} »)`)
    assert.ok(!txt.includes('terminé le'),
      `« terminé le » (date de fin) ne doit plus apparaître en dépli (reçu: « ${txt.slice(0, 300)} »)`)
  })
})
