// Espace finance : entrée en tête du groupe Comptabilité, dont le sous-menu se
// déploie au survol et mène directement à chaque page, en pleine largeur (pas de
// page d'accueil intermédiaire).
//
// Test 100 % lecture : aucune donnée créée, modifiée ni supprimée — navigation
// et survols seulement. Le seul état écrit est la clé localStorage qui mémorise
// le dépliage du groupe de nav, dans le profil navigateur jetable du test.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const SECTIONS = [
  'Dashboard comptabilité',
  'Travaux',
  'Paiements émis',
  'Rapprochement bancaire',
  'Stripe Payouts',
  'Comptes prépayés',
  'Fournisseurs',
  'Dettes long terme',
  'Écritures de fin de mois',
]
const GROUPS = ['PILOTAGE', 'TRÉSORERIE', 'FOURNISSEURS & ENGAGEMENTS', 'ÉCRITURES']

describe('Espace finance — sous-menu au survol, en tête de Comptabilité', () => {
  let browser, ctx, page

  // Le groupe Comptabilité se replie par défaut : on le déplie pour atteindre
  // l'entrée, comme un utilisateur le ferait.
  async function openComptaGroup(path = '/dashboard') {
    await page.goto(URL + path, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('nav button:has-text("Comptabilité")', { timeout: 15000 })
    const trigger = page.locator('[data-testid="nav-flyout-trigger"]')
    if (await trigger.count() === 0) {
      await page.click('nav button:has-text("Comptabilité")')
    }
    await trigger.waitFor({ state: 'visible', timeout: 5000 })
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

  test('« Espace finance » est le premier item de la section Comptabilité', async () => {
    await openComptaGroup()
    const isFirst = await page.locator('[data-testid="nav-flyout-trigger"]')
      .evaluate(el => !el.previousElementSibling)
    assert.ok(isFirst, 'Espace finance n\'est pas en tête de la section')
    // Il vit bien dans la sidebar, imbriqué sous le groupe Comptabilité.
    const insideSidebar = await page.locator('[data-testid="nav-flyout-trigger"]')
      .evaluate(el => !!el.closest('[data-testid="app-sidebar"]'))
    assert.ok(insideSidebar, 'Espace finance n\'est pas dans la sidebar')
  })

  test('le survol ouvre le menu avec les 9 sections groupées', async () => {
    assert.equal(await page.locator('[data-testid="nav-flyout-panel"]').count(), 0, 'menu ouvert avant le survol')
    await page.hover('[data-testid="nav-flyout-trigger"]')
    const panel = page.locator('[data-testid="nav-flyout-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 5000 })

    for (const label of SECTIONS) {
      assert.equal(await panel.getByRole('link', { name: label, exact: true }).count(), 1, `section absente : ${label}`)
    }
    for (const group of GROUPS) {
      assert.ok(await panel.locator(`p:has-text("${group}")`).count() > 0, `groupe absent : ${group}`)
    }
    const box = await panel.boundingBox()
    assert.ok(box.y >= 0 && box.y + box.height <= 951, `panneau hors écran : ${JSON.stringify(box)}`)
  })

  // « État du close » a été retiré à la demande : ni entrée de menu, ni page.
  test('« État du close » ne figure plus dans le menu et /close ne mène nulle part', async () => {
    await page.hover('[data-testid="nav-flyout-trigger"]')
    const panel = page.locator('[data-testid="nav-flyout-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 5000 })
    assert.equal(await panel.getByRole('link', { name: 'État du close', exact: true }).count(), 0,
      'la section « État du close » est encore listée')
    assert.equal(await panel.locator('a[href="/erp/close"]').count(), 0, 'lien /close encore présent')

    await page.goto(URL + '/close', { waitUntil: 'domcontentloaded' })
    await page.waitForURL(u => !u.toString().includes('/close'), { timeout: 10000 })
    assert.equal(await page.locator('h1:has-text("État du close")').count(), 0, 'la page existe encore')
  })

  test('éloigner la souris referme le menu', async () => {
    await openComptaGroup()
    await page.hover('[data-testid="nav-flyout-trigger"]')
    await page.locator('[data-testid="nav-flyout-panel"]').waitFor({ state: 'visible', timeout: 5000 })
    await page.mouse.move(1200, 700)
    await page.mouse.move(1250, 720)
    await page.locator('[data-testid="nav-flyout-panel"]').waitFor({ state: 'detached', timeout: 5000 })
  })

  test('un clic sur une section ouvre la page en pleine largeur, sans rail', async () => {
    await openComptaGroup()
    await page.hover('[data-testid="nav-flyout-trigger"]')
    const panel = page.locator('[data-testid="nav-flyout-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 5000 })
    await panel.getByRole('link', { name: 'Rapprochement bancaire', exact: true }).click()

    await page.waitForURL(u => u.toString().endsWith('/erp/rapprochement'), { timeout: 10000 })
    await page.waitForSelector('h1:has-text("Rapprochement bancaire")', { timeout: 15000 })
    assert.equal(await panel.count(), 0, 'menu resté ouvert après navigation')
    // Pas de colonne de navigation interne : le contenu démarre juste à droite
    // de la sidebar (~224 px).
    const h1 = await page.locator('h1').first().boundingBox()
    assert.ok(h1.x < 300, `contenu décalé par un rail (x=${h1.x})`)
  })

  test('sur une section, le groupe Comptabilité se déplie et s\'allume tout seul', async () => {
    // Contexte neuf : aucun souvenir de dépliage, on arrive directement sur la
    // page d'une section.
    const fresh = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    const p2 = await fresh.newPage()
    await p2.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await p2.fill('input[type="email"]', EMAIL)
    await p2.fill('input[type="password"]', PASS)
    await p2.click('button:has-text("Se connecter")')
    await p2.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    await p2.goto(URL + '/dettes-lt', { waitUntil: 'domcontentloaded' })

    const trigger = p2.locator('[data-testid="nav-flyout-trigger"]')
    await trigger.waitFor({ state: 'visible', timeout: 15000 })
    assert.ok((await trigger.getAttribute('class')).includes('bg-brand-600'), 'ligne Espace finance éteinte')
    const groupBtn = p2.locator('nav button:has-text("Comptabilité")')
    assert.equal(await groupBtn.getAttribute('aria-expanded'), 'true', 'groupe Comptabilité replié')
    assert.ok((await groupBtn.getAttribute('class')).includes('bg-brand-600'), 'groupe Comptabilité éteint')
    await fresh.close()
  })

  test('la section courante est mise en évidence dans le menu', async () => {
    // On arrive de la navigation précédente sur /rapprochement : la colonne de
    // la section est déjà affichée (elle suit la route).
    await openComptaGroup('/rapprochement')
    await page.hover('[data-testid="nav-flyout-trigger"]')
    const panel = page.locator('[data-testid="nav-flyout-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 5000 })
    const activeClass = await panel.getByRole('link', { name: 'Rapprochement bancaire', exact: true }).getAttribute('class')
    assert.ok(activeClass.includes('bg-brand-600'), `section courante non mise en évidence : ${activeClass}`)
  })

  test('le menu s\'ouvre aussi au clic (tactile) et se ferme avec Échap', async () => {
    await openComptaGroup()
    await page.click('[data-testid="nav-flyout-trigger"]')
    const panel = page.locator('[data-testid="nav-flyout-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 5000 })
    // Épinglé : la souris qui s'éloigne ne le referme pas.
    await page.mouse.move(1200, 700)
    await page.mouse.move(1250, 720)
    await panel.waitFor({ state: 'visible', timeout: 2000 })
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'detached', timeout: 5000 })
  })

  test('la sidebar ne liste plus les sections dans Comptabilité', async () => {
    const sidebarNav = page.locator('nav').filter({ hasText: 'Comptabilité' }).first()
    for (const href of ['/erp/rapprochement', '/erp/comptes-prepayes', '/erp/dettes-lt', '/erp/travaux', '/erp/fin-de-mois']) {
      assert.equal(await sidebarNav.locator(`a[href="${href}"]`).count(), 0, `la sidebar liste encore ${href}`)
    }
  })

  test('sidebar repliée puis rouverte : les sections restent accessibles', async () => {
    await openComptaGroup()
    await page.click('[data-testid="sidebar-collapse-edge"]')
    await page.locator('[data-testid="nav-flyout-trigger"]').waitFor({ state: 'hidden', timeout: 5000 })
    await page.click('[data-testid="sidebar-reopen"]')
    await page.locator('[data-testid="nav-flyout-trigger"]').waitFor({ state: 'visible', timeout: 5000 })
    await page.hover('[data-testid="nav-flyout-trigger"]')
    const flyout = page.locator('[data-testid="nav-flyout-panel"]')
    await flyout.waitFor({ state: 'visible', timeout: 5000 })
    for (const label of SECTIONS) {
      assert.ok(await flyout.getByRole('link', { name: label, exact: true }).count() > 0, `section absente : ${label}`)
    }
    await page.keyboard.press('Escape')
    await flyout.waitFor({ state: 'detached', timeout: 5000 })
  })

  test('les anciennes URLs /finance/... redirigent vers la page', async () => {
    await page.goto(URL + '/finance/dettes-lt', { waitUntil: 'domcontentloaded' })
    await page.waitForURL(u => u.toString().endsWith('/erp/dettes-lt'), { timeout: 10000 })
    await page.goto(URL + '/finance', { waitUntil: 'domcontentloaded' })
    await page.waitForURL(u => u.toString().endsWith('/erp/comptabilite'), { timeout: 10000 })
  })

  // Le compte de douanes ASFC est un compte prépayé : son entrée vit sous
  // Trésorerie et mène à l'onglet de la page Comptes prépayés.
  test('« Douanes (ASFC) » est sous Trésorerie et ouvre l\'onglet des comptes prépayés', async () => {
    await openComptaGroup()
    await page.hover('[data-testid="nav-flyout-trigger"]')
    const panel = page.locator('[data-testid="nav-flyout-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 5000 })
    const douanes = panel.getByRole('link', { name: 'Douanes (ASFC)', exact: true })
    assert.equal(await douanes.count(), 1, 'entrée Douanes (ASFC) absente du menu')
    assert.ok((await douanes.getAttribute('href')).includes('comptes-prepayes?onglet=douanes'),
      'l\'entrée ne pointe pas vers l\'onglet des comptes prépayés')
    await douanes.click()
    await page.waitForURL(u => u.toString().includes('/comptes-prepayes?onglet=douanes'), { timeout: 10000 })
    await page.waitForSelector('[data-testid="douanes-table"]', { timeout: 15000 })

    // Une seule entrée allumée : « Comptes prépayés » ne revendique pas l'onglet douanes.
    await page.hover('[data-testid="nav-flyout-trigger"]')
    await panel.waitFor({ state: 'visible', timeout: 5000 })
    const douanesCls = await panel.getByRole('link', { name: 'Douanes (ASFC)', exact: true }).getAttribute('class')
    const prepaidCls = await panel.getByRole('link', { name: 'Comptes prépayés', exact: true }).getAttribute('class')
    assert.ok(douanesCls.includes('bg-brand-600'), 'entrée Douanes non mise en évidence')
    assert.ok(!prepaidCls.includes('bg-brand-600'), 'entrée Comptes prépayés allumée en même temps')
    await page.keyboard.press('Escape')
  })

  test('les sections restent trouvables dans la palette (⌘K)', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('nav button:has-text("Comptabilité")', { timeout: 15000 })
    // Le raccourci est ignoré si le focus est dans un champ (garde-fou du
    // Layout) : on neutralise le focus, et on retente une fois — la frappe peut
    // tomber pendant que la page finit de s'hydrater.
    const paletteInput = page.locator('input[placeholder*="Recherche"]')
    for (let i = 0; i < 3 && await paletteInput.count() === 0; i++) {
      await page.locator('h1').first().click({ force: true })
      await page.keyboard.press('Control+k')
      await paletteInput.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
    }
    await paletteInput.first().waitFor({ state: 'visible', timeout: 5000 })
    await page.keyboard.type('rapprochement')
    await page.waitForSelector('text=Rapprochement bancaire', { timeout: 5000 })
    await page.keyboard.press('Escape')
  })
})
