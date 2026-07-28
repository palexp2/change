const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const VENDOR = `E2E Abo ${Date.now()}`

describe('Abonnements fournisseurs — page + CRUD autosave', () => {
  let browser, ctx, page, createdId

  const apiFetch = (path, opts = {}) => page.evaluate(async ({ path, opts }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts })

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => {
    // Cleanup — s'exécute même si un test a échoué.
    try {
      if (createdId) await apiFetch(`/vendor-subscriptions/${createdId}`, { method: 'DELETE' })
    } catch {}
    await browser?.close()
  })

  test('la page liste le registre importé', async () => {
    await page.goto(URL + '/abonnements-fournisseurs', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Abonnements fournisseurs")', { timeout: 15000 })
    // Le registre importé du sheet doit contenir Anthropic.
    // « Self-serve Business » (plan Airtable) n'apparaît que dans le DataTable.
    await page.waitForSelector('text=Self-serve Business', { timeout: 20000 })
  })

  test('création via la modale', async () => {
    await page.click('button:has-text("Nouvel abonnement")')
    await page.waitForSelector('[data-testid="new-sub-vendor"]')
    await page.fill('[data-testid="new-sub-vendor"]', VENDOR)
    await page.click('[data-testid="new-sub-create"]')
    await page.waitForSelector(`text=${VENDOR}`, { timeout: 30000 })
    const list = await apiFetch('/vendor-subscriptions')
    const created = list.body.find(s => s.vendor === VENDOR)
    assert.ok(created, 'abonnement créé introuvable via API')
    createdId = created.id
  })

  test('édition autosave (blur) dans la fiche', async () => {
    await page.click(`text=${VENDOR}`)
    await page.waitForSelector(`text=Modifications sauvegardées automatiquement`, { timeout: 15000 })
    const planInput = page.locator('[data-testid="sub-plan"]')
    await planInput.fill('Plan E2E')
    await planInput.blur()
    // Valider via l'API (poll) — pas l'état DOM.
    let saved = null
    for (let i = 0; i < 60; i++) {
      const r = await apiFetch(`/vendor-subscriptions/${createdId}`)
      if (r.body?.plan === 'Plan E2E') { saved = r.body; break }
      await new Promise(res => setTimeout(res, 300))
    }
    assert.ok(saved, 'le plan édité n\'a pas été autosauvegardé')
    await page.keyboard.press('Escape')
  })

  test('endpoint missing-receipts répond avec la structure attendue', async () => {
    const r = await apiFetch('/vendor-subscriptions/missing-receipts')
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.missing))
    for (const m of r.body.missing) {
      assert.ok(m.vendor && m.expected_date, 'entrée missing incomplète')
    }
  })

  test('suppression (soft delete)', async () => {
    const del = await apiFetch(`/vendor-subscriptions/${createdId}`, { method: 'DELETE' })
    assert.equal(del.status, 200)
    const gone = await apiFetch(`/vendor-subscriptions/${createdId}`)
    assert.equal(gone.status, 404)
    createdId = null
  })
})
