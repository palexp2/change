// Raccourci de navigation vers la page Agent (visible par TOUS les utilisateurs).
//
// Lecture seule (rendu de la sidebar) — aucun record créé ni config mutée → pas
// de cleanup nécessaire. Le test vérifie : le lien « Agent » apparaît dans la nav
// du bas, et un clic navigue bien vers /agent.

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

  test('le lien Agent est présent dans la sidebar et navigue vers /agent', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    // Le raccourci pointe vers /agent (href avec basename /erp).
    const link = page.locator('a[href$="/agent"]:not([href*="admin"])')
    await link.first().waitFor({ state: 'visible', timeout: 10000 })

    // Libellé « Agent ».
    const text = await link.first().innerText()
    assert.ok(/Agent/.test(text), 'le lien doit afficher le libellé « Agent »')

    // Clic → navigation réelle vers la page Agent.
    await link.first().click()
    await page.waitForURL(u => u.toString().endsWith('/agent'), { timeout: 10000 })

    // La page Agent doit se rendre (header).
    await page.waitForSelector('text=Agent autonome', { timeout: 10000 })
  })
})
