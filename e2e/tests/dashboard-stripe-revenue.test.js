const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

describe('Dashboard — Ventes et abonnements (12 mois, abonnement vs vente)', () => {
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

  test('la section affiche 12 mois avec breakdown abonnement/vente et comparaison An. préc.', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    const card = page.locator('.card').filter({ has: page.locator('h2:has-text("Ventes et abonnements")') })
    await card.waitFor({ state: 'visible', timeout: 8000 })

    const cardText = await card.innerText()
    assert.ok(cardText.includes('Abonnement'), `Légende Abonnement attendue. Reçu: ${cardText.slice(0, 300)}`)
    assert.ok(cardText.includes('Vente'), `Légende Vente attendue. Reçu: ${cardText.slice(0, 300)}`)
    assert.ok(cardText.includes('Abonnement an. préc.'), `Légende « Abonnement an. préc. » attendue. Reçu: ${cardText.slice(0, 300)}`)
    assert.ok(cardText.includes('Vente an. préc.'), `Légende « Vente an. préc. » attendue. Reçu: ${cardText.slice(0, 300)}`)

    const monthGroups = card.locator('[data-testid^="stripe-revenue-month-"]')
    const count = await monthGroups.count()
    assert.equal(count, 12, `Devrait afficher 12 mois, reçu ${count}`)
  })

  test('cliquer sur une barre abonnement navigue vers /factures avec month + type=service', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    const card = page.locator('.card').filter({ has: page.locator('h2:has-text("Ventes et abonnements")') })
    await card.waitFor({ state: 'visible', timeout: 8000 })

    // Si la DB est vide → message d'état vide, on skip.
    const emptyMsg = await card.locator('text=/Aucune vente ni abonnement/').count()
    if (emptyMsg > 0) return

    const aboBar = card.locator('svg path[fill="#21B14B"], svg path[fill="#1B8E3C"]').first()
    const hasAbo = await aboBar.count()
    if (!hasAbo) {
      const venteBar = card.locator('svg path[fill="#f59e0b"], svg path[fill="#d97706"]').first()
      const hasVente = await venteBar.count()
      assert.ok(hasVente, 'Aucune barre abonnement ni vente trouvée — données absentes ou sélecteur cassé')
      await venteBar.click()
      await page.waitForURL(u => /month=\d{4}-\d{2}.*type=achat/.test(u.toString()), { timeout: 5000 })
    } else {
      await aboBar.click()
      await page.waitForURL(u => /month=\d{4}-\d{2}.*type=service/.test(u.toString()), { timeout: 5000 })
    }

    const url = page.url()
    assert.match(url, /\/factures\?month=\d{4}-\d{2}&type=(service|achat)/, `URL inattendue: ${url}`)

    await page.locator('text=/Ventes & abonnements — facturées en/').first().waitFor({ state: 'visible', timeout: 5000 })
  })

  test('le bouton X efface le filtre depuis la page Factures', async () => {
    const monthKey = (() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    })()
    await page.goto(`${URL}/factures?month=${monthKey}&type=service`, { waitUntil: 'networkidle' })

    const banner = page.locator('text=/Ventes & abonnements — facturées en/').first()
    await banner.waitFor({ state: 'visible', timeout: 5000 })

    await page.locator('button[aria-label="Effacer le filtre"]').click()
    await page.waitForURL(u => !u.toString().includes('month='), { timeout: 5000 })
    await page.waitForTimeout(300)
    const stillThere = await page.locator('text=/Ventes & abonnements — facturées en/').count()
    assert.equal(stillThere, 0, 'Le bandeau de filtre devrait disparaître après clic sur X')
  })
})
