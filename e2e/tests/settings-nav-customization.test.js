const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Page Paramètres perso (/settings) — section « Menu de gauche ».
// L'utilisateur coche/décoche des items pour les afficher/cacher dans la sidebar.
// Préférence par utilisateur (nav_hidden), live + autosave.
//
// IMPORTANT : nav_hidden est une CONFIG utilisateur existante (pas un record
// créé par le test) → on lit la valeur originale avant et on la restaure dans
// after(), même en cas d'échec (cf. CLAUDE.md).
describe('Paramètres — customisation du menu de gauche', () => {
  let browser, ctx, page, token, originalHidden

  async function getPrefs() {
    return page.evaluate(async (base) => {
      const t = localStorage.getItem('erp_token')
      const r = await fetch(base + '/api/auth/preferences', { headers: { Authorization: 'Bearer ' + t } })
      return r.json()
    }, URL)
  }

  async function setPrefs(arr) {
    return page.evaluate(async ({ base, arr }) => {
      const t = localStorage.getItem('erp_token')
      const r = await fetch(base + '/api/auth/preferences', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: JSON.stringify({ nav_hidden: arr }),
      })
      return r.json()
    }, { base: URL, arr })
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
    // Sauvegarde de la config existante pour restauration en after().
    originalHidden = (await getPrefs()).nav_hidden || []
    // Part d'un état propre (tout visible) pour des assertions déterministes.
    await setPrefs([])
  })

  after(async () => {
    // Restaure toujours la valeur d'origine, même si un test a échoué.
    try { if (page && originalHidden !== undefined) await setPrefs(originalHidden) } catch {}
    await browser?.close()
  })

  test('le lien Paramètres du menu avatar mène à /settings', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.hover('[data-testid="user-avatar-trigger"]')
    await page.waitForSelector('[data-testid="user-menu-settings"]', { timeout: 5000 })
    const href = await page.getAttribute('[data-testid="user-menu-settings"]', 'href')
    assert.match(href, /\/settings$/, `lien Paramètres → /settings (got ${href})`)
  })

  test('la page /settings affiche les sections Menu et Fichiers', async () => {
    await page.goto(URL + '/settings', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="settings-section-menu"]', { timeout: 10000 })
    assert.equal(await page.locator('[data-testid="settings-section-fichiers"]').count(), 1)
    // La section Fichiers contient un bouton vers /public-files.
    await page.click('[data-testid="settings-section-fichiers"]')
    const fileHref = await page.getAttribute('[data-testid="settings-public-files-link"]', 'href')
    assert.match(fileHref, /\/public-files$/, `bouton Fichiers → /public-files (got ${fileHref})`)
  })

  test('décocher un item à plat le cache de la sidebar (live + persistance)', async () => {
    await page.goto(URL + '/settings', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="settings-section-menu"]', { timeout: 10000 })
    // La colonne de gauche est contextuelle : afficher la section « Autres
    // outils », qui contient « Fichiers publics » (/public-files).
    await page.click('nav button:has-text("Autres outils")')
    const navLink = page.locator('nav a[href$="/public-files"]')
    await navLink.waitFor({ state: 'visible', timeout: 5000 })
    assert.equal(await navLink.count(), 1, 'Fichiers publics présent dans la sidebar au départ')

    await page.click('[data-testid="nav-toggle-/public-files"]')
    // Live : disparaît de la sidebar sans rechargement.
    await page.waitForFunction(() => !document.querySelector('nav a[href$="/public-files"]'), null, { timeout: 5000 })

    // Persistance DB.
    const prefs = await getPrefs()
    assert.ok(prefs.nav_hidden.includes('/public-files'), 'nav_hidden contient /public-files')

    // Re-cocher → réapparaît.
    await page.click('[data-testid="nav-toggle-/public-files"]')
    await page.waitForSelector('nav a[href$="/public-files"]', { timeout: 5000 })
    const after = await getPrefs()
    assert.ok(!after.nav_hidden.includes('/public-files'), '/public-files retiré de nav_hidden')
  })

  test('la recherche filtre les options à afficher/cacher', async () => {
    await page.goto(URL + '/settings', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="nav-search"]', { timeout: 10000 })

    // Recherche par label d'item : « Billets » → l'item /tickets reste, le reste filtré.
    await page.fill('[data-testid="nav-search"]', 'Billets')
    await page.waitForSelector('[data-testid="nav-toggle-/tickets"]', { timeout: 5000 })
    assert.equal(await page.locator('[data-testid="nav-toggle-/dashboard"]').count(), 0,
      'Dashboard filtré quand on cherche « Billets »')

    // Recherche par nom de groupe : « Inventaire » → le groupe + ses items.
    await page.fill('[data-testid="nav-search"]', 'Inventaire')
    await page.waitForSelector('[data-testid="nav-toggle-group:Inventaire"]', { timeout: 5000 })
    assert.ok(await page.locator('[data-testid="nav-toggle-/products"]').count() >= 1,
      'items du groupe Inventaire affichés')

    // Aucune correspondance → message vide.
    await page.fill('[data-testid="nav-search"]', 'zzzznope')
    await page.waitForSelector('[data-testid="nav-search-empty"]', { timeout: 5000 })

    await page.fill('[data-testid="nav-search"]', '')
  })

  test('décocher un groupe entier le retire de la sidebar', async () => {
    await page.goto(URL + '/settings', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="settings-section-menu"]', { timeout: 10000 })
    const groupBtn = page.locator('nav button:has-text("Inventaire")')
    assert.equal(await groupBtn.count(), 1, 'groupe Inventaire présent au départ')

    await page.click('[data-testid="nav-toggle-group:Inventaire"]')
    await page.waitForFunction(() => {
      return ![...document.querySelectorAll('nav button')].some(b => b.textContent.trim() === 'Inventaire')
    }, null, { timeout: 5000 })

    const prefs = await getPrefs()
    assert.ok(prefs.nav_hidden.includes('group:Inventaire'), 'nav_hidden contient group:Inventaire')

    // Restaure.
    await page.click('[data-testid="nav-toggle-group:Inventaire"]')
    await page.waitForSelector('nav button:has-text("Inventaire")', { timeout: 5000 })
  })
})
