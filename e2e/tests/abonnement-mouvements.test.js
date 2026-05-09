// Vérifie la page /abonnements/mouvements : route, rendu DataTable, présence
// des colonnes attendues, et le clic sur l'abonnement ouvre la modale détail.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Mouvements d\'abonnements — page', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('endpoint /api/projets/abonnement-events retourne data[]', async () => {
    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/abonnement-events?limit=10', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    })
    assert.ok(Array.isArray(data.data), 'data doit être un array')
    assert.equal(typeof data.total, 'number', 'total doit être un number')
    if (data.data.length > 0) {
      const r = data.data[0]
      for (const k of ['id', 'event_date', 'event_type', 'subscription_id', 'category']) {
        assert.ok(k in r, `champ manquant: ${k}`)
      }
    }
  })

  test('la page /abonnements/mouvements affiche le tableau', async () => {
    await page.goto(URL + '/abonnements/mouvements', { waitUntil: 'networkidle' })
    // Titre
    const title = await page.locator('h1:has-text("Mouvements d\'abonnements")').first().innerText()
    assert.match(title, /Mouvements d'abonnements/, `titre inattendu: ${title}`)
    // Au moins une ligne dans la table — DataTable est un grid virtualisé, on
    // détecte les rows via le bouton d'ouverture d'abo qu'on rend dans chaque.
    await page.waitForSelector('[data-testid^="abo-event-open-"]', { timeout: 10000 })
    const rowCount = await page.locator('[data-testid^="abo-event-open-"]').count()
    assert.ok(rowCount > 0, `aucune ligne dans le tableau (got ${rowCount})`)
  })

  test('cliquer sur un lien d\'abonnement ouvre la modale détail', async () => {
    await page.goto(URL + '/abonnements/mouvements', { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid^="abo-event-open-"]', { timeout: 10000 })
    const firstBtn = page.locator('[data-testid^="abo-event-open-"]').first()
    await firstBtn.click()
    const modalTitle = page.locator('text=Détails de l\'abonnement')
    await modalTitle.waitFor({ state: 'visible', timeout: 5000 })
    assert.ok(await modalTitle.isVisible(), 'modale non visible après clic')
  })
})
