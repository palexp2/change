// AutomationDetail — envoi d'un email de test : vérifie la modale de confirmation
// du side effect avant tout envoi réel (règle CLAUDE.md « confirmation des side effects »).
//   1. Sur /automations/sys_installation_followup, on saisit une adresse de test.
//   2. "Envoyer test" ouvre une modale de CONFIRMATION listant l'adresse + la langue.
//      Aucun appel /test-email n'est déclenché à ce stade.
//   3. Annuler ferme la modale sans aucun appel.
//   4. Confirmer déclenche exactement un appel /test-email (mocké — aucun email réel).
//
// Aucun record n'est créé ni muté (le champ "à" est un état local non persisté),
// et l'appel API est intercepté → pas de cleanup nécessaire au-delà du browser.

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

describe('AutomationDetail — confirmation avant envoi d\'un email de test', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => { await browser?.close() })

  async function gotoAutomation(testEmail) {
    await page.goto(`${URL}/automations/sys_installation_followup`, { waitUntil: 'networkidle' })
    const input = page.locator('input[type="email"]').first()
    await input.waitFor({ state: 'visible', timeout: 10000 })
    await input.fill(testEmail)
  }

  test('"Envoyer test" → modale de confirmation listant l\'adresse, aucun envoi avant confirmation', async () => {
    const addr = 'confirm-e2e@orisha.test'
    await gotoAutomation(addr)

    let sendCount = 0
    await page.route('**/api/automations/*/test-email', async route => {
      sendCount++
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ to: addr, language: 'French' }) })
    })

    await page.getByRole('button', { name: /Envoyer test/ }).click()

    // Modale de confirmation listant l'adresse — l'envoi n'a pas encore eu lieu.
    const dialog = page.locator('[role="dialog"]')
    await dialog.waitFor({ state: 'visible', timeout: 5000 })
    assert.ok(await dialog.getByText('Envoyer un email de test').count() > 0, 'titre de confirmation manquant')
    assert.ok(await dialog.getByText(addr).count() > 0, 'la confirmation doit afficher l\'adresse')
    assert.equal(sendCount, 0, 'aucun /test-email avant confirmation')
  })

  test('Annuler la modale n\'envoie aucun email', async () => {
    const addr = 'annule-e2e@orisha.test'
    await gotoAutomation(addr)

    let sendCount = 0
    await page.route('**/api/automations/*/test-email', async route => {
      sendCount++
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ to: addr, language: 'French' }) })
    })

    await page.getByRole('button', { name: /Envoyer test/ }).click()
    const dialog = page.locator('[role="dialog"]')
    await dialog.waitFor({ state: 'visible', timeout: 5000 })

    // Bouton d'annulation de la modale de confirmation.
    await dialog.getByRole('button', { name: /Annuler/ }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 5000 })

    await page.waitForTimeout(500)
    assert.equal(sendCount, 0, 'aucun /test-email après annulation')
  })

  test('Confirmer déclenche exactement un appel /test-email', async () => {
    const addr = 'envoi-e2e@orisha.test'
    await gotoAutomation(addr)

    let sendCount = 0
    await page.route('**/api/automations/*/test-email', async route => {
      sendCount++
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ to: addr, language: 'French' }) })
    })

    await page.getByRole('button', { name: /Envoyer test/ }).click()
    const dialog = page.locator('[role="dialog"]')
    await dialog.waitFor({ state: 'visible', timeout: 5000 })

    // Bouton de confirmation "Envoyer" dans la modale.
    await dialog.getByRole('button', { name: /^Envoyer$/ }).click()

    // Toast de succès rendu après l'appel mocké.
    await page.locator('text=/Email test envoyé à/').first().waitFor({ state: 'visible', timeout: 5000 })
    assert.equal(sendCount, 1, 'exactement un /test-email après confirmation')
  })
})
