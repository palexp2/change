const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que le panneau "Données source de la personnalisation" expose les
// champs motivation_today et motivation_why_now — c'est là que vit le mot
// "humidity" pour Bair Lane Farm (le champ challenges ne le mentionne pas),
// et l'IA s'appuie dessus pour personnaliser le courriel.
describe('RelanceQualification — motivation_today / motivation_why_now visibles', () => {
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

  test('API renvoie motivation_today + motivation_why_now', async () => {
    const data = await page.evaluate(async () => {
      const tk = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/email-relance/qualification-calls', { headers: { Authorization: 'Bearer ' + tk } })
      return r.json()
    })
    const items = data.data || []
    const bair = items.find(it => /bair lane/i.test(it.company.name))
    assert.ok(bair, 'Bair Lane Farm absent de la liste')
    assert.ok(bair.qualification_call.motivation_today, 'motivation_today manquant dans la réponse API')
    assert.ok(/humidity/i.test(bair.qualification_call.motivation_today),
      'motivation_today devrait contenir "humidity" pour Bair Lane Farm')
    assert.ok(bair.qualification_call.motivation_why_now, 'motivation_why_now manquant dans la réponse API')
  })

  test('UI : panneau "Données source" affiche les deux motivations pour Bair Lane Farm', async () => {
    await page.goto(`${URL}/relance-qualification`, { waitUntil: 'networkidle' })

    const card = page.locator('article').filter({ hasText: /Bair Lane Farm/i }).first()
    await card.waitFor({ timeout: 8000 })

    // Ouvrir le <details>
    const summary = card.locator('summary:has-text("Données source")').first()
    await summary.click()

    // Les deux libellés doivent être présents
    await card.locator('text=Motivation aujourd\'hui').first().waitFor({ timeout: 3000 })
    await card.locator('text=Motivation — pourquoi maintenant').first().waitFor({ timeout: 3000 })

    // Et le verbatim doit contenir "humidity" quelque part (peu importe le champ)
    const detailsText = await card.locator('details').first().innerText()
    assert.ok(/humidity/i.test(detailsText),
      'le mot "humidity" devrait être visible dans le panneau Données source')
  })
})
