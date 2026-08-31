// « Collecte de factures » n'a plus qu'une seule entrée de menu : la
// sous-section d'« Extraction de données » (c'est un onglet de cette page).
// Les doublons du groupe Comptabilité et de l'Espace finance sont retirés.
//
// Test 100 % lecture : aucun record créé, modifié ni supprimé — navigation et
// survols seulement. Le seul état écrit est le localStorage du profil
// navigateur jetable (dépliage du groupe de nav).
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const COLLECTE_HREF = '/erp/sale-receipts?onglet=collecte'

describe('Menu — « Collecte de factures » à un seul endroit', () => {
  let browser, ctx, page

  // Le groupe Comptabilité est replié par défaut : on le déplie comme le ferait
  // l'utilisateur.
  async function openComptaGroup(path = '/dashboard') {
    await page.goto(URL + path, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('nav button:has-text("Comptabilité")', { timeout: 15000 })
    if (await page.locator('[data-testid="nav-flyout-trigger"]').count() === 0) {
      await page.click('nav button:has-text("Comptabilité")')
    }
    await page.locator('[data-testid="nav-flyout-trigger"]').waitFor({ state: 'visible', timeout: 5000 })
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    await browser?.close()
  })

  test('le groupe Comptabilité ne liste plus « Collecte de factures »', async () => {
    await openComptaGroup()
    // Aucun sous-menu ouvert ici : tout lien trouvé dans la sidebar serait une
    // entrée de menu à part entière.
    const sidebar = page.locator('[data-testid="app-sidebar"]')
    assert.equal(await sidebar.locator(`a[href="${COLLECTE_HREF}"]`).count(), 0,
      'la sidebar liste encore une entrée « Collecte de factures »')
    assert.equal(await sidebar.getByRole('link', { name: 'Collecte de factures', exact: true }).count(), 0,
      'un lien « Collecte de factures » subsiste dans la sidebar')
    // L'entrée parente, elle, est bien là.
    assert.equal(await sidebar.locator('a[href$="/erp/sale-receipts"]').count(), 1,
      'l\'entrée « Extraction de données » a disparu')
  })

  test('l\'Espace finance non plus — le groupe Fournisseurs garde ses 3 pages', async () => {
    await openComptaGroup()
    await page.hover('[data-testid="nav-flyout-trigger"]')
    const panel = page.locator('[data-testid="nav-flyout-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 5000 })

    assert.equal(await panel.getByRole('link', { name: 'Collecte de factures', exact: true }).count(), 0,
      'l\'Espace finance liste encore « Collecte de factures »')
    assert.equal(await panel.locator(`a[href="${COLLECTE_HREF}"]`).count(), 0,
      'lien vers l\'onglet collecte encore présent dans l\'Espace finance')

    assert.ok(await panel.locator('p:has-text("FOURNISSEURS & ENGAGEMENTS")').count() > 0,
      'le groupe « Fournisseurs & engagements » a disparu')
    for (const label of ['Fournisseurs', 'Dettes long terme', 'Budget marketing']) {
      assert.equal(await panel.getByRole('link', { name: label, exact: true }).count(), 1,
        `section absente du groupe : ${label}`)
    }
    await page.keyboard.press('Escape')
  })

  test('le sous-menu d\'« Extraction de données » ouvre bien l\'onglet collecte', async () => {
    await openComptaGroup()
    await page.hover('nav a[href$="/erp/sale-receipts"]')
    const sub = page.locator('[data-testid="nav-subsection-panel"][data-route="/sale-receipts"]')
    await sub.waitFor({ state: 'visible', timeout: 15000 })
    for (const label of ['Reçus', 'Collecte de factures']) {
      assert.equal(await sub.getByRole('link', { name: label, exact: true }).count(), 1,
        `onglet absent du sous-menu : ${label}`)
    }
    const link = sub.getByRole('link', { name: 'Collecte de factures', exact: true })
    assert.equal(await link.getAttribute('href'), COLLECTE_HREF, 'le lien ne vise pas l\'onglet collecte')

    await link.click()
    await page.waitForURL(u => u.toString().includes('/sale-receipts?onglet=collecte'), { timeout: 10000 })
    const tabBtn = page.locator('[data-testid="tab-collecte"]')
    await tabBtn.waitFor({ state: 'visible', timeout: 15000 })
    assert.ok((await tabBtn.getAttribute('class')).includes('bg-white'), 'l\'onglet Collecte n\'est pas actif')
  })

  test('sur l\'onglet collecte, « Extraction de données » reste allumé dans la sidebar', async () => {
    // Plus aucune entrée ne revendique l'onglet : le parent s'allume sur les deux.
    await page.goto(URL + '/sale-receipts?onglet=collecte', { waitUntil: 'domcontentloaded' })
    const entry = page.locator('[data-testid="app-sidebar"] a[href$="/erp/sale-receipts"]')
    await entry.waitFor({ state: 'visible', timeout: 15000 })
    // Sidebar : l'état actif est porté par la classe `nav-active` (teinte de
    // section), pas par `bg-brand-600` (celui des liens de sous-menu).
    assert.ok((await entry.getAttribute('class')).includes('nav-active'),
      '« Extraction de données » éteint sur l\'onglet collecte')

    // Et il reste allumé sur l'onglet par défaut.
    await page.goto(URL + '/sale-receipts', { waitUntil: 'domcontentloaded' })
    await entry.waitFor({ state: 'visible', timeout: 15000 })
    // Sidebar : l'état actif est porté par la classe `nav-active` (teinte de
    // section), pas par `bg-brand-600` (celui des liens de sous-menu).
    assert.ok((await entry.getAttribute('class')).includes('nav-active'),
      '« Extraction de données » éteint sur l\'onglet Reçus')
  })

  test('⌘K : « collecte » ne remonte plus qu\'à travers Extraction de données', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('nav button:has-text("Comptabilité")', { timeout: 15000 })
    const paletteInput = page.locator('input[placeholder*="Recherche"]')
    for (let i = 0; i < 3 && await paletteInput.count() === 0; i++) {
      await page.locator('h1').first().click({ force: true })
      await page.keyboard.press('Control+k')
      await paletteInput.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
    }
    await paletteInput.first().waitFor({ state: 'visible', timeout: 5000 })
    await page.keyboard.type('collecte de factures')
    await page.waitForTimeout(800)
    const dialog = page.locator('[role="dialog"]').filter({ has: paletteInput }).first()
    const scope = await dialog.count() ? dialog : page
    assert.equal(await scope.locator(`a[href="${COLLECTE_HREF}"]`).count(), 0,
      'la palette propose encore une entrée de menu dédiée à la collecte')
    await page.keyboard.press('Escape')
  })
})
