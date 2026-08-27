// La palette Cmd+K supporte désormais des commandes slash pour restreindre la
// recherche à un seul type de record : `/fournisseur(s) <texte>` ne montre que
// les profils fournisseurs correspondants, `/abonnement(s) <texte>` ne montre
// que les abonnements fournisseurs — sans le bruit des pages ni des autres
// records.
//
// Le profil fournisseur et l'abonnement de test sont créés/supprimés via
// l'API (before()/after()) — aucun record réel n'est muté.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('GlobalSearch — commandes slash /fournisseur et /abonnement', () => {
  let browser, ctx, page
  let profileId, subId
  const tag = Date.now().toString(36).toUpperCase()
  const vendorName = `Fournisseur Slash ${tag}`

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    const profileRes = await page.evaluate(async ({ name }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/vendor-profiles', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      return { status: r.status, body: await r.json() }
    }, { name: vendorName })
    assert.strictEqual(profileRes.status, 201)
    profileId = profileRes.body.id

    const subRes = await page.evaluate(async ({ vendor }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/vendor-subscriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendor }),
      })
      return { status: r.status, body: await r.json() }
    }, { vendor: vendorName })
    assert.strictEqual(subRes.status, 201)
    subId = subRes.body.id
  })

  after(async () => {
    if (subId) {
      await page.evaluate(async ({ id }) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/vendor-subscriptions/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
      }, { id: subId })
    }
    if (profileId) {
      await page.evaluate(async ({ id }) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/vendor-profiles/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
      }, { id: profileId })
    }
    await browser?.close()
  })

  test('/fournisseur <texte> ne montre que le profil fournisseur ciblé', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.keyboard.press('Control+k')
    await page.waitForSelector('[data-testid="global-search-input"]', { state: 'visible', timeout: 5000 })

    await page.fill('[data-testid="global-search-input"]', `/fournisseur ${vendorName}`)
    await page.waitForSelector('li:has-text("Fournisseurs")', { timeout: 5000 })

    // Un seul résultat, correspondant au profil créé — pas de section « Aller à ».
    const resultBtn = page.locator('li', { hasText: vendorName }).locator('button', { hasText: vendorName })
    await resultBtn.first().waitFor({ state: 'visible', timeout: 5000 })
    const pageSection = page.locator('li:has-text("Aller à")')
    assert.strictEqual(await pageSection.count(), 0, 'aucune page ne doit apparaître en mode commande')

    await resultBtn.first().click()
    await page.waitForURL(u => u.toString().includes('/fournisseurs'), { timeout: 10000 })
    await page.waitForSelector(`h2:has-text("${vendorName}")`, { timeout: 10000 })
  })

  test('/abonnements <texte> ne montre que l\'abonnement fournisseur ciblé', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.keyboard.press('Control+k')
    await page.waitForSelector('[data-testid="global-search-input"]', { state: 'visible', timeout: 5000 })

    await page.fill('[data-testid="global-search-input"]', `/abonnements ${vendorName}`)
    await page.waitForSelector('li:has-text("Abonnements fournisseurs")', { timeout: 5000 })

    const resultBtn = page.locator('li', { hasText: vendorName }).locator('button', { hasText: vendorName })
    await resultBtn.first().waitFor({ state: 'visible', timeout: 5000 })

    await resultBtn.first().click()
    await page.waitForURL(u => u.toString().includes('/fournisseurs/abonnements'), { timeout: 10000 })
    await page.waitForSelector(`h2:has-text("${vendorName}")`, { timeout: 10000 })
  })
})
