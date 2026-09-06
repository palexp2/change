const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Achats fournisseurs — section de comptabilisation QB : auto-pré-sélection des comptes
// depuis le dernier achat publié du même fournisseur + autosave. Records jetables only.
describe('Achats — comptabilisation QB pré-remplie depuis l\'historique fournisseur', () => {
  let browser, ctx, page
  let pastId = null, currentId = null
  let exp1 = null, exp2 = null, pay1 = null
  const VENDOR = `__e2e_achat_acct_${Date.now()}`

  async function api(method, path, body) {
    return page.evaluate(async ({ method, path, body }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      const txt = await r.text()
      try { return JSON.parse(txt) } catch { return txt }
    }, { method, path, body })
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    const accounts = await api('GET', '/connectors/quickbooks/accounts')
    if (Array.isArray(accounts)) {
      const expenses = accounts.filter(a => ['Expense', 'Other Expense', 'Cost of Goods Sold', 'Other Current Asset'].includes(a.AccountType))
      exp1 = expenses[0]; exp2 = expenses.find(a => a.Id !== exp1?.Id)
      pay1 = accounts.find(a => ['Bank', 'Credit Card'].includes(a.AccountType))
    }
    const taxCodes = await api('GET', '/connectors/quickbooks/tax-codes')
    const taxId = Array.isArray(taxCodes) && taxCodes[0] ? taxCodes[0].Id : null

    // Deux dépenses jetables, même fournisseur (match par nom).
    const past = await api('POST', '/achats-fournisseurs', {
      type: 'purchase', date_achat: '2030-01-01', vendor: VENDOR, description: 'E2E past',
      amount_cad: 100, tax_cad: 15, payment_method: 'Carte de crédit', status: 'Brouillon',
    })
    const current = await api('POST', '/achats-fournisseurs', {
      type: 'purchase', date_achat: '2026-06-14', vendor: VENDOR, description: 'E2E current',
      amount_cad: 50, tax_cad: 7.5, payment_method: 'Carte de crédit', status: 'Brouillon',
    })
    pastId = past?.id; currentId = current?.id

    // « past » : marquée publiée (quickbooks_id) + comptes/taxe connus → modèle.
    if (pastId && exp1 && pay1) {
      await api('PUT', `/achats-fournisseurs/${pastId}`, {
        quickbooks_id: 'E2E-ACHAT-PAST',
        expense_account_id: exp1.Id,
        payment_account_id: pay1.Id,
        tax_code_id: taxId,
      })
    }
  })

  after(async () => {
    if (page) {
      for (const id of [pastId, currentId]) {
        if (id) await api('DELETE', `/achats-fournisseurs/${id}`)
      }
    }
    await browser?.close()
  })

  test('vendor-history retourne l\'achat publié du même fournisseur, trié, auto-exclu', async (t) => {
    if (!currentId || !pastId || !exp1) { t.skip('comptes QB indisponibles ou achats non créés'); return }
    const res = await api('GET', `/achats-fournisseurs/${currentId}/vendor-history`)
    const data = res?.data
    assert.ok(Array.isArray(data) && data.some(x => x.id === pastId), 'l\'achat passé publié doit apparaître')
    assert.ok(!data.some(x => x.id === currentId), 'l\'achat courant ne doit pas s\'inclure')
    assert.equal(data[0].id, pastId, 'l\'achat le plus récent (daté 2030) doit être en tête')
    assert.equal(data[0].expense_account_id, exp1.Id)
  })

  test('la modale pré-remplit dépense + paiement, sans reprendre la taxe', async (t) => {
    if (!currentId || !exp1 || !pay1) { t.skip('prérequis manquants'); return }
    await page.goto(`${URL}/achats-fournisseurs?id=${currentId}`, { waitUntil: 'networkidle' })
    await page.locator('[data-testid="achat-expense-select"]').waitFor({ state: 'visible', timeout: 10000 })
    await page.locator('[data-testid="achat-prefill-note"]').waitFor({ state: 'visible', timeout: 5000 })

    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const expenseText = await page.locator('[data-testid="achat-expense-select"]').innerText()
    assert.match(expenseText, new RegExp(esc(exp1.Name)), 'compte de dépense pré-rempli')
    const paymentText = await page.locator('[data-testid="achat-payment-select"]').innerText()
    assert.match(paymentText, new RegExp(esc(pay1.Name)), 'compte de paiement pré-rempli')

    // Le code de taxe N'EST PAS repris de l'historique → reste « Aucune taxe ».
    const taxText = await page.locator('[data-testid="achat-taxcode-select"]').innerText()
    assert.match(taxText, /Aucune taxe/, 'le code de taxe ne doit pas être auto-rempli depuis l\'historique')
  })

  test('changer un compte autosauvegarde via PUT (sans bouton Enregistrer)', async (t) => {
    if (!currentId || !exp2) { t.skip('deuxième compte de dépense indisponible'); return }
    await page.goto(`${URL}/achats-fournisseurs?id=${currentId}`, { waitUntil: 'networkidle' })
    await page.locator('[data-testid="achat-expense-select"]').waitFor({ state: 'visible', timeout: 10000 })

    // Ouvre le select, recherche et choisit un AUTRE compte de dépense.
    await page.locator('[data-testid="achat-expense-select"]').click()
    const portal = page.locator('#qb-select-portal')
    await portal.waitFor({ state: 'visible', timeout: 5000 })
    await portal.locator('input').fill(exp2.Name.slice(0, 6))
    await portal.locator('button', { hasText: exp2.Name }).first().click()

    // Laisse l'autosave (PUT) s'exécuter puis relit le record.
    await page.waitForTimeout(800)
    const row = await api('GET', `/achats-fournisseurs/${currentId}`)
    assert.equal(row.expense_account_id, exp2.Id, 'le nouveau compte doit être persisté sans clic Enregistrer')
  })
})
