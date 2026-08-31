// Sidebar — coup d'œil au survol du rail replié + réordonnancement des
// sections/sous-sections au glisser-déposer depuis la poignée.
//
// IMPORTANT : nav_order est une CONFIG utilisateur (pas un record créé par le
// test) → on lit la valeur d'origine avant et on la restaure dans after(),
// même en cas d'échec (cf. CLAUDE.md).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Sidebar — coup d\'œil au survol et réordonnancement', () => {
  let browser, ctx, page, originalOrder

  async function getPrefs() {
    return page.evaluate(async (base) => {
      const t = localStorage.getItem('erp_token')
      const r = await fetch(base + '/api/auth/preferences', { headers: { Authorization: 'Bearer ' + t } })
      return r.json()
    }, URL)
  }

  async function setOrder(obj) {
    return page.evaluate(async ({ base, obj }) => {
      const t = localStorage.getItem('erp_token')
      const r = await fetch(base + '/api/auth/preferences', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: JSON.stringify({ nav_order: obj }),
      })
      return r.json()
    }, { base: URL, obj })
  }

  // Ordre courant des clés d'un conteneur, tel que rendu dans la sidebar.
  async function domOrder(container) {
    return page.$$eval(`[data-nav-container="${container}"]`, els => els.map(e => e.dataset.navSortable))
  }

  // Glisse la poignée de `key` sur le haut de la ligne `targetKey` (→ insertion
  // avant). Souris bas niveau : le glisser n'est armé que depuis la poignée.
  async function dragBefore(key, targetKey) {
    const handle = page.locator(`[data-testid="nav-drag-${key}"]`)
    await handle.scrollIntoViewIfNeeded()
    const from = await handle.boundingBox()
    const to = await page.locator(`[data-nav-sortable="${targetKey}"]`).boundingBox()
    // Quart supérieur de la ligne cible → insertion avant.
    const y = to.y + Math.max(3, Math.min(to.height / 4, 10))
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + 40, y, { steps: 12 })
    await page.mouse.move(to.x + 41, y, { steps: 2 })
    await page.waitForSelector('[data-testid="nav-drop-indicator"]', { timeout: 3000 })
    await page.mouse.up()
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    originalOrder = (await getPrefs()).nav_order || {}
    // État déterministe : ordre par défaut du code.
    await setOrder({})
  })

  after(async () => {
    try { if (page && originalOrder !== undefined) await setOrder(originalOrder) } catch {}
    await browser?.close()
  })

  test('rail replié : le survol ouvre le menu, le quitter le referme', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="sidebar-collapse"]', { timeout: 15000 })
    await page.click('[data-testid="sidebar-collapse"]')
    await page.waitForSelector('[data-testid="sidebar-rail"]', { timeout: 5000 })
    assert.equal(await page.locator('[data-testid="sidebar-peek"]').count(), 0,
      'pas de panneau tant que la souris n\'est pas sur le rail')

    // Survol du rail → le menu complet apparaît en surimpression.
    const rail = await page.locator('[data-testid="sidebar-rail"]').boundingBox()
    await page.mouse.move(rail.x + rail.width / 2, rail.y + 300)
    await page.mouse.move(rail.x + rail.width / 2, rail.y + 305)
    await page.waitForSelector('[data-testid="sidebar-peek"]', { timeout: 5000 })
    const links = await page.locator('[data-testid="sidebar-peek"] nav a, [data-testid="sidebar-peek"] nav button').count()
    assert.ok(links > 3, `le panneau contient la navigation (${links} entrées)`)

    // Sortir du panneau → il se referme tout seul.
    await page.mouse.move(900, 500)
    await page.mouse.move(905, 505)
    await page.waitForSelector('[data-testid="sidebar-peek"]', { state: 'detached', timeout: 5000 })

    // Le rail reste cliquable : son bouton rouvre le menu pour de bon.
    await page.click('[data-testid="sidebar-reopen"]')
    await page.waitForSelector('[data-testid="sidebar-collapse"]', { timeout: 5000 })
    assert.equal(await page.locator('[data-testid="sidebar-rail"]').count(), 0, 'menu rouvert (plus de rail)')
  })

  test('glisser une section la déplace et l\'ordre est sauvegardé', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-nav-sortable="group:Transport"]', { timeout: 15000 })

    const before = await domOrder('root')
    const iClients = before.indexOf('group:Clients')
    const iTransport = before.indexOf('group:Transport')
    assert.ok(iClients >= 0 && iTransport > iClients, `Transport après Clients au départ (${before.join(', ')})`)

    await dragBefore('group:Transport', 'group:Clients')

    await page.waitForFunction(() => {
      const keys = [...document.querySelectorAll('[data-nav-container="root"]')].map(e => e.dataset.navSortable)
      return keys.indexOf('group:Transport') < keys.indexOf('group:Clients')
    }, null, { timeout: 5000 })

    // Persistance côté serveur.
    const prefs = await getPrefs()
    const root = prefs.nav_order?.root || []
    assert.ok(root.indexOf('group:Transport') >= 0 && root.indexOf('group:Transport') < root.indexOf('group:Clients'),
      `nav_order.root place Transport avant Clients (${root.join(', ')})`)

    // Et l'ordre survit à un rechargement (les préférences arrivent en async).
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-nav-sortable="group:Transport"]', { timeout: 15000 })
    await page.waitForFunction(() => {
      const keys = [...document.querySelectorAll('[data-nav-container="root"]')].map(e => e.dataset.navSortable)
      return keys.indexOf('group:Transport') < keys.indexOf('group:Clients')
    }, null, { timeout: 10000 })
  })

  test('glisser un sous-item le déplace dans sa section', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-nav-sortable="group:Clients"]', { timeout: 15000 })
    // Les préférences arrivent en async : le menu rend d'abord l'ordre par
    // défaut. On attend que l'ordre du test précédent soit appliqué, sinon les
    // lignes se décalent entre la mesure et le glissé.
    await page.waitForFunction(() => {
      const keys = [...document.querySelectorAll('[data-nav-container="root"]')].map(e => e.dataset.navSortable)
      return keys.indexOf('group:Transport') < keys.indexOf('group:Clients')
    }, null, { timeout: 10000 })

    // La section doit être dépliée pour voir ses sous-items.
    if (await page.locator('[data-nav-sortable="/companies"]').count() === 0) {
      await page.click('nav button:has-text("Clients")')
      await page.waitForSelector('[data-nav-sortable="/companies"]', { timeout: 5000 })
    }

    const before = await domOrder('group:Clients')
    assert.ok(before.indexOf('/companies') > before.indexOf('/contacts'),
      `Entreprises après Contacts au départ (${before.join(', ')})`)

    await dragBefore('/companies', '/contacts')

    await page.waitForFunction(() => {
      const keys = [...document.querySelectorAll('[data-nav-container="group:Clients"]')].map(e => e.dataset.navSortable)
      return keys.indexOf('/companies') < keys.indexOf('/contacts')
    }, null, { timeout: 5000 })

    const prefs = await getPrefs()
    const grp = prefs.nav_order?.['group:Clients'] || []
    assert.ok(grp.indexOf('/companies') >= 0 && grp.indexOf('/companies') < grp.indexOf('/contacts'),
      `nav_order['group:Clients'] place Entreprises avant Contacts (${grp.join(', ')})`)
  })

  test('cliquer un lien du menu ne le réordonne pas', async () => {
    await setOrder({})
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-nav-sortable="group:Clients"]', { timeout: 15000 })
    if (await page.locator('[data-nav-sortable="/companies"]').count() === 0) {
      await page.click('nav button:has-text("Clients")')
      await page.waitForSelector('[data-nav-sortable="/companies"]', { timeout: 5000 })
    }
    const before = await domOrder('group:Clients')

    // Navigation normale : clic + petit glissement de souris sur le lien.
    const link = page.locator('[data-nav-sortable="/companies"] a').first()
    const box = await link.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y - 30, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(600)

    const after = await domOrder('group:Clients')
    assert.deepEqual(after, before, 'aucun réordonnancement accidentel')
    const prefs = await getPrefs()
    assert.deepEqual(prefs.nav_order || {}, {}, 'nav_order inchangé')
  })
})
