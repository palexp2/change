// Collecte de factures — Simplex Wireless est proposé comme portail cible.
//
// Le test est en LECTURE SEULE : il ouvre la fenêtre « Nouveau compte », vérifie
// que Simplex Wireless figure dans la liste des fournisseurs servie par le
// serveur et que le choisir affiche bien les libellés de ses champs, puis ferme
// la fenêtre. Aucun compte n'est créé, aucune tournée n'est lancée (elle taperait
// sur le vrai portail Simplex).
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Collecte de factures — Simplex Wireless', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
  })

  after(async () => {
    // Rien à nettoyer : aucune écriture en base.
    await browser?.close()
  })

  test('Simplex Wireless est un portail proposé au nouveau compte de collecte', async () => {
    await page.goto(`${URL}/sale-receipts?onglet=collecte`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="tab-collecte"]', { timeout: 20000 })

    await page.click('button:has-text("Nouveau compte")')
    const dialog = page.locator('[role="dialog"]')
    await dialog.waitFor({ state: 'visible', timeout: 10000 })
    const select = dialog.locator('select').first()
    await select.waitFor({ state: 'visible', timeout: 10000 })

    const options = await select.locator('option').allInnerTexts()
    assert.ok(options.includes('Simplex Wireless'),
      `Simplex Wireless doit être proposé — options vues : ${options.join(', ')}`)

    // Le choisir doit adapter les libellés des identifiants au portail Simplex.
    await select.selectOption({ label: 'Simplex Wireless' })
    const labels = await dialog.locator('label').allInnerTexts()
    assert.ok(labels.some(l => l.includes('Courriel du compte Simplex')),
      `le libellé du courriel doit être celui de Simplex — libellés vus : ${labels.join(' | ')}`)

    // Lecture seule : on referme sans créer.
    await dialog.locator('button:has-text("Annuler")').click()
    await dialog.waitFor({ state: 'detached', timeout: 10000 })
  })
})
