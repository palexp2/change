// Écritures de fin de mois — lien vers l'écriture dans QuickBooks.
//
// Demande : pouvoir ouvrir l'écriture comptabilisée dans QuickBooks en cliquant
// sur son numéro (JE #...) plutôt que d'avoir à la retrouver à la main.
//
// Lecture seule : aucun record créé, aucune config écrasée → pas de cleanup.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Mois avec des provisions déjà comptabilisées dans QuickBooks (qb_je_id posé).
const PUBLISHED_MONTH = '2026-07'

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
}

describe('Écritures de fin de mois — lien vers QuickBooks', () => {
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

  test('une écriture comptabilisée affiche un lien cliquable vers QuickBooks', async () => {
    // On atteint directement le mois publié via l'API pour confirmer les données,
    // puis on navigue le mois affiché jusqu'à celui-ci (le sélecteur de mois n'a
    // pas de saisie directe — on avance/recule par mois depuis le mois par défaut).
    const state = await page.evaluate(async (month) => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch(`/erp/api/month-end/month/${month}`, { headers: { Authorization: `Bearer ${token}` } })
      return res.json()
    }, PUBLISHED_MONTH)
    const published = (state.provisions || []).find(p => p.qb_je_id)
    assert.ok(published, `aucune provision comptabilisée trouvée pour ${PUBLISHED_MONTH}`)
    assert.ok(published.qb_je_url, 'qb_je_url absent de la réponse API')
    assert.match(published.qb_je_url, /qbo\.intuit\.com\/app\/journal\?txnId=\d+/)

    await page.goto(URL + '/fin-de-mois', { waitUntil: 'domcontentloaded' })
    await page.locator('[data-testid="month-label"]').waitFor({ state: 'visible', timeout: 20000 })

    // Recule mois par mois jusqu'à atteindre le mois publié (borné pour éviter une boucle infinie).
    const prevBtn = page.locator('[data-testid="month-label"]').locator('..').locator('button').first()
    for (let i = 0; i < 24; i++) {
      const amountLocator = page.locator(`[data-testid="amount-${published.id}"]`)
      await amountLocator.waitFor({ state: 'visible', timeout: 15000 })
      const link = page.locator(`text=JE #${published.qb_je_id}`).first()
      if (await link.count() > 0) break
      await prevBtn.click()
      await page.waitForTimeout(400)
    }

    const link = page.locator(`a:has-text("JE #${published.qb_je_id}")`)
    await link.waitFor({ state: 'visible', timeout: 10000 })
    const href = await link.getAttribute('href')
    assert.equal(href, published.qb_je_url, 'le lien affiché ne correspond pas à qb_je_url')
    assert.equal(await link.getAttribute('target'), '_blank', 'le lien devrait ouvrir un nouvel onglet')
  })
})
