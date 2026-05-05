const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Numéros de comptes QB attendus dans un Deposit Stripe (cf. QB_STRIPE_ACCOUNTS).
const KNOWN_ACCT_NUMS = ['40000', '41000', '12000', '12100', '23900']
const PAYOUT_ID = 'po_1TN0ZxEO122sMsbJJwo1bfpS'

describe('Preview deposit — compte QB par ligne', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('preview-deposit renvoie lineAccounts parallèle à deposit.Line', async () => {
    const data = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch(`/erp/api/stripe-payouts/${id}/preview-deposit`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.json()
    }, PAYOUT_ID)

    assert.ok(data.deposit?.Line?.length > 0, 'aucune ligne dans le deposit')
    assert.ok(Array.isArray(data.lineAccounts), 'lineAccounts absent ou non-array')
    assert.equal(data.lineAccounts.length, data.deposit.Line.length,
      `lineAccounts.length (${data.lineAccounts.length}) ≠ deposit.Line.length (${data.deposit.Line.length})`)

    // Chaque entrée non-nulle doit exposer { acctNum, name }
    const nonNull = data.lineAccounts.filter(Boolean)
    assert.ok(nonNull.length > 0, 'aucune ligne avec compte QB résolu')
    for (const a of nonNull) {
      assert.ok(typeof a.name === 'string' && a.name.length > 0, `name manquant: ${JSON.stringify(a)}`)
      // acctNum peut être null (ex. comptes bancaires sans AcctNum) mais doit être string sinon
      if (a.acctNum != null) {
        assert.equal(typeof a.acctNum, 'string', `acctNum doit être string: ${JSON.stringify(a)}`)
      }
    }

    // Au moins un compte de revenu/AR/deferred (avec AcctNum) doit apparaître.
    const acctNums = nonNull.map(a => a.acctNum).filter(Boolean)
    const hasKnown = acctNums.some(n => KNOWN_ACCT_NUMS.includes(n))
    assert.ok(hasKnown,
      `aucun compte connu (${KNOWN_ACCT_NUMS.join(',')}) trouvé. AcctNum reçus: ${acctNums.join(',') || '(aucun)'}`)
  })

  test('UI affiche la colonne Compte QB avec acctNum + nom dans le tableau de lignes', async () => {
    await page.goto(`${URL}/stripe-payouts/${PAYOUT_ID}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('h1', { timeout: 10000 })
    await page.click('button:has-text("Aperçu Deposit")')
    await page.waitForSelector('text=Aperçu Deposit', { timeout: 8000 })

    // Ouvrir le <details> "Lignes du Deposit"
    const summary = page.locator('summary:has-text("Lignes du Deposit")').first()
    await summary.click()

    // En-tête de colonne Compte QB
    const headerVisible = await page.locator('th:has-text("Compte QB")').first().isVisible()
    assert.ok(headerVisible, 'en-tête "Compte QB" absent')

    // Au moins une cellule contient un numéro de compte connu suivi d'un nom
    const tableText = await page.locator('table').filter({ hasText: 'Compte QB' }).first().innerText()
    const matchedAcct = KNOWN_ACCT_NUMS.find(n => tableText.includes(n))
    assert.ok(matchedAcct, `aucun AcctNum (${KNOWN_ACCT_NUMS.join(',')}) visible dans le tableau`)
  })
})
