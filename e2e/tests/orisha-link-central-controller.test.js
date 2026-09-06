const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Test data (confirmed in DB): Ferme entre ciel et terre has operational CC address 225
const COMPANY_ID = '30d496b2-6cc5-4c6d-bcef-32f4ecff8095'
const COMPANY_ID_2 = 'e36d1fd1-a2ef-41c7-87c6-34bf70e34c82' // other company w/ many serials
const TICKET_ID = 'a9ae912b-74b7-496f-8099-af1fe35009ba'
const EXPECTED_ADDRESS = '225'
const EXPECTED_URL = `https://app.orisha.io/#admin/${EXPECTED_ADDRESS}`

describe('Lien externe Orisha — fiche entreprise et billet', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => {
    await browser?.close()
  })

  test('API companies/:id retourne central_controllers', async () => {
    const res = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/companies/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      return r.json()
    }, { id: COMPANY_ID })
    assert.ok(Array.isArray(res.central_controllers), 'central_controllers doit être un tableau')
    assert.ok(res.central_controllers.length >= 1, 'au moins un CC opérationnel')
    const cc = res.central_controllers.find(c => c.address === EXPECTED_ADDRESS)
    assert.ok(cc, `CC avec address ${EXPECTED_ADDRESS} doit être présent`)
    assert.ok(cc.product_name && cc.product_name.toLowerCase().startsWith('contrôleur central'), 'product_name doit être un contrôleur central')
  })

  test('API tickets/:id retourne central_controllers', async () => {
    const res = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/tickets/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      return r.json()
    }, { id: TICKET_ID })
    assert.ok(Array.isArray(res.central_controllers), 'central_controllers doit être un tableau sur le billet')
    const cc = res.central_controllers.find(c => c.address === EXPECTED_ADDRESS)
    assert.ok(cc, `CC avec address ${EXPECTED_ADDRESS} doit être présent sur le billet`)
  })

  test('UI — fiche entreprise affiche le lien Orisha vers l\'adresse du CC', async () => {
    await page.goto(`${URL}/companies/${COMPANY_ID}`, { waitUntil: 'networkidle' })
    const link = page.locator(`a[href="${EXPECTED_URL}"]`).first()
    await link.waitFor({ timeout: 10000 })
    const target = await link.getAttribute('target')
    assert.strictEqual(target, '_blank', 'le lien doit ouvrir un nouvel onglet')
    const rel = await link.getAttribute('rel')
    assert.ok(rel && rel.includes('noopener'), 'le lien doit avoir rel=noopener')
    const text = (await link.innerText()).trim()
    assert.ok(text.toLowerCase().includes('orisha'), `texte visible doit mentionner Orisha, reçu: "${text}"`)
  })

  test('UI — onglet "N° de série" de la fiche entreprise utilise DataTable et affiche le serial', async () => {
    await page.goto(`${URL}/companies/${COMPANY_ID}`, { waitUntil: 'networkidle' })
    // Open the "Numéros de série" tab
    await page.getByRole('button', { name: /N° de série/ }).first().click()
    // DataTable signal: the shared search input from ViewToolbar
    await page.locator('input[placeholder="Rechercher..."]').first().waitFor({ timeout: 10000 })
    // The known CC serial should be visible in the rendered rows
    await page.getByText('CC225', { exact: true }).first().waitFor({ timeout: 10000 })
  })

  test('Les paramètres company_serials sont partagés et persistants entre fiches', async () => {
    // Save a distinctive column width on company_serials key via the API
    const stamp = Math.floor(Math.random() * 999) + 111 // 111-1109
    const saved = await page.evaluate(async (w) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/views/company_serials/column-widths', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ column_widths: { serial: w } }),
      })
      return { status: r.status, body: await r.json() }
    }, stamp)
    assert.strictEqual(saved.status, 200, 'PATCH column-widths doit réussir')

    // Fetch config from a fresh GET — must see the same width back
    const cfg = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      return fetch('/erp/api/views/company_serials', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
    })
    assert.strictEqual(cfg.config.column_widths.serial, stamp, 'la largeur doit être persistée côté serveur')

    // Ouvrir fiche A et vérifier la largeur appliquée au header de colonne "serial"
    await page.goto(`${URL}/companies/${COMPANY_ID}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /N° de série/ }).first().click()
    await page.locator('input[placeholder="Rechercher..."]').first().waitFor({ timeout: 10000 })
    // grid-template-columns est calculé à partir des colWidths — on lit le style effectif
    const widthsA = await page.evaluate(() => {
      const el = document.querySelector('[style*="grid-template-columns"]')
      return el ? getComputedStyle(el).gridTemplateColumns : null
    })
    assert.ok(widthsA && widthsA.length > 0, `grid-template-columns doit être appliqué (fiche A), reçu: ${widthsA}`)

    // Ouvrir fiche B et vérifier exactement la même largeur
    await page.goto(`${URL}/companies/${COMPANY_ID_2}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /N° de série/ }).first().click()
    await page.locator('input[placeholder="Rechercher..."]').first().waitFor({ timeout: 10000 })
    const widthsB = await page.evaluate(() => {
      const el = document.querySelector('[style*="grid-template-columns"]')
      return el ? getComputedStyle(el).gridTemplateColumns : null
    })
    assert.strictEqual(widthsB, widthsA, `les largeurs doivent être identiques d'une fiche à l'autre`)
  })

  test('UI — fiche billet affiche le lien Orisha vers l\'adresse du CC', async () => {
    await page.goto(`${URL}/tickets/${TICKET_ID}`, { waitUntil: 'networkidle' })
    const link = page.locator(`a[href="${EXPECTED_URL}"]`).first()
    await link.waitFor({ timeout: 10000 })
    const target = await link.getAttribute('target')
    assert.strictEqual(target, '_blank', 'le lien doit ouvrir un nouvel onglet')
    const text = (await link.innerText()).trim()
    assert.ok(text.toLowerCase().includes('orisha'), `texte visible doit mentionner Orisha, reçu: "${text}"`)
  })
})
