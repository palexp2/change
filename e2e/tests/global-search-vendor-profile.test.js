// La recherche globale (Cmd+K) n'indexait pas les profils fournisseurs — un nom
// de fournisseur tapé n'ouvrait rien. Vérifie que taper le nom d'un fournisseur
// dans la palette propose sa fiche et que le clic ouvre bien sa fiche d'édition
// sur /fournisseurs.
//
// Le profil de test est créé/supprimé via l'API (after()) — aucun record réel
// n'est muté.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('GlobalSearch — profil fournisseur', () => {
  let browser, ctx, page
  let profileId
  const tag = Date.now().toString(36).toUpperCase()
  const vendorName = `Fournisseur Test ${tag}`

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    const res = await page.evaluate(async ({ name }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/vendor-profiles', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      return { status: r.status, body: await r.json() }
    }, { name: vendorName })
    assert.strictEqual(res.status, 201)
    profileId = res.body.id
  })

  after(async () => {
    if (profileId) {
      await page.evaluate(async ({ id }) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/vendor-profiles/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
      }, { id: profileId })
    }
    await browser?.close()
  })

  test('taper le nom du fournisseur dans la palette propose sa fiche et le clic l\'ouvre', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.keyboard.press('Control+k')
    await page.waitForSelector('[data-testid="global-search-input"]', { state: 'visible', timeout: 5000 })

    await page.fill('[data-testid="global-search-input"]', vendorName)
    const resultBtn = page.locator('li', { hasText: vendorName }).locator('button', { hasText: vendorName })
    await resultBtn.first().waitFor({ state: 'visible', timeout: 5000 })
    await resultBtn.first().click()

    await page.waitForURL(u => u.toString().includes('/fournisseurs'), { timeout: 10000 })
    await page.waitForSelector(`h2:has-text("${vendorName}")`, { timeout: 10000 })
    assert.ok(page.url().includes('/fournisseurs'), 'le clic doit naviguer vers /fournisseurs')
  })
})
