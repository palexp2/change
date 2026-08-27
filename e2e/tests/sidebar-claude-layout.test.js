// Sidebar façon Claude : barre latérale gauche unique, claire (fond blanc),
// repliable — bouton d'en-tête ET barre verticale cliquable sur toute la
// hauteur du bord droit. Repliée, un mince rail garde logo, réouverture et
// recherche. En haut de la barre : la recherche unifiée (pages/sections +
// contenu, même palette ⌘K).
//
// Test 100 % lecture : aucune donnée créée, modifiée ni supprimée — navigation
// et survols seulement. L'état de repli vit dans le localStorage du profil
// navigateur jetable du test.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const GROUPS = ['Clients', 'Envois', 'Comptabilité', 'Inventaire', 'RH', 'Autres outils']

describe('Sidebar façon Claude — barre claire, repliable, recherche unifiée', () => {
  let browser, ctx, page

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

  test('la sidebar est claire et liste Dashboard, les groupes et la recherche', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    const sidebar = page.locator('[data-testid="app-sidebar"]')
    await sidebar.waitFor({ state: 'visible', timeout: 15000 })

    const bg = await sidebar.evaluate(el => getComputedStyle(el).backgroundColor)
    assert.equal(bg, 'rgb(255, 255, 255)', `fond de sidebar pas blanc : ${bg}`)

    assert.ok(await sidebar.locator('a[href$="/erp/dashboard"]').count() >= 1, 'lien Dashboard absent')
    for (const label of GROUPS) {
      assert.equal(await sidebar.locator(`nav button:has-text("${label}")`).count(), 1, `groupe absent : ${label}`)
    }
    assert.equal(await sidebar.locator('[data-testid="sidebar-search"]').count(), 1, 'bouton recherche absent')
    assert.ok(await sidebar.locator('a[href$="/erp/agent"]').count() >= 1, 'lien Agent absent en bas de barre')
  })

  test('la barre verticale du bord replie la sidebar en un mince rail', async () => {
    const sidebar = page.locator('[data-testid="app-sidebar"]')
    await page.click('[data-testid="sidebar-collapse-edge"]')
    await page.locator('[data-testid="sidebar-reopen"]').waitFor({ state: 'visible', timeout: 5000 })
    // La largeur est animée (200 ms) : attendre qu'elle se stabilise.
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="app-sidebar"]').getBoundingClientRect().width < 80,
    null, { timeout: 5000 })
    // Le rail garde la recherche à portée.
    assert.equal(await sidebar.locator('button[title*="Rechercher"]').count(), 1, 'recherche absente du rail')
  })

  test('l\'état replié survit à un rechargement, puis se rouvre', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('[data-testid="sidebar-reopen"]').waitFor({ state: 'visible', timeout: 15000 })

    await page.click('[data-testid="sidebar-reopen"]')
    await page.locator('[data-testid="sidebar-search"]').waitFor({ state: 'visible', timeout: 5000 })
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="app-sidebar"]').getBoundingClientRect().width > 200,
    null, { timeout: 5000 })
  })

  test('le bouton d\'en-tête replie aussi la sidebar', async () => {
    await page.click('[data-testid="sidebar-collapse"]')
    await page.locator('[data-testid="sidebar-reopen"]').waitFor({ state: 'visible', timeout: 5000 })
    await page.click('[data-testid="sidebar-reopen"]')
    await page.locator('[data-testid="sidebar-search"]').waitFor({ state: 'visible', timeout: 5000 })
  })

  test('la recherche de la sidebar ouvre la palette unifiée (sections + contenu)', async () => {
    await page.click('[data-testid="sidebar-search"]')
    const input = page.locator('input[placeholder*="Recherche"]')
    await input.waitFor({ state: 'visible', timeout: 5000 })
    // Taper dans l'input lui-même : le focus n'arrive qu'après ~50 ms, une
    // frappe clavier « globale » trop rapide partirait dans le vide.
    await input.fill('rapprochement')
    // Le nom d'une section suffit pour la retrouver et y aller.
    await page.waitForSelector('text=Rapprochement bancaire', { timeout: 5000 })
    await page.keyboard.press('Escape')
    await input.waitFor({ state: 'detached', timeout: 5000 })
  })

  test('accordéon : ouvrir Clients montre ses sous-sections, sans naviguer', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    const group = page.locator('nav button:has-text("Clients")')
    await group.waitFor({ state: 'visible', timeout: 15000 })
    if (await group.getAttribute('aria-expanded') === 'false') await group.click()
    for (const href of ['/erp/contacts', '/erp/companies', '/erp/pipeline']) {
      await page.locator(`nav a[href="${href}"]`).waitFor({ state: 'visible', timeout: 5000 })
    }
    assert.ok(page.url().endsWith('/dashboard'), `l'accordéon a navigué : ${page.url()}`)
  })

  test('le compte en bas de barre ouvre son menu au-dessus', async () => {
    await page.hover('[data-testid="user-avatar-trigger"]')
    const item = page.locator('[data-testid="user-menu-settings"]')
    await item.waitFor({ state: 'visible', timeout: 5000 })
    const itemBox = await item.boundingBox()
    const triggerBox = await page.locator('[data-testid="user-avatar-trigger"]').boundingBox()
    assert.ok(itemBox.y < triggerBox.y, 'le menu du compte ne s\'ouvre pas au-dessus')
    await page.keyboard.press('Escape')
  })
})
