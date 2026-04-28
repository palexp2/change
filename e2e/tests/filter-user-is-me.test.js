const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function readCount(page) {
  const txt = await page.locator('text=/\\d+\\s+lignes?/').first().textContent()
  return parseInt(txt.match(/(\d+)/)[1], 10)
}

describe('Filtre utilisateur — opérateur "Est moi"', () => {
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
    await page.goto(URL + '/tasks', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Tâches")', { timeout: 10000 })
    // Switch to "Toutes les tâches" view to avoid preset filters
    const tousBtn = page.locator('button:has-text("Toutes les tâches")').first()
    if (await tousBtn.isVisible().catch(() => false)) {
      await tousBtn.click()
      await page.waitForTimeout(500)
    }
  })

  after(async () => { await browser?.close() })

  test('filtre "Est moi" sur champ utilisateur réduit le compteur à 0 pour Claude', async () => {
    const totalBefore = await readCount(page)
    assert.ok(totalBefore > 0, `pas de tâches (count=${totalBefore})`)

    // Clear any previously active filter rows by reloading view
    await page.reload({ waitUntil: 'networkidle' })
    const tousBtn = page.locator('button:has-text("Toutes les tâches")').first()
    if (await tousBtn.isVisible().catch(() => false)) {
      await tousBtn.click()
      await page.waitForTimeout(400)
    }

    // Open filter panel
    await page.click('button:has-text("Filtrer")')
    await page.waitForSelector('text=Ajouter un filtre', { timeout: 3000 })
    await page.click('button:has-text("Ajouter un filtre")')
    await page.waitForTimeout(300)

    // Field select is the first button.select in the panel
    const fieldBtn = page.locator('button.select').first()
    await fieldBtn.click()
    await page.waitForSelector('#field-select-portal', { timeout: 2000 })
    await page.locator('#field-select-portal button', { hasText: 'Responsable' }).first().click()
    await page.waitForTimeout(300)

    // Find the select that contains the "Est moi" option
    const selects = await page.locator('select').all()
    let opSelect = null
    for (const s of selects) {
      const texts = await s.locator('option').allTextContents()
      if (texts.some(t => t.trim() === 'Est moi')) { opSelect = s; break }
    }
    assert.ok(opSelect, `opérateur "Est moi" introuvable dans les selects`)
    const opTexts = await opSelect.locator('option').allTextContents()
    assert.ok(opTexts.includes("N'est pas moi"), `opérateur "N'est pas moi" absent — options: ${opTexts.join('|')}`)

    // Default op after field change = is_me (from defaultOpForType('user')) — count should be 0
    await page.waitForTimeout(400)
    const afterIsMe = await readCount(page)
    assert.equal(afterIsMe, 0, `"Est moi" devrait donner 0 tâche pour Claude, reçu ${afterIsMe}`)

    // Switch to "N'est pas moi"
    await opSelect.selectOption({ label: "N'est pas moi" })
    await page.waitForTimeout(400)
    const afterIsNotMe = await readCount(page)
    assert.equal(afterIsNotMe, totalBefore, `"N'est pas moi" devrait donner ${totalBefore}, reçu ${afterIsNotMe}`)
  })
})
