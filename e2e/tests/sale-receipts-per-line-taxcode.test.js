const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que la section Articles permet de choisir un code de taxe QB PAR LIGNE
// (comme dans QuickBooks). Le test sauvegarde items[] + montants du reçu et les
// restaure dans after() — la DB de test = la DB de prod (cf. CLAUDE.md).

describe('Extraction de données : code de taxe par ligne d\'article', () => {
  let browser, ctx, page
  let token, receiptId, originalItems, originalAmounts, taxCodes, addedRow

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    token = await page.evaluate(() => localStorage.getItem('erp_token'))
    const resp = await page.request.get(URL + '/api/sale-receipts?limit=all', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const body = await resp.json()
    // Reçu non publié de préférence (l'éditeur d'articles reste dispo même publié).
    const candidate = body.data.find(r => r.status === 'done')
    assert.ok(candidate, 'Préalable : au moins un reçu status=done est requis')
    receiptId = candidate.id
    originalItems = candidate.items || []
    originalAmounts = {
      subtotal: candidate.subtotal ?? null,
      tps: candidate.tps ?? null,
      tvq: candidate.tvq ?? null,
      other_taxes: candidate.other_taxes ?? null,
      total: candidate.total ?? null,
    }

    // Liste des codes de taxe QB (le sélecteur par ligne s'en sert).
    try {
      const tc = await page.request.get(URL + '/api/connectors/quickbooks/tax-codes', {
        headers: { Authorization: 'Bearer ' + token },
      })
      taxCodes = tc.ok() ? await tc.json() : []
    } catch { taxCodes = [] }

    await page.goto(URL + '/sale-receipts/' + receiptId, { waitUntil: 'networkidle' })
    await page.getByTestId('receipt-item-add').waitFor({ state: 'visible', timeout: 10000 })
  })

  after(async () => {
    // Restaure toujours items + montants, même si le test a échoué.
    if (receiptId && token) {
      await page.request.patch(URL + '/api/sale-receipts/' + receiptId, {
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        data: { items: originalItems, ...originalAmounts },
      })
    }
    await browser?.close()
  })

  test('la colonne « Code de taxe » et un sélecteur par ligne sont présents', async () => {
    await assert.doesNotReject(
      page.getByRole('columnheader', { name: 'Code de taxe' }).waitFor({ state: 'visible', timeout: 5000 }),
    )

    // S'assurer qu'au moins une ligne existe (ajout au besoin — restauré en after()).
    let count = await page.locator('[data-testid^="receipt-item-row-"]').count()
    if (count === 0) {
      await page.getByTestId('receipt-item-add').click()
      await page.locator('[data-testid="receipt-item-row-0"]').waitFor({ state: 'visible', timeout: 5000 })
      addedRow = 0
      count = 1
    }
    await page.getByTestId('receipt-item-taxcode-0').waitFor({ state: 'visible', timeout: 5000 })
  })

  test('choisir un code de taxe sur une ligne le persiste en DB', async () => {
    if (!taxCodes.length) {
      // QB non connecté : pas de codes à sélectionner. Le rendu est déjà couvert
      // par le test précédent ; on n'invente pas un Id de taxe factice.
      console.log('QuickBooks non connecté — aucun code de taxe ; étape de persistance ignorée.')
      return
    }
    const target = taxCodes[0]

    const select = page.getByTestId('receipt-item-taxcode-0')
    await select.scrollIntoViewIfNeeded()
    await select.click()
    const menu = page.getByTestId('receipt-item-taxcode-0-menu')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    // Recherche puis clic sur l'option correspondante.
    await menu.locator('input').fill(target.Name)
    await menu.getByRole('button', { name: target.Name, exact: false }).first().click()
    await page.waitForTimeout(900)

    const resp = await page.request.get(URL + '/api/sale-receipts/' + receiptId, {
      headers: { Authorization: 'Bearer ' + token },
    })
    const body = await resp.json()
    assert.ok(body.items[0], 'La ligne 0 doit exister')
    assert.equal(
      String(body.items[0].tax_code_id), String(target.Id),
      `Le code de taxe de la ligne 0 doit être ${target.Id} (${target.Name})`,
    )
  })
})
