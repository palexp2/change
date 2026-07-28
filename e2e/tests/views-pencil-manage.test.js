const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Nom unique pour la vue jetable créée par le test (nettoyée en after()).
const TEST_VIEW = `Vue Test E2E ${Date.now()}`

describe('Gestion des vues : crayon sur la barre des vues (remplace la roue dentelée)', () => {
  let browser, ctx, page, token

  async function api(method, path, body) {
    const r = await fetch(`${URL}/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status}`)
    return r.json()
  }

  before(async () => {
    const auth = await fetch(`${URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    }).then(r => r.json())
    token = auth.token
    assert.ok(token, 'login API échoué')

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => {
    // Nettoyage : supprimer la vue jetable si le test a échoué avant sa suppression UI.
    try {
      const data = await api('GET', '/views/companies')
      const leftover = (data.pills || []).filter(p => p.label === TEST_VIEW)
      for (const p of leftover) await api('DELETE', `/views/companies/pills/${p.id}`)
    } catch {}
    await browser?.close()
  })

  test('la roue dentelée du header a disparu, le crayon est sur la barre des vues', async () => {
    await page.goto(URL + '/companies', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Entreprises")', { timeout: 10000 })

    // Ancienne roue dentelée en haut à droite : plus présente
    assert.equal(await page.locator('button[title="Gérer les vues de la table"]').count(), 0,
      "l'ancienne roue dentelée du header est encore présente")

    // Crayon présent, et bien DANS la barre des vues (même conteneur que les onglets)
    const pencil = page.locator('button[title="Gérer les vues"]')
    await pencil.waitFor({ state: 'visible', timeout: 5000 })
    const inViewsBar = await pencil.evaluate(btn => {
      const bar = btn.parentElement
      // la barre des vues contient les onglets (boutons) et est scrollable horizontalement
      return bar.className.includes('overflow-x-auto') && bar.querySelectorAll('button').length >= 1
    })
    assert.ok(inViewsBar, "le crayon n'est pas rendu dans la barre des vues")
  })

  test('le crayon ouvre la modale de gestion et permet créer + supprimer une vue', async () => {
    await page.click('button[title="Gérer les vues"]')
    await page.waitForSelector('text=Vues — Entreprises', { timeout: 5000 })

    // Créer une vue jetable
    await page.click('button:has-text("Nouvelle vue")')
    await page.fill('input[placeholder="Nom de la vue..."]', TEST_VIEW)
    await page.click('button:has-text("Créer")')

    // La modale se ferme et le nouvel onglet apparaît dans la barre des vues
    const tab = page.locator(`button:has-text("${TEST_VIEW}")`)
    await tab.waitFor({ state: 'visible', timeout: 5000 })

    // Rouvrir la modale et supprimer la vue jetable (X au survol + confirmation)
    await page.click('button[title="Gérer les vues"]')
    await page.waitForSelector('text=Vues — Entreprises', { timeout: 5000 })
    const row = page.locator('.group', { hasText: TEST_VIEW }).first()
    await row.hover()
    await row.locator('button[title="Supprimer"]').click()
    await page.click('button:has-text("Confirmer")') // modale de confirmation (ConfirmModal)
    await page.waitForSelector(`.group:has-text("${TEST_VIEW}")`, { state: 'detached', timeout: 5000 })

    // Fermer la modale et vérifier que l'onglet a disparu
    await page.keyboard.press('Escape')
    await tab.waitFor({ state: 'detached', timeout: 5000 })
  })
})
