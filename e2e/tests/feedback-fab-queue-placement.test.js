// Réglages de la bulle « Modifier le système » (FeedbackFab) et du panneau rapide.
//
// La bulle ne propose plus le placement dans la file : une demande écrite à la
// main part à la fin, comme tout le reste (le bouton « Au début / À la fin »
// reste sur /travaux et dans le panneau rapide, où l'on arbitre une file déjà
// remplie). Elle propose en revanche une bascule de modèle à deux choix :
// Auto (modèle Anthropic selon la complexité) ou Opus — Astra est retiré.
//
// Test en LECTURE SEULE : rien n'est déposé dans la file, aucune exécution.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Réglages de dépôt — bulle « Modifier le système » et panneau rapide', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('la bulle propose Auto / Opus et plus aucun placement de file', async () => {
    await page.goto(URL + '/interactions', { waitUntil: 'networkidle' })
    await page.click('[data-testid="feedback-fab"]')
    await page.waitForSelector('[data-testid="feedback-fab-text"]', { timeout: 5000 })

    const opus = page.locator('[data-testid="feedback-model-opus"]')
    const auto = page.locator('[data-testid="feedback-model-auto"]')
    await opus.waitFor({ timeout: 5000 })
    assert.match(await auto.innerText(), /auto/i)
    assert.equal(await page.locator('[data-testid="feedback-model-codex"]').count(), 0, 'Astra n\'est plus proposé')

    await auto.click()
    assert.equal(await auto.getAttribute('aria-checked'), 'true', 'la bascule passe sur Auto')
    assert.equal(await opus.getAttribute('aria-checked'), 'false')
    await opus.click()
    assert.equal(await opus.getAttribute('aria-checked'), 'true', 'la bascule revient sur Opus')

    // Ni Sonnet ni Haïku ne sont plus proposés, et le placement a disparu.
    assert.equal(await page.locator('[data-testid="feedback-model-sonnet"]').count(), 0)
    assert.equal(await page.locator('[data-testid="feedback-model-haiku"]').count(), 0)
    assert.equal(await page.locator('[data-testid="feedback-placement"]').count(), 0)
    // Le moment du départ (« maintenant / ce soir ») a été retiré lui aussi.
    assert.equal(await page.locator('[data-testid="feedback-start"]').count(), 0)
  })

  test('le panneau rapide garde son bouton de placement', async () => {
    await page.goto(URL + '/interactions', { waitUntil: 'networkidle' })
    await page.click('[data-testid="travaux-quick-button"]')
    await page.waitForSelector('[data-testid="travaux-quick-input"]', { timeout: 10000 })

    const btn = page.locator('[data-testid="travaux-quick-priority"]')
    await btn.waitFor({ timeout: 5000 })
    assert.equal(await btn.getAttribute('data-placement'), 'last')
    await btn.click()
    assert.equal(await btn.getAttribute('data-placement'), 'first', 'le bouton bascule vers le début de file')
    // Rien n'est envoyé : la bascule suffit. On referme pour laisser l'app propre.
    await page.click('[data-testid="travaux-quick-close"]')
  })
})
