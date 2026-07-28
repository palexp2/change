const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Sur /factures, l'icône de gestion des vues doit être un simple « + » qui
// ajoute une nouvelle vue (le verrouillage/renommage passe par le clic droit).
// L'ancien crayon « Gérer les vues » ne doit plus être présent sur cette page.
describe('Vues factures : bouton « + » (ajout), plus de crayon « Gérer les vues »', () => {
  let browser, ctx, page, token
  const createdIds = []

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
    // Nettoyage : supprimer toute vue jetable créée par le test.
    try {
      const data = await api('GET', '/views/factures')
      const before = new Set(createdIds)
      const leftovers = (data.pills || []).filter(p => before.has(p.id))
      for (const p of leftovers) {
        if (p.locked) await api('PATCH', `/views/factures/pills/${p.id}/locked`, { locked: false })
        await api('DELETE', `/views/factures/pills/${p.id}`)
      }
    } catch {}
    await browser?.close()
  })

  test('le crayon « Gérer les vues » a disparu sur /factures', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="view-add-btn"]', { timeout: 10000 })

    assert.equal(await page.locator('button[title="Gérer les vues"]').count(), 0,
      'le crayon « Gérer les vues » est encore présent sur /factures')
  })

  test('le bouton « + » est présent dans la barre des vues et ajoute une nouvelle vue', async () => {
    const addBtn = page.locator('[data-testid="view-add-btn"]')
    await addBtn.waitFor({ state: 'visible', timeout: 5000 })

    // Le « + » est bien dans la barre des vues (conteneur scrollable des onglets)
    const inViewsBar = await addBtn.evaluate(btn =>
      btn.parentElement.className.includes('overflow-x-auto'))
    assert.ok(inViewsBar, 'le « + » n\'est pas rendu dans la barre des vues')

    const before = await api('GET', '/views/factures')
    const beforeIds = new Set((before.pills || []).map(p => p.id))

    await addBtn.click()

    // Une nouvelle vue apparaît côté serveur
    await page.waitForTimeout(800)
    const afterData = await api('GET', '/views/factures')
    const fresh = (afterData.pills || []).filter(p => !beforeIds.has(p.id))
    assert.equal(fresh.length, 1, 'le « + » aurait dû créer exactement une nouvelle vue')
    createdIds.push(fresh[0].id)

    // Et un nouvel onglet correspondant est visible dans la barre
    const tab = page.locator(`button:has-text("${fresh[0].label}")`)
    await tab.waitFor({ state: 'visible', timeout: 5000 })
  })
})
