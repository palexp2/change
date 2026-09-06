// Sous-menus de second niveau : survoler une section (dans le menu Espace
// finance ou dans le groupe Comptabilité) déplie SES propres sections — onglets
// de la page, vues d'un tableau, comptes du rapprochement — et un clic ouvre
// directement la bonne section.
//
// Aucun record créé ni supprimé. Deux effets de bord possibles, tous deux
// restaurés en fin de test :
//   - sélectionner une vue déclenche l'auto-save de ses filtres (comportement
//     normal de l'app) → filtres capturés avant, restaurés après ;
//   - la vue mémorisée par table vit dans le localStorage du profil jetable.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Menu de gauche — sous-menu des sections d\'une page', () => {
  let browser, ctx, page
  let facturesPills = []      // état d'origine des vues de la table factures

  const api = (path, opts) => page.evaluate(async ({ path, opts, base }) => {
    const t = localStorage.getItem('erp_token')
    const r = await fetch(base + '/api' + path, {
      ...opts,
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts, base: URL })

  // Le groupe Comptabilité est replié par défaut : on le déplie comme le ferait
  // l'utilisateur, puis on renvoie le déclencheur « Espace finance ».
  async function openComptaGroup(path = '/dashboard') {
    await page.goto(URL + path, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('nav button:has-text("Comptabilité")', { timeout: 15000 })
    if (await page.locator('[data-testid="nav-flyout-trigger"]').count() === 0) {
      await page.click('nav button:has-text("Comptabilité")')
    }
    await page.locator('[data-testid="nav-flyout-trigger"]').waitFor({ state: 'visible', timeout: 5000 })
  }

  // Ouvre le menu Espace finance et renvoie le sous-menu d'une de ses sections.
  async function openSectionSubmenu(route) {
    await page.hover('[data-testid="nav-flyout-trigger"]')
    const parent = page.locator('[data-testid="nav-flyout-panel"]')
    await parent.waitFor({ state: 'visible', timeout: 5000 })
    await parent.locator(`a[href$="/erp${route}"]`).hover()
    const sub = page.locator(`[data-testid="nav-subsection-panel"][data-route="${route}"]`)
    // Certains sous-menus (comptes du rapprochement) sont résolus par un appel
    // réseau qui peut faire la queue derrière les requêtes de la page en cours
    // (limite de connexions du navigateur) : marge généreuse.
    await sub.waitFor({ state: 'visible', timeout: 20000 })
    return { parent, sub }
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
    const { body } = await api('/views/factures')
    facturesPills = (body?.pills || []).map(p => ({ id: p.id, filters: p.filters, locked: p.locked }))
  })

  after(async () => {
    // Restaure les filtres de toute vue dont l'auto-save aurait changé le contenu.
    try {
      const { body } = await api('/views/factures')
      for (const before of facturesPills) {
        if (before.locked === 1) continue
        const now = (body?.pills || []).find(p => p.id === before.id)
        if (!now) continue
        if (JSON.stringify(now.filters) !== JSON.stringify(before.filters)) {
          await api(`/views/factures/pills/${before.id}`, {
            method: 'PUT', body: JSON.stringify({ filters: before.filters }),
          })
        }
      }
    } catch {}
    await browser?.close()
  })

  test('survoler « Travaux » déplie ses onglets, sans fermer le menu parent', async () => {
    await openComptaGroup()
    const { parent, sub } = await openSectionSubmenu('/travaux')
    for (const label of ['Ma file de prompts', 'Suggestions de Claude', 'Idées', 'Travaux récurrents']) {
      assert.equal(await sub.getByRole('link', { name: label, exact: true }).count(), 1, `onglet absent : ${label}`)
    }
    // Chaîne de survol : entrer dans l'enfant ne doit pas fermer le parent.
    assert.ok(await parent.isVisible(), 'le menu Espace finance s\'est fermé')
    // Le sous-menu s'ouvre à droite du parent.
    const pBox = await parent.boundingBox(), sBox = await sub.boundingBox()
    assert.ok(sBox.x >= pBox.x + pBox.width - 8, `sous-menu mal placé (${sBox.x} vs ${pBox.x + pBox.width})`)
  })

  test('cliquer un onglet du sous-menu ouvre la page sur cet onglet', async () => {
    await openComptaGroup()
    const { sub } = await openSectionSubmenu('/travaux')
    await sub.getByRole('link', { name: 'Suggestions de Claude', exact: true }).click()
    await page.waitForURL(u => u.toString().includes('/travaux?onglet=suggestions'), { timeout: 10000 })
    const tabBtn = page.locator('button:has-text("Suggestions de Claude")').first()
    await tabBtn.waitFor({ state: 'visible', timeout: 15000 })
    assert.ok((await tabBtn.getAttribute('class')).includes('border-brand-600'), 'onglet Suggestions pas actif')
  })

  test('depuis la page déjà ouverte, le sous-menu change d\'onglet', async () => {
    // On est déjà sur /travaux?onglet=suggestions : pas de démontage de la page.
    await page.waitForSelector('nav button:has-text("Comptabilité")', { timeout: 15000 })
    if (await page.locator('[data-testid="nav-flyout-trigger"]').count() === 0) {
      await page.click('nav button:has-text("Comptabilité")')
    }
    const { sub } = await openSectionSubmenu('/travaux')
    await sub.getByRole('link', { name: 'Travaux récurrents', exact: true }).click()
    await page.waitForURL(u => u.toString().includes('/travaux?onglet=recurrents'), { timeout: 10000 })
    const tabBtn = page.locator('button:has-text("Travaux récurrents")').first()
    assert.ok((await tabBtn.getAttribute('class')).includes('border-brand-600'), 'onglet Récurrents pas actif')
  })

  test('les sous-pages Fournisseurs sont offertes au survol', async () => {
    await openComptaGroup()
    const { sub } = await openSectionSubmenu('/fournisseurs')
    for (const label of ['Profils', 'Achats', 'Abonnements']) {
      assert.equal(await sub.getByRole('link', { name: label, exact: true }).count(), 1, `sous-page absente : ${label}`)
    }
    await sub.getByRole('link', { name: 'Achats', exact: true }).click()
    await page.waitForURL(u => u.toString().endsWith('/erp/fournisseurs/achats'), { timeout: 10000 })
  })

  test('les comptes du rapprochement bancaire sont offerts au survol', async () => {
    await openComptaGroup()
    const { sub } = await openSectionSubmenu('/rapprochement')
    const links = sub.locator('a')
    const count = await links.count()
    assert.ok(count >= 2, `au moins 2 comptes attendus, reçu ${count}`)
    const label = (await links.nth(1).innerText()).trim()
    const href = await links.nth(1).getAttribute('href')
    assert.ok(href.includes('?compte='), `lien sans paramètre de compte : ${href}`)
    await links.nth(1).click()
    await page.waitForURL(u => u.toString().includes('/rapprochement?compte='), { timeout: 10000 })
    const accountBtn = page.locator(`main button:has-text("${label}")`).first()
    await accountBtn.waitFor({ state: 'visible', timeout: 15000 })
    assert.ok((await accountBtn.getAttribute('class')).includes('bg-brand-600'), `compte ${label} pas sélectionné`)
  })

  test('les vues d\'un tableau sont offertes au survol de son entrée', async () => {
    await openComptaGroup()
    // « Factures clients » est un item ordinaire du groupe Comptabilité.
    await page.hover('nav a[href$="/erp/factures"]')
    const sub = page.locator('[data-testid="nav-subsection-panel"][data-route="/factures"]')
    await sub.waitFor({ state: 'visible', timeout: 10000 })
    const links = sub.locator('a')
    assert.ok(await links.count() >= 2, 'moins de 2 vues proposées')
    const label = (await links.first().innerText()).trim()
    const href = await links.first().getAttribute('href')
    assert.ok(href.includes('?vue='), `lien sans paramètre de vue : ${href}`)

    await links.first().click()
    await page.waitForURL(u => u.toString().includes('/factures?vue='), { timeout: 10000 })
    const pill = page.locator(`main button:has-text("${label}")`).first()
    await pill.waitFor({ state: 'visible', timeout: 20000 })
    assert.ok((await pill.getAttribute('class')).includes('border-brand-600'), `vue ${label} pas active`)
  })

  test('une page sans onglet ne propose aucun sous-menu', async () => {
    await openComptaGroup()
    await page.hover('[data-testid="nav-flyout-trigger"]')
    const parent = page.locator('[data-testid="nav-flyout-panel"]')
    await parent.waitFor({ state: 'visible', timeout: 5000 })
    for (const route of ['/stripe-payouts', '/dettes-lt', '/fin-de-mois']) {
      await parent.locator(`a[href$="/erp${route}"]`).hover()
      await page.waitForTimeout(600)
      assert.equal(
        await page.locator(`[data-testid="nav-subsection-panel"][data-route="${route}"]`).count(), 0,
        `sous-menu inattendu pour ${route}`,
      )
    }
  })
})
