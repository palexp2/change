// Test : l'entrée admin du bas de sidebar s'appelle « Admin » (plus « Paramètres »)
// et la page Admin n'a plus d'onglet « Agent » (l'ancienne URL redirige vers /agent).
// Lecture seule : aucun record créé ni modifié.

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

describe('Admin — renommage sidebar + retrait de l\'onglet Agent', () => {
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

  test('la sidebar affiche « Admin » et plus « Paramètres »', async () => {
    await page.goto(URL + '/settings', { waitUntil: 'networkidle' })
    const sidebar = page.locator('[data-testid="app-sidebar"]')
    await sidebar.waitFor({ state: 'visible', timeout: 10000 })

    const adminLink = sidebar.locator('a[href="/erp/admin"]')
    await adminLink.waitFor({ state: 'visible', timeout: 5000 })
    assert.equal((await adminLink.innerText()).trim(), 'Admin')

    const settingsLabel = sidebar.locator('a[href="/erp/admin"]:has-text("Paramètres")')
    assert.equal(await settingsLabel.count(), 0, 'l\'entrée admin ne doit plus s\'appeler Paramètres')

    // L'entrée Agent reste, elle, dans la sidebar.
    assert.equal(await sidebar.locator('a[href="/erp/agent"]').count(), 1)
  })

  test('la page Admin s\'intitule « Admin » et n\'a pas d\'onglet Agent', async () => {
    await page.goto(URL + '/admin', { waitUntil: 'networkidle' })
    await page.locator('h1:has-text("Admin")').first().waitFor({ state: 'visible', timeout: 10000 })

    const tabsBar = page.locator('button:has-text("Connecteurs")').locator('..')
    await tabsBar.waitFor({ state: 'visible', timeout: 5000 })
    const tabLabels = (await tabsBar.locator('button').allInnerTexts()).map(t => t.trim())
    assert.ok(tabLabels.includes('Connecteurs'), `onglets trouvés : ${tabLabels.join(', ')}`)
    assert.ok(!tabLabels.includes('Agent'), `l'onglet Agent doit avoir disparu : ${tabLabels.join(', ')}`)
  })

  test('/admin/agent redirige vers la page Agent', async () => {
    await page.goto(URL + '/admin/agent', { waitUntil: 'networkidle' })
    await page.waitForURL(u => u.toString().includes('/agent') && !u.toString().includes('/admin'), { timeout: 10000 })
    assert.ok(page.url().endsWith('/agent'), `URL après redirection : ${page.url()}`)
  })
})
