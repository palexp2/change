const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie le drill-down : clic sur une barre du graphique « Coûts d'expédition »
// du tableau de bord → page /achats-fournisseurs filtrée sur la fenêtre de 28 jours
// et le compte « Expédition », avec une bannière offrant un bouton pour effacer.
describe('Dashboard — drill-down "Coûts d\'expédition"', () => {
  let browser, ctx, page

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

  after(async () => { await browser?.close() })

  test('clic sur barre → URL /achats-fournisseurs avec from/to/account, bannière visible', async () => {
    await page.goto(`${URL}/`, { waitUntil: 'networkidle' })
    // S'assurer que la section Coûts d'expédition est rendue (sinon scroll)
    const bar = page.locator('[data-testid^="shipping-bar-"]').first()
    await bar.waitFor({ state: 'attached', timeout: 10000 })
    await bar.scrollIntoViewIfNeeded()
    await bar.click()
    await page.waitForURL(u => u.toString().includes('/achats-fournisseurs'), { timeout: 5000 })

    const sp = new URLSearchParams(page.url().split('?')[1] || '')
    const from = sp.get('from')
    const to = sp.get('to')
    const account = sp.get('account')
    assert.match(from || '', /^\d{4}-\d{2}-\d{2}$/, 'param from doit être ISO YYYY-MM-DD')
    assert.match(to || '', /^\d{4}-\d{2}-\d{2}$/, 'param to doit être ISO YYYY-MM-DD')
    assert.equal(account, 'Expédition', 'param account doit être Expédition')
    // La fenêtre est de 28 jours (Monday anchor inclusive).
    const days = (new Date(to) - new Date(from)) / 86400000
    assert.equal(days, 27, `intervalle attendu 27 jours (28-day window), reçu ${days}`)

    const banner = page.locator('[data-testid="dashboard-filter-banner"]')
    await banner.waitFor({ timeout: 5000 })
    const bannerText = await banner.textContent()
    assert.ok(bannerText.includes('Expédition'), `bannière doit mentionner "Expédition", reçu: ${bannerText}`)
  })

  test('clic sur "Effacer" enlève le filtre et la bannière', async () => {
    // Précondition : on vient du test précédent avec le filtre actif
    const banner = page.locator('[data-testid="dashboard-filter-banner"]')
    await banner.waitFor({ timeout: 5000 })
    await page.click('[data-testid="dashboard-filter-clear"]')
    await page.waitForFunction(() => {
      const u = new URLSearchParams(window.location.search)
      return !u.has('from') && !u.has('to') && !u.has('account')
    }, { timeout: 5000 })
    assert.equal(await banner.count(), 0, 'la bannière doit disparaître après "Effacer"')
  })
})
