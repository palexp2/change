// /tickets — titre de page : icône du menu à gauche + filet de la teinte de section.
//
// Le titre « Billets » reprend le repère visuel de la sidebar : l'icône de son
// entrée de menu, et un filet sous le titre dans la couleur du groupe Clients
// (`--acc-clients`). Test lecture seule — aucun record créé ni modifié.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

describe('Titre /tickets — icône + filet de section', () => {
  let browser, page

  before(async () => {
    browser = await chromium.launch()
    page = await browser.newPage()
    await login(page)
    await page.goto(URL + '/tickets', { waitUntil: 'domcontentloaded' })
    await page.getByTestId('page-title').waitFor({ timeout: 15000 })
  })

  after(async () => { if (browser) await browser.close() })

  test('le titre affiche « Billets » avec une icône à sa gauche', async () => {
    const title = page.getByTestId('page-title')
    assert.match((await title.innerText()).trim(), /^Billets$/)

    const icon = page.getByTestId('page-title-icon')
    assert.equal(await icon.count(), 1, 'icône de titre absente')

    const iconBox = await icon.boundingBox()
    const textBox = await title.locator('h1 span').boundingBox()
    assert.ok(iconBox && textBox, 'icône ou texte non rendus')
    assert.ok(iconBox.x + iconBox.width <= textBox.x + 1, "l'icône n'est pas à gauche du titre")
  })

  test('un filet reprend la couleur de la section Clients du menu', async () => {
    const rule = page.getByTestId('page-title-rule')
    assert.equal(await rule.count(), 1, 'filet absent')

    const box = await rule.boundingBox()
    assert.ok(box && box.height > 0 && box.width > 20, 'filet non visible')

    // Même teinte que le groupe de menu « Clients » (--acc-clients).
    const [ruleColor, accent] = await Promise.all([
      rule.evaluate(el => getComputedStyle(el).backgroundColor),
      page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--acc-clients').trim()),
    ])
    const [r, g, b] = accent.split(/\s+/).map(Number)
    assert.ok(ruleColor.startsWith(`rgba(${r}, ${g}, ${b}`), `filet ${ruleColor} ≠ teinte clients ${accent}`)
  })
})
