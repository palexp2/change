// Vérifie que les pages qui utilisaient encore alert() natif (Dashboard,
// PrioriteAssemblage) affichent désormais le Toast centralisé
// (.fixed.bottom-4.left-4 > .bg-red-600) sur erreur, et PLUS aucune boîte de
// dialogue native bloquante.
//
// Méthode : on intercepte l'appel API muté (PUT /dashboard/goal,
// POST /purchases) et on le force en 500.
// Comme la requête est interceptée AVANT d'atteindre le serveur, RIEN n'est
// créé ni modifié en DB → aucun cleanup nécessaire (cf. CLAUDE.md).
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

// Renvoie un 500 JSON applicatif → api.js en fait `new Error(data.error)`.
async function fail500(route) {
  await route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'E2E forced error' }),
  })
}

// Locator du toast d'erreur centralisé.
function errorToast(page) {
  return page.locator('.fixed.bottom-4.left-4 .bg-red-600')
}

describe('alert() → Toast centralisé', () => {
  let browser, ctx, page
  let nativeDialogs

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    // Toute boîte de dialogue native (alert/confirm) est enregistrée puis
    // fermée pour ne pas bloquer — on assertera ensuite qu'aucune n'a surgi.
    nativeDialogs = []
    page.on('dialog', async (d) => {
      nativeDialogs.push(d.message())
      await d.dismiss().catch(() => {})
    })
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('PrioriteAssemblage — échec de création d\'achat → toast', async () => {
    nativeDialogs.length = 0
    await page.goto(URL + '/priorite-assemblage', { waitUntil: 'networkidle' })

    const commander = page.locator('[data-testid="achat-commander"]').first()
    await commander.waitFor({ state: 'visible', timeout: 10000 })
    await commander.click()

    const submit = page.locator('[data-testid="commander-submit"]')
    await submit.waitFor({ state: 'visible', timeout: 5000 })

    // Assure une quantité valide (le bouton est désactivé sinon).
    const qtyInput = page.locator('.fixed.inset-0 input[type="number"]').first()
    await qtyInput.fill('1')

    // Force l'échec du POST (n'atteint jamais le serveur → aucun achat créé).
    await page.route('**/erp/api/purchases', (route) =>
      route.request().method() === 'POST' ? fail500(route) : route.continue())

    await submit.click()

    const toast = errorToast(page).filter({ hasText: "Erreur lors de la création de l'achat" })
    await toast.waitFor({ state: 'visible', timeout: 5000 })
    assert.deepEqual(nativeDialogs, [], `aucune alert() native attendue, reçu: ${JSON.stringify(nativeDialogs)}`)

    await page.unroute('**/erp/api/purchases')
  })
})
