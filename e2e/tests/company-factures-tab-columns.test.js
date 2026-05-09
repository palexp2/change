const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Régression : dans la fiche entreprise, l'onglet Factures doit afficher
// le total HT en devise native + une colonne Devise. Échéance et Solde dû retirés.
describe('CompanyDetail — onglet Factures : colonnes total HT + devise', () => {
  let browser, ctx, page, token, companyId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    token = await page.evaluate(() => localStorage.getItem('erp_token'))

    // Trouve une entreprise qui a au moins une facture avec un montant non nul
    const found = await page.evaluate(async (tok) => {
      const r = await fetch('/erp/api/projets/factures?limit=all', { headers: { Authorization: `Bearer ${tok}` } })
      const j = await r.json()
      const list = j.data || []
      const f = list.find(x => x.company_id && Number(x.amount_before_tax_cad) > 0)
      return f || null
    }, token)
    assert.ok(found, 'devrait trouver une facture avec company_id et amount_before_tax_cad > 0')
    companyId = found.company_id
  })

  after(async () => { await browser?.close() })

  test('colonnes Total HT et Devise présentes ; Échéance et Solde dû retirés ; valeurs non nulles', async () => {
    await page.goto(`${URL}/companies/${companyId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    await page.click('button:has-text("factures")')
    // Attend que le tableau soit rendu
    await page.locator('th:has-text("N° document")').waitFor({ state: 'visible', timeout: 5000 })

    const headers = await page.locator('table thead th').allTextContents()
    const headerText = headers.join(' | ')

    assert.ok(headerText.includes('Total HT'), `Total HT manquant. Headers: ${headerText}`)
    assert.ok(headerText.includes('Devise'), `Devise manquant. Headers: ${headerText}`)
    assert.ok(!headerText.includes('Échéance'), `Échéance ne devrait pas être présent. Headers: ${headerText}`)
    assert.ok(!headerText.includes('Solde dû'), `Solde dû ne devrait pas être présent. Headers: ${headerText}`)

    // Vérifie qu'au moins une ligne a une devise visible (CAD ou USD) et un total non nul
    const firstRow = page.locator('table tbody tr').first()
    await firstRow.waitFor({ state: 'visible', timeout: 5000 })
    const cells = await firstRow.locator('td').allTextContents()
    // Ordre : N° document, Statut, Date, Total HT, Devise
    assert.equal(cells.length, 5, `Devrait avoir 5 colonnes, trouvé: ${JSON.stringify(cells)}`)
    const totalCell = cells[3]
    const currencyCell = cells[4]
    assert.ok(/CAD|USD/.test(currencyCell), `Devise devrait être CAD ou USD, trouvé: "${currencyCell}"`)
    // Le total doit être différent de "$0,00" / "$0" / "—"
    assert.ok(!/^[\s$0,. ]+$/.test(totalCell) && totalCell.trim() !== '—',
      `Total HT ne devrait pas être nul. Trouvé: "${totalCell}"`)
  })
})
