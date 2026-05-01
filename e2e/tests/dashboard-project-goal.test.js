const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

describe('Dashboard — Objectif de projets', () => {
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

  test('configuration et affichage de l\'objectif', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    // Vérifie que le widget est présent (titre)
    const widgetTitle = page.locator('h2:has-text("Objectif d\'acquisition de projets")')
    await widgetTitle.waitFor({ state: 'visible', timeout: 5000 })

    // Ouvre le modal de configuration
    const editBtn = page.locator('button:has-text("Configurer un objectif"), .card:has-text("Objectif d\'acquisition de projets") button:has(svg)').first()
    await editBtn.click()

    const modal = page.locator('.fixed.inset-0.z-50 .bg-white').filter({ hasText: "Configurer l'objectif de projets" })
    await modal.waitFor({ state: 'visible', timeout: 3000 })

    // Remplit le formulaire
    const targetQty = "99"
    const startDate = "2026-01-01"
    const endDate = "2026-12-31"

    await modal.locator('input[type="number"]').fill(targetQty)
    await modal.locator('input[type="date"]').first().fill(startDate)
    await modal.locator('input[type="date"]').last().fill(endDate)

    await modal.locator('button:has-text("Enregistrer")').click()
    await modal.waitFor({ state: 'hidden', timeout: 5000 })

    // Vérifie que le widget affiche les bonnes valeurs
    const widgetText = page.locator('.card:has-text("Objectif d\'acquisition de projets")')
    await widgetText.waitFor({ state: 'visible' })
    const innerText = await widgetText.innerText()
    assert.ok(innerText.includes(`/ ${targetQty} projets`), `Le widget devrait afficher / ${targetQty} projets. Reçu: ${innerText}`)
    
    // Vérifie la date dans le sous-titre
    assert.ok(innerText.includes("2026"), "Le widget devrait afficher l'année 2026")
  })
})
