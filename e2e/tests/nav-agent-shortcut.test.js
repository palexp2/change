// Raccourci de navigation admin-only vers l'onglet Agent des paramètres.
//
// Lecture seule (rendu de la sidebar) — aucun record créé ni config mutée → pas
// de cleanup nécessaire. Le test vérifie : le lien « Agent » apparaît dans la nav
// du bas pour un admin, et un clic navigue bien vers /admin/agent.

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

describe('Nav — raccourci admin vers l\'onglet Agent', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    await browser?.close()
  })

  test('le lien Agent est présent dans la sidebar et navigue vers /admin/agent', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    // Le raccourci pointe vers /admin/agent (href avec basename /erp).
    const link = page.locator('a[href$="/admin/agent"]')
    await link.first().waitFor({ state: 'visible', timeout: 10000 })

    // Libellé « Agent ».
    const text = await link.first().innerText()
    assert.ok(/Agent/.test(text), 'le lien doit afficher le libellé « Agent »')

    // Clic → navigation réelle vers l'onglet Agent des paramètres.
    await link.first().click()
    await page.waitForURL(u => u.toString().includes('/admin/agent'), { timeout: 10000 })
    assert.ok(page.url().includes('/admin/agent'), 'le clic doit naviguer vers /admin/agent')

    // L'onglet Agent doit être actif dans la page Paramètres.
    await page.waitForSelector('button:has-text("Agent")', { timeout: 10000 })
  })
})
