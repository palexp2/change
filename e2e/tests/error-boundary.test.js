// ErrorBoundary global — vérifie qu'une erreur de rendu affiche un fallback
// exploitable au lieu de l'écran blanc total.
//
// On déclenche le crash via la route de diagnostic /__boom (composant qui throw
// au render, voir App.jsx → CrashTest). Le test :
//   1. navigue vers /__boom → le fallback ErrorBoundary apparaît.
//   2. vérifie que le contenu (titre + boutons) est rendu, pas un écran blanc.
//   3. clique « Tableau de bord » → recovery réelle vers une page fonctionnelle.
//
// Aucune création de record, aucune mutation de config → pas de cleanup.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

describe('ErrorBoundary — fallback au lieu du blank-screen', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    await browser?.close()
  })

  test('une erreur de rendu affiche le fallback puis permet le recovery', async () => {
    // Déclenche un crash de rendu via la route de diagnostic.
    await page.goto(URL + '/__boom', { waitUntil: 'domcontentloaded' })

    // Le fallback doit apparaître (et NON un écran blanc).
    const fallback = page.locator('[data-testid="error-boundary-fallback"]')
    await fallback.waitFor({ state: 'visible', timeout: 10000 })

    const text = await fallback.innerText()
    assert.ok(text.includes('Une erreur est survenue'), 'le titre du fallback doit être affiché')
    assert.ok(/Réessayer/.test(text), 'le bouton Réessayer doit être présent')
    assert.ok(/Tableau de bord/.test(text), 'le bouton Tableau de bord doit être présent')

    // Recovery : « Tableau de bord » fait une navigation dure vers /dashboard.
    await page.click('[data-testid="error-boundary-fallback"] button:has-text("Tableau de bord")')
    await page.waitForURL(u => u.toString().includes('/dashboard'), { timeout: 15000 })

    // La page de destination doit être fonctionnelle (pas de fallback résiduel).
    await assert.doesNotReject(
      fallback.waitFor({ state: 'detached', timeout: 10000 }),
      'le fallback ne doit plus être affiché après recovery'
    )
    assert.ok(page.url().includes('/dashboard'), 'doit avoir navigué vers le tableau de bord')
  })
})
