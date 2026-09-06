// Vérifie que dans l'onglet "abonnements" d'une fiche compagnie, cliquer sur
// une ligne d'abonnement ouvre le modal standard AbonnementDetailModal
// (plutôt que l'ancien panneau inline).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Compagnie — onglet abonnements ouvre le modal de détail', () => {
  let browser, ctx, page, pageErrors

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    pageErrors = []
    page.on('pageerror', err => pageErrors.push(err.message))
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('cliquer une ligne dans l\'onglet abonnements ouvre le modal', async () => {
    // Aller sur la liste d'abonnements, suivre le premier lien compagnie
    await page.goto(`${URL}/abonnements`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })

    const companyLink = page.locator('a[href*="/companies/"]').first()
    await companyLink.waitFor({ state: 'visible', timeout: 5000 })
    const href = await companyLink.getAttribute('href')
    assert.ok(href, 'doit trouver un lien vers une compagnie')

    await page.goto(URL.replace(/\/erp$/, '') + href, { waitUntil: 'networkidle' })

    // Ouvrir l'onglet abonnements
    await page.locator('button:has-text("abonnements")').first().click()

    // Attendre qu'il y ait au moins une ligne d'abonnement (div DataTable)
    const row = page.locator('[data-row-id]').first()
    await row.waitFor({ state: 'visible', timeout: 10000 })

    pageErrors.length = 0
    await row.click()

    // Le modal standard utilise le titre "Détails de l'abonnement"
    await page.waitForSelector('text=/Détails de l.abonnement/', { timeout: 5000 })

    // Le modal doit être rendu dans une portail (rôle dialog OU overlay fixe).
    // On vérifie surtout qu'il s'agit bien d'un modal overlay et non d'un
    // panneau inline : présence d'un backdrop avec position fixed.
    const dialog = page.locator('[role="dialog"], .fixed.inset-0').first()
    await dialog.waitFor({ state: 'visible', timeout: 3000 })

    assert.equal(pageErrors.length, 0, `pageerror : ${pageErrors.join(' | ')}`)
  })
})
