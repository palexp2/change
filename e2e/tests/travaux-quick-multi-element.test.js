// Panneau rapide de la file de travaux — ciblage de PLUSIEURS éléments.
//
// Une intervention porte souvent sur deux ou trois endroits de la même page :
// le mode ciblage ne s'arrête donc plus au premier clic. Ce test couvre
// l'ajout successif, le retrait par re-clic, la reprise du ciblage par-dessus
// une liste existante, et le format du contexte joint au prompt.
//
// La création est INTERCEPTÉE : elle n'atteint jamais le serveur, sinon un vrai
// prompt partirait dans la file et l'agent s'exécuterait sur le repo de prod.
// Aucun record réel n'est créé ni modifié : rien à nettoyer.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const PANEL = '[data-testid="travaux-quick-panel"]'
const BANNER = '[data-testid="travaux-quick-pick-banner"]'
const PICK = '[data-testid="travaux-quick-pick-element"]'
const CHIP = '[data-testid="travaux-quick-element"]'

describe('Panneau rapide — ciblage de plusieurs éléments', () => {
  let browser, ctx, page
  let createBody = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })

    await page.route('**/api/travaux/prompts', async (route) => {
      if (route.request().method() === 'POST') {
        createBody = route.request().postDataJSON()
        return route.fulfill({
          status: 201, contentType: 'application/json',
          body: JSON.stringify({ id: 'e2e-multi-created', title: 'E2E', status: 'queued', messages: [] }),
        })
      }
      return route.continue()
    })
  })

  after(async () => { await browser?.close() })

  test('deux éléments ciblés en une session, retrait par re-clic, contexte numéroté', async () => {
    await page.goto(URL + '/orders', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="travaux-quick-button"]', { timeout: 20000 })
    await page.waitForSelector('main h1', { timeout: 20000 })

    await page.click('[data-testid="travaux-quick-button"]')
    await page.waitForSelector(PANEL, { timeout: 5000 })
    assert.equal(await page.locator(CHIP).count(), 0, 'aucun élément ciblé au départ')

    // ── Session de ciblage : le bandeau reste, on enchaîne les clics ────────
    await page.click(PICK)
    await page.waitForSelector(BANNER, { timeout: 5000 })

    await page.click('main h1')
    await page.waitForFunction(
      () => document.querySelector('[data-testid="travaux-quick-pick-banner"]')?.getAttribute('data-picked-count') === '1',
      null, { timeout: 5000 })
    assert.equal(await page.locator(BANNER).count(), 1, 'le ciblage continue après le premier élément')

    await page.click('[data-testid="travaux-quick-button"]')
    await page.waitForFunction(
      () => document.querySelector('[data-testid="travaux-quick-pick-banner"]')?.getAttribute('data-picked-count') === '2',
      null, { timeout: 5000 })
    // Le clic est neutralisé pendant le ciblage : le panneau ne s'est pas fermé.
    assert.equal(await page.locator(BANNER).count(), 1, 'le bandeau tient toujours')

    // Re-clic sur le même élément = retrait, puis on le remet.
    await page.click('[data-testid="travaux-quick-button"]')
    await page.waitForFunction(
      () => document.querySelector('[data-testid="travaux-quick-pick-banner"]')?.getAttribute('data-picked-count') === '1',
      null, { timeout: 5000 })
    await page.click('[data-testid="travaux-quick-button"]')
    await page.waitForFunction(
      () => document.querySelector('[data-testid="travaux-quick-pick-banner"]')?.getAttribute('data-picked-count') === '2',
      null, { timeout: 5000 })

    // « Terminé » sort du ciblage en gardant les deux éléments.
    await page.click('[data-testid="travaux-quick-skip-pick"]')
    await page.locator(BANNER).waitFor({ state: 'detached', timeout: 5000 })
    await page.waitForSelector(PANEL, { timeout: 5000 })
    assert.equal(await page.locator(CHIP).count(), 2, 'les deux éléments sont listés dans le panneau')

    // ── Reprise du ciblage par-dessus la liste existante ────────────────────
    await page.click(PICK)
    await page.waitForSelector(BANNER, { timeout: 5000 })
    assert.equal(await page.locator(BANNER).getAttribute('data-picked-count'), '2',
      'la session reprend au-dessus des éléments déjà retenus')
    await page.click('main h1')
    await page.waitForFunction(
      () => document.querySelector('[data-testid="travaux-quick-pick-banner"]')?.getAttribute('data-picked-count') === '3',
      null, { timeout: 5000 })
    await page.keyboard.press('Escape')
    await page.locator(BANNER).waitFor({ state: 'detached', timeout: 5000 })
    assert.equal(await page.locator(CHIP).count(), 3, 'Échap garde les éléments retenus')

    // Retrait individuel depuis le panneau.
    await page.locator('[data-testid="travaux-quick-element-remove"]').last().click()
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="travaux-quick-element"]').length === 2,
      null, { timeout: 5000 })

    // ── Contexte joint : les deux éléments, numérotés ───────────────────────
    const contextText = await page.locator('[data-testid="travaux-quick-context"]').innerText()
    assert.ok(contextText.includes('/orders'), `la route reste jointe (vu : ${contextText})`)

    createBody = null
    await page.locator('[data-testid="travaux-quick-input"]').fill('E2E — plusieurs éléments ciblés')
    await page.locator('[data-testid="travaux-quick-submit"]').click()
    await page.waitForTimeout(1000)

    assert.ok(createBody, 'la création doit partir')
    const prompt = createBody.prompt
    assert.ok(prompt.includes('E2E — plusieurs éléments ciblés'), 'le texte saisi est envoyé')
    assert.ok(prompt.includes('Contexte (ERP) : /orders'), `la route est en tête du contexte (vu : ${prompt})`)
    assert.ok(prompt.includes('éléments ciblés par l\'utilisateur (2)'),
      `le contexte annonce deux éléments (vu : ${prompt})`)
    assert.ok(prompt.includes('[1] ') && prompt.includes('[2] '), `les éléments sont numérotés (vu : ${prompt})`)
    assert.ok(prompt.includes('travaux-quick-button'), `l'élément ciblé dans le rail est décrit (vu : ${prompt})`)

    // Les éléments sont vidés après l'envoi.
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="travaux-quick-element"]').length === 0,
      null, { timeout: 5000 })
  })

  test('un seul élément ciblé garde le format historique du contexte', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="travaux-quick-button"]', { timeout: 20000 })
    await page.waitForSelector('main h1', { timeout: 20000 })
    await page.click('[data-testid="travaux-quick-button"]')
    await page.waitForSelector(PANEL, { timeout: 5000 })

    await page.click(PICK)
    await page.waitForSelector(BANNER, { timeout: 5000 })
    await page.click('main h1')
    await page.waitForFunction(
      () => document.querySelector('[data-testid="travaux-quick-pick-banner"]')?.getAttribute('data-picked-count') === '1',
      null, { timeout: 5000 })
    await page.click('[data-testid="travaux-quick-skip-pick"]')
    await page.locator(BANNER).waitFor({ state: 'detached', timeout: 5000 })

    createBody = null
    await page.locator('[data-testid="travaux-quick-input"]').fill('E2E — un seul élément ciblé')
    await page.locator('[data-testid="travaux-quick-submit"]').click()
    await page.waitForTimeout(1000)

    assert.ok(createBody, 'la création doit partir')
    assert.ok(createBody.prompt.includes('élément ciblé par l\'utilisateur : '),
      `format historique conservé pour un seul élément (vu : ${createBody.prompt})`)
    assert.ok(!createBody.prompt.includes('éléments ciblés'), 'pas de format pluriel pour un seul élément')
  })
})
