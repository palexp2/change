const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Overlay d'aide des raccourcis clavier déclenchée par « ? » (standard
// GitHub/Linear/Gmail). Test 100 % lecture/navigation — ne crée aucun record
// et ne modifie aucune configuration.
describe('Overlay raccourcis clavier (« ? »)', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      timezoneId: 'America/Montreal',
    })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('« ? » ouvre l\'overlay et liste les 5 raccourcis de navigation', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="user-avatar-trigger"]', { timeout: 15000 })

    // S'assurer qu'aucun champ n'a le focus, puis frapper « ? ».
    await page.locator('body').click()
    await page.keyboard.press('Shift+Slash')

    const modal = page.locator('[data-testid="keyboard-shortcuts-modal"]')
    await modal.waitFor({ state: 'visible', timeout: 5000 })

    // Titre de la modale.
    assert.equal(await page.locator('h2:has-text("Raccourcis clavier")').count(), 1)

    // Les 5 raccourcis de navigation + Cmd/Ctrl+K + ? = 7 lignes de touches.
    const rows = page.locator('[data-testid="shortcut-keys"]')
    assert.equal(await rows.count(), 7, 'attendu 7 lignes de raccourcis')

    // Les labels de navigation sont présents.
    const txt = await modal.innerText()
    for (const label of ['Tableau de bord', 'Feuille de temps', 'Tickets', 'Pipeline', 'Commandes']) {
      assert.ok(txt.includes(label), `label « ${label} » présent`)
    }
    assert.ok(txt.includes('Recherche globale'), 'Recherche globale présente')
  })

  test('Échap referme l\'overlay', async () => {
    // L'overlay est déjà ouverte depuis le test précédent (même page).
    const modal = page.locator('[data-testid="keyboard-shortcuts-modal"]')
    if (!(await modal.isVisible())) {
      await page.locator('body').click()
      await page.keyboard.press('Shift+Slash')
      await modal.waitFor({ state: 'visible', timeout: 5000 })
    }
    await page.keyboard.press('Escape')
    await modal.waitFor({ state: 'hidden', timeout: 5000 })
    assert.equal(await modal.count(), 0)
  })

  test('« ? » dans un champ de saisie ne déclenche pas l\'overlay', async () => {
    // Ouvrir la recherche globale (Cmd+K) qui contient un input focusé, puis
    // taper « ? » : l'overlay ne doit pas apparaître.
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="user-avatar-trigger"]', { timeout: 15000 })

    // Focus un input réel : la barre de recherche globale.
    await page.locator('body').click()
    await page.keyboard.press('Meta+k')
    const searchInput = page.locator('[data-testid="global-search-input"]')
    await searchInput.waitFor({ state: 'visible', timeout: 5000 })
    await searchInput.fill('?test')

    // L'overlay raccourcis ne doit pas être montée.
    assert.equal(await page.locator('[data-testid="keyboard-shortcuts-modal"]').count(), 0)
    // Le « ? » a bien été saisi comme caractère.
    assert.equal(await searchInput.inputValue(), '?test')
  })
})
