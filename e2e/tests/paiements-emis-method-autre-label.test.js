// /paiements-emis — le moyen « autre » s'affiche sous le nom « Paiement ».
//
// Le bouton du sélecteur de moyen portait « Autre », un libellé qui ne disait
// rien de ce qu'on saisit (prélèvement, paiement de facture en ligne…). Il
// s'appelle maintenant « Paiement ». La clé stockée en base reste `autre` :
// seul l'affichage change — le test le vérifie sur le bouton ET sur le résumé
// de la saisie, qui reprend le même libellé.
//
// Test en lecture seule : aucun record n'est créé ni modifié.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Paiements émis — libellé du moyen « autre »', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    await page.goto(URL + '/paiements-emis?onglet=pending', { waitUntil: 'domcontentloaded' })
    // La saisie est repliée par défaut : on l'ouvre par « Nouveau paiement ».
    await page.waitForSelector('[data-testid="payment-new-toggle"]', { timeout: 20000 })
    if (!(await page.locator('[data-testid="payment-new-form"]').count())) {
      await page.click('[data-testid="payment-new-toggle"]')
    }
    await page.waitForSelector('[data-testid="payment-new-form"]', { timeout: 20000 })
  })

  after(async () => {
    await browser?.close()
  })

  test('le bouton du sélecteur affiche « Paiement » et plus « Autre »', async () => {
    const btn = page.locator('[data-testid="payment-method-autre"]')
    await btn.waitFor({ timeout: 20000 })
    assert.equal((await btn.textContent()).trim(), 'Paiement')

    // Aucun autre bouton du sélecteur ne doit s'appeler « Autre ».
    const labels = await page.locator('[data-testid="payment-method-picker"] button')
      .allTextContents()
    assert.ok(labels.length >= 6, `sélecteur incomplet : ${JSON.stringify(labels)}`)
    assert.ok(!labels.some(l => l.trim() === 'Autre'),
      `« Autre » ne doit plus apparaître : ${JSON.stringify(labels)}`)
    assert.ok(labels.some(l => l.trim() === 'Paiement'),
      `« Paiement » attendu : ${JSON.stringify(labels)}`)
  })

  test('le résumé de la saisie reprend le nouveau libellé', async () => {
    await page.click('[data-testid="payment-method-autre"]')
    assert.equal(await page.getAttribute('[data-testid="payment-method-autre"]', 'aria-pressed'), 'true')

    // Rien n'est enregistré : on remplit juste de quoi faire apparaître le
    // résumé (montant + bénéficiaire), sans jamais cliquer sur « Enregistrer ».
    await page.fill('[data-testid="payment-new-label"]', 'E2E lecture seule')
    await page.fill('[data-testid="payment-new-amount"]', '1,00')
    const summary = await page.textContent('[data-testid="payment-new-summary"]')
    assert.ok(summary.includes('paiement du'), `résumé inattendu : ${summary}`)
    assert.ok(!/\bautre du\b/i.test(summary), `ancien libellé encore présent : ${summary}`)
  })
})
