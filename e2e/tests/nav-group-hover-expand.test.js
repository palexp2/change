// Les sections repliables du menu de gauche (Clients, Envois, Comptabilité...)
// se déplient désormais au survol, sans avoir besoin de cliquer sur l'entête.
// Test 100 % lecture : aucune donnée créée, modifiée ni supprimée.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

describe('Sidebar — sections repliables ouvertes au survol', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('survoler « Clients » déplie la section sans clic', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    const group = page.locator('nav button:has-text("Clients")')
    await group.waitFor({ state: 'visible', timeout: 15000 })
    assert.equal(await group.getAttribute('aria-expanded'), 'false', 'la section devrait démarrer repliée sur /dashboard')

    // Survol pur, sans clic ni navigation.
    await group.hover()
    await page.waitForFunction(() => {
      const btn = [...document.querySelectorAll('nav button')].find(b => b.textContent.includes('Clients'))
      return btn?.getAttribute('aria-expanded') === 'true'
    }, null, { timeout: 3000 })

    const contactsLink = page.locator('nav a[href$="/erp/contacts"]')
    await contactsLink.waitFor({ state: 'visible', timeout: 3000 })
    assert.ok(page.url().endsWith('/dashboard'), `le survol n'aurait pas dû naviguer : ${page.url()}`)
  })

  test('un simple passage rapide de la souris ne déplie pas la section', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    const group = page.locator('nav button:has-text("Envois")')
    await group.waitFor({ state: 'visible', timeout: 15000 })
    assert.equal(await group.getAttribute('aria-expanded'), 'false')

    const box = await group.boundingBox()
    // Traverse le bouton en un mouvement continu, sans s'y arrêter — plus
    // rapide que le délai d'intention (90 ms).
    await page.mouse.move(box.x - 10, box.y + box.height / 2)
    await page.mouse.move(box.x + box.width + 10, box.y + box.height / 2, { steps: 2 })
    await page.mouse.move(box.x + box.width + 100, box.y + box.height / 2)

    assert.equal(await group.getAttribute('aria-expanded'), 'false', 'un simple balayage ne devrait pas déplier la section')
  })

  test('quitter la section après un survol la replie', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    const group = page.locator('nav button:has-text("Clients")')
    await group.waitFor({ state: 'visible', timeout: 15000 })
    assert.equal(await group.getAttribute('aria-expanded'), 'false')

    await group.hover()
    await page.waitForFunction(() => {
      const btn = [...document.querySelectorAll('nav button')].find(b => b.textContent.includes('Clients'))
      return btn?.getAttribute('aria-expanded') === 'true'
    }, null, { timeout: 3000 })

    // Sort complètement de la sidebar, pas juste du bouton.
    await page.mouse.move(700, 400)
    await page.waitForFunction(() => {
      const btn = [...document.querySelectorAll('nav button')].find(b => b.textContent.includes('Clients'))
      return btn?.getAttribute('aria-expanded') === 'false'
    }, null, { timeout: 3000 })
  })

  test('la section de la page courante reste ouverte même en la quittant après un survol', async () => {
    await page.goto(URL + '/orders', { waitUntil: 'domcontentloaded' })
    const group = page.locator('nav button:has-text("Envois")')
    await group.waitFor({ state: 'visible', timeout: 15000 })
    // Active sur /orders : déjà dépliée sans survol.
    assert.equal(await group.getAttribute('aria-expanded'), 'true')

    await group.hover()
    await page.mouse.move(700, 400)
    await page.waitForTimeout(400)
    assert.equal(await group.getAttribute('aria-expanded'), 'true', 'la section de la page courante ne doit pas se replier')
  })
})
