const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Indicateur de ré-import sur /factures : pills « Ré-import Stripe en cours… »
// et « Resync Airtable en cours… » tant que le batch Stripe ou la resync
// Airtable tourne, puis disparition + toast à la fin. Les endpoints de statut
// sont mockés via page.route — aucun vrai ré-import n'est déclenché, aucune
// donnée n'est créée ni modifiée.
describe('Factures — indicateur de ré-import Stripe / Airtable', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('pills visibles pendant un ré-import (statuts mockés), avec progression Stripe', async () => {
    // Mock : batch Stripe en cours (42/100) + resync Airtable factures en cours
    await page.route('**/api/stripe-queue/batch-enrich/status*', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ running: true, total: 100, processed: 42, updated: 40, created: 2, skipped: 0, errors: [] }),
    }))
    await page.route('**/api/connectors/sync/status*', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ factures: { running: true, startedAt: '2026-01-01T00:00:00.000Z', endedAt: null, error: null } }),
    }))

    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })

    const indicator = page.locator('[data-testid="factures-reimport-indicator"]')
    await indicator.waitFor({ state: 'visible', timeout: 10000 })

    const stripePill = page.locator('[data-testid="factures-reimport-stripe"]')
    await stripePill.waitFor({ state: 'visible', timeout: 5000 })
    const stripeText = await stripePill.innerText()
    assert.match(stripeText, /Ré-import Stripe en cours/, 'pill Stripe présente')
    assert.match(stripeText, /42\/100/, 'progression processed/total affichée')

    const airtablePill = page.locator('[data-testid="factures-reimport-airtable"]')
    await airtablePill.waitFor({ state: 'visible', timeout: 5000 })
    assert.match(await airtablePill.innerText(), /Resync Airtable en cours/, 'pill Airtable présente')
  })

  test('l’indicateur disparaît quand les imports se terminent, avec toast de fin', async () => {
    // Retire les mocks → les vrais endpoints répondent running:false (aucun
    // ré-import réel en cours) ; le prochain poll (≤ 4 s) doit faire
    // disparaître les pills et déclencher le toast de fin.
    await page.unroute('**/api/stripe-queue/batch-enrich/status*')
    await page.unroute('**/api/connectors/sync/status*')

    const indicator = page.locator('[data-testid="factures-reimport-indicator"]')
    await indicator.waitFor({ state: 'detached', timeout: 15000 })

    // Transition en cours → terminé : toast de confirmation
    const toast = page.locator('text=Ré-import des factures terminé')
    await toast.waitFor({ state: 'visible', timeout: 5000 })
  })

  test('aucun indicateur affiché quand rien ne tourne (chargement à froid)', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    // Laisse passer le poll initial puis vérifie l'absence de pill
    await page.waitForTimeout(2000)
    assert.strictEqual(
      await page.locator('[data-testid="factures-reimport-indicator"]').count(),
      0,
      'pas de pill sans ré-import en cours'
    )
  })
})
