const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// La note explicative sous les articles (« Achats proposés : la section À recevoir
// d'Airtable — N achats déjà reçus ou facturés masqués. ») a été retirée à la demande
// de l'utilisateur. Le bouton de bascule « Tous les achats du fournisseur » reste.
// Test en lecture seule : aucun record créé ni modifié.

const TARGET_ID = 'b539b136-03f2-4490-a610-85a76ff2e6a2'

describe('Reçu de vente : la note « Achats proposés » est retirée', () => {
  let browser, ctx, page
  let receiptIds = []

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })

    const token = await page.evaluate(() => localStorage.getItem('erp_token'))
    const resp = await page.request.get(URL + '/api/sale-receipts?limit=all', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const body = await resp.json()
    const all = body.data || []
    assert.ok(all.length, 'Préalable : au moins un reçu de vente est requis')
    // Le reçu signalé par l'utilisateur en premier, puis quelques autres en repli.
    const target = all.find(r => r.id === TARGET_ID)
    receiptIds = [...(target ? [target.id] : []), ...all.slice(0, 5).map(r => r.id)]
    receiptIds = [...new Set(receiptIds)]
  })

  after(async () => {
    await browser?.close()
  })

  test('aucune fiche n\'affiche « Achats proposés »', async () => {
    for (const id of receiptIds) {
      await page.goto(URL + '/sale-receipts/' + id, { waitUntil: 'networkidle' })
      await page.getByTestId('receipt-item-add').waitFor({ state: 'visible', timeout: 20000 })
      const bodyText = await page.locator('#root').innerText()
      assert.ok(
        !bodyText.includes('Achats proposés'),
        `La note « Achats proposés » ne doit plus apparaître (reçu ${id})`,
      )
      assert.ok(
        !/déjà reçus? ou facturés?/.test(bodyText),
        `La mention des achats masqués ne doit plus apparaître (reçu ${id})`,
      )
    }
  })

  test('le bouton de bascule des achats du fournisseur reste fonctionnel quand il est présent', async () => {
    let checked = false
    for (const id of receiptIds) {
      await page.goto(URL + '/sale-receipts/' + id, { waitUntil: 'networkidle' })
      await page.getByTestId('receipt-item-add').waitFor({ state: 'visible', timeout: 20000 })
      const toggle = page.getByTestId('lia-show-all')
      if (await toggle.count() === 0) continue
      const first = toggle.first()
      const before = (await first.innerText()).trim()
      await first.click()
      await page.waitForTimeout(300)
      const after = (await page.getByTestId('lia-show-all').first().innerText()).trim()
      assert.notEqual(after, before, 'Le libellé du bouton doit basculer')
      // On revient à l'état initial (état local, rien n'est persisté côté serveur).
      await page.getByTestId('lia-show-all').first().click()
      checked = true
      break
    }
    if (!checked) console.log('Aucun reçu avec bascule LIA parmi les fiches testées — assertion sautée')
  })
})
