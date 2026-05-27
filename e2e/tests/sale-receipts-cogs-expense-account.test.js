const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie le formulaire « Publier sur QuickBooks » de la page Extraction de données :
//   1) Le filtre Compte de dépense inclut les comptes de type Cost of Goods Sold
//      (ex. 65000 « Expédition, livraison et poste »).
//   2) Le toggle Type Purchase / Bill bascule l'UI : Purchase montre Compte de
//      paiement, Bill cache ce panneau et expose l'Échéance.

describe('Extraction de données : formulaire QB', () => {
  let browser, ctx, page
  let setupToken, setupCandidateId, setupOriginalQbId, setupOriginalQbType

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    setupToken = await page.evaluate(() => localStorage.getItem('erp_token'))
    const resp = await page.request.get(URL + '/api/sale-receipts?limit=all', {
      headers: { Authorization: 'Bearer ' + setupToken },
    })
    const body = await resp.json()
    let candidate = body.data.find(r => r.status === 'done' && !r.quickbooks_id)
    if (!candidate) {
      candidate = body.data.find(r => r.status === 'done' && r.quickbooks_id)
      if (!candidate) throw new Error('Préalable : un reçu status=done requis')
      setupOriginalQbId = candidate.quickbooks_id
      setupOriginalQbType = candidate.quickbooks_type
      await page.request.patch(URL + '/api/sale-receipts/' + candidate.id, {
        headers: { Authorization: 'Bearer ' + setupToken, 'Content-Type': 'application/json' },
        data: { quickbooks_id: null, quickbooks_type: null },
      })
    }
    setupCandidateId = candidate.id

    await page.goto(URL + '/sale-receipts/' + setupCandidateId, { waitUntil: 'networkidle' })
    await page.getByTestId('qb-expense-select').waitFor({ state: 'visible', timeout: 15000 })
  })

  after(async () => {
    if (setupCandidateId && setupOriginalQbId) {
      await page.request.patch(URL + '/api/sale-receipts/' + setupCandidateId, {
        headers: { Authorization: 'Bearer ' + setupToken, 'Content-Type': 'application/json' },
        data: { quickbooks_id: setupOriginalQbId, quickbooks_type: setupOriginalQbType },
      }).catch(() => {})
    }
    await browser?.close()
  })

  test('le compte 65000 (Cost of Goods Sold) est listé dans le dropdown Compte de dépense', async () => {
    await page.getByTestId('qb-expense-select').click()
    const portal = page.locator('#qb-select-portal')
    await portal.waitFor({ state: 'visible', timeout: 5000 })
    const options = await portal.locator('button').allTextContents()
    await page.keyboard.press('Escape').catch(() => {})
    const hasShipping = options.some(o => /Expédition.*livraison.*poste/i.test(o))
    assert.ok(
      hasShipping,
      `Le compte « Expédition, livraison et poste » devrait être dans le dropdown. Options: ${JSON.stringify(options.slice(0, 5))}`
    )
  })

  test("mode Purchase (défaut) : Compte de paiement visible, Échéance absente", async () => {
    // Le bouton radio Purchase doit être coché par défaut
    const purchaseRadio = page.getByTestId('qb-type-purchase')
    assert.equal(await purchaseRadio.isChecked(), true)

    const paymentLabel = page.locator('label:has-text("Compte de paiement")').first()
    await paymentLabel.waitFor({ state: 'visible', timeout: 5000 })

    const dueDateLabel = page.locator('label:has-text("Échéance")')
    assert.equal(await dueDateLabel.count(), 0, 'Le label Échéance ne doit pas apparaître en mode Purchase')
  })

  test("mode Bill : Compte de paiement disparaît, Échéance apparaît", async () => {
    await page.getByTestId('qb-type-bill').check()

    const dueDateLabel = page.locator('label:has-text("Échéance")').first()
    await dueDateLabel.waitFor({ state: 'visible', timeout: 5000 })

    const paymentLabel = page.locator('label:has-text("Compte de paiement")')
    assert.equal(await paymentLabel.count(), 0, 'Le label Compte de paiement ne doit pas apparaître en mode Bill')

    // L'input date d'échéance doit être présent
    const dueDateInput = dueDateLabel.locator('xpath=following-sibling::input[@type="date"]').first()
    await dueDateInput.waitFor({ state: 'visible', timeout: 5000 })

    // Mentionner que le crédit va automatiquement aux Comptes fournisseurs (rassure l'utilisateur)
    const hint = page.locator('text=Comptes fournisseurs').first()
    assert.ok(await hint.isVisible(), 'L\'aide-mémoire « Comptes fournisseurs » doit être visible en mode Bill')

    // Re-basculer en Purchase pour ne pas laisser l'UI dans un état non-défaut au prochain chargement
    await page.getByTestId('qb-type-purchase').check()
  })

  test('le badge QB d\'un reçu déjà publié est un lien cliquable vers QuickBooks', async () => {
    // Trouver un reçu déjà publié et ouvrir sa fiche détail directement par URL.
    const token = await page.evaluate(() => localStorage.getItem('erp_token'))
    const resp = await page.request.get(URL + '/api/sale-receipts?limit=all', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const body = await resp.json()
    const pushed = body.data.find(r => r.quickbooks_id)
    assert.ok(pushed, 'Préalable : il faut au moins un reçu déjà publié sur QB en DB')
    assert.ok(pushed.quickbooks_url, 'L\'API doit retourner quickbooks_url quand le reçu est publié')

    await page.goto(URL + '/sale-receipts/' + pushed.id, { waitUntil: 'networkidle' })

    const qbLink = page.getByTestId('qb-link')
    await qbLink.waitFor({ state: 'visible', timeout: 5000 })

    const href = await qbLink.getAttribute('href')
    assert.match(
      href,
      /qbo\.intuit\.com\/app\/(expense|bill)\?txnId=\d+/,
      `href doit pointer vers QB. Reçu: ${href}`
    )
    assert.equal(await qbLink.getAttribute('target'), '_blank', 'le lien doit s\'ouvrir dans un nouvel onglet')
  })
})
