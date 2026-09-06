// Vérifie que les 3 pages qui utilisaient encore alert() natif (Dashboard,
// ItemsVendus, PrioriteAssemblage) affichent désormais le Toast centralisé
// (.fixed.bottom-4.left-4 > .bg-red-600) sur erreur, et PLUS aucune boîte de
// dialogue native bloquante.
//
// Méthode : on intercepte l'appel API muté (PUT /dashboard/goal,
// PATCH /stripe-invoice-items/:id, POST /purchases) et on le force en 500.
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

  test('Dashboard — échec de sauvegarde de l\'objectif → toast', async () => {
    nativeDialogs.length = 0
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    // Déplie la section « Objectif de projets » si elle est repliée.
    const toggle = page.locator('[data-testid="section-toggle-section_project_goal"]')
    await toggle.waitFor({ state: 'visible', timeout: 10000 })
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()

    // La carte ne contient que 2 boutons : le toggle + le bouton d'édition de
    // l'objectif (« Configurer un objectif » ou l'icône SlidersHorizontal selon
    // qu'un objectif existe déjà) → le dernier est toujours l'édition.
    const card = page.locator('[data-section-id="section_project_goal"]')
    await card.locator('button').last().click()

    const modal = page.locator('[role="dialog"]').filter({ hasText: "Configurer l'objectif de projets" })
    await modal.waitFor({ state: 'visible', timeout: 5000 })

    await modal.locator('input[type="number"]').fill('42')
    await modal.locator('input[type="date"]').first().fill('2026-01-01')
    await modal.locator('input[type="date"]').last().fill('2026-12-31')

    // Force l'échec du PUT (n'atteint jamais le serveur).
    await page.route('**/erp/api/dashboard/goal', (route) =>
      route.request().method() === 'PUT' ? fail500(route) : route.continue())

    await modal.locator('button:has-text("Enregistrer")').click()

    const toast = errorToast(page).filter({ hasText: 'E2E forced error' })
    await toast.waitFor({ state: 'visible', timeout: 5000 })
    assert.deepEqual(nativeDialogs, [], `aucune alert() native attendue, reçu: ${JSON.stringify(nativeDialogs)}`)

    await page.unroute('**/erp/api/dashboard/goal')
  })

  test('ItemsVendus — échec de liaison produit → toast', async () => {
    nativeDialogs.length = 0
    await page.goto(URL + '/items-vendus', { waitUntil: 'networkidle' })

    const field = page.locator('[data-testid^="linked-record-field-product-"]').first()
    await field.waitFor({ state: 'visible', timeout: 10000 })

    // Force l'échec du PATCH (n'atteint jamais le serveur).
    await page.route('**/erp/api/stripe-invoice-items/*', (route) =>
      route.request().method() === 'PATCH' ? fail500(route) : route.continue())

    const state = await field.getAttribute('data-state')
    if (state === 'selected') {
      // Délier → onChange(null) → update()
      await field.locator('[data-testid="linked-record-clear"]').click()
    } else {
      // Lier un produit → ouvrir le picker et choisir la 1re option → update()
      await field.locator('[data-testid="linked-record-add"]').click()
      const opt = page.locator('#linked-record-portal button').first()
      await opt.waitFor({ state: 'visible', timeout: 5000 })
      await opt.click()
    }

    const toast = errorToast(page).filter({ hasText: 'Échec de la mise à jour' })
    await toast.waitFor({ state: 'visible', timeout: 5000 })
    assert.deepEqual(nativeDialogs, [], `aucune alert() native attendue, reçu: ${JSON.stringify(nativeDialogs)}`)

    await page.unroute('**/erp/api/stripe-invoice-items/*')
  })

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
