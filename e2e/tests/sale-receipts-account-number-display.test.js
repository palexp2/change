const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que sur la page Extraction de données, le numéro de compte QB est
// affiché à côté du nom dans les dropdowns Compte de dépense et Compte de
// paiement, et que les sélecteurs s'empilent verticalement pour donner plus
// de place (pas de grille à 3 colonnes).

describe('Extraction de données : n° de compte QB dans les dropdowns', () => {
  let browser, ctx, page
  let token, candidateId, originalQbId, originalQbType

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    await page.goto(URL + '/sale-receipts', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Extraction de données")', { timeout: 10000 })

    // Pour voir le formulaire QB il faut un reçu status=done && !quickbooks_id.
    // Si tous les reçus done ont déjà été publiés, on en délie un temporairement
    // (sauvegarde + restauration en after()) au lieu d'échouer.
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
    const resp = await page.request.get(URL + '/api/sale-receipts?limit=all', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const body = await resp.json()
    let candidate = body.data.find(r => r.status === 'done' && !r.quickbooks_id)
    if (!candidate) {
      candidate = body.data.find(r => r.status === 'done' && r.quickbooks_id)
      assert.ok(candidate, 'Préalable : au moins un reçu status=done requis')
      originalQbId = candidate.quickbooks_id
      originalQbType = candidate.quickbooks_type
      await page.request.patch(URL + '/api/sale-receipts/' + candidate.id, {
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        data: { quickbooks_id: null, quickbooks_type: null },
      })
    }
    candidateId = candidate.id

    await page.goto(URL + '/sale-receipts/' + candidateId, { waitUntil: 'networkidle' })
    await page.getByTestId('qb-expense-select').waitFor({ state: 'visible', timeout: 15000 })
  })

  after(async () => {
    if (candidateId && originalQbId) {
      await page.request.patch(URL + '/api/sale-receipts/' + candidateId, {
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        data: { quickbooks_id: originalQbId, quickbooks_type: originalQbType },
      }).catch(() => {})
    }
    await browser?.close()
  })

  async function readDropdownOptions(testId) {
    await page.getByTestId(testId).click()
    const portal = page.locator('#qb-select-portal')
    await portal.waitFor({ state: 'visible', timeout: 5000 })
    const options = await portal.locator('button').allTextContents()
    // Refermer le dropdown
    await page.keyboard.press('Escape').catch(() => {})
    await page.mouse.click(5, 5)
    return options
  }

  test("les options de Compte de dépense affichent le n° de compte à côté du nom", async () => {
    const options = await readDropdownOptions('qb-expense-select')
    const hasNumbered = options.some(o => /^\s*\d+\s+—\s+/.test(o))
    assert.ok(
      hasNumbered,
      `Au moins un compte de dépense devrait afficher son n° (format "12345 — Nom"). Options: ${JSON.stringify(options.slice(0, 5))}`
    )
  })

  test("les options de Compte de paiement affichent le n° de compte à côté du nom", async () => {
    const options = await readDropdownOptions('qb-payment-select')
    const hasNumbered = options.some(o => /^\s*\d+\s+—\s+/.test(o))
    assert.ok(
      hasNumbered,
      `Au moins un compte de paiement devrait afficher son n° (format "12345 — Nom"). Options: ${JSON.stringify(options.slice(0, 5))}`
    )
  })

  test("les trois sélecteurs (Fournisseur / Dépense / Paiement) s'empilent verticalement", async () => {
    const vendorLabel  = page.locator('label:has-text("Fournisseur")').first()
    const expenseLabel = page.locator('label:has-text("Compte de dépense")').first()
    const paymentLabel = page.locator('label:has-text("Compte de paiement")').first()

    const [vBox, eBox, pBox] = await Promise.all([
      vendorLabel.boundingBox(),
      expenseLabel.boundingBox(),
      paymentLabel.boundingBox(),
    ])
    assert.ok(vBox && eBox && pBox, 'Les trois labels doivent être visibles')
    // Empilement vertical : y strictement croissant
    assert.ok(eBox.y > vBox.y, `Compte de dépense (${eBox.y}) doit être sous Fournisseur (${vBox.y})`)
    assert.ok(pBox.y > eBox.y, `Compte de paiement (${pBox.y}) doit être sous Compte de dépense (${eBox.y})`)
  })
})
