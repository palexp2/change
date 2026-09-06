const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que le compte 14000 « Stock de pièces » (Other Current Asset) est
// proposé comme Compte de dépense lors de la publication QB d'un reçu.

describe('Extraction de données : compte 14000 sélectionnable en dépense', () => {
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

    await page.goto(URL + '/sale-receipts', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Extraction de données")', { timeout: 10000 })

    setupToken = await page.evaluate(() => localStorage.getItem('erp_token'))
    const resp = await page.request.get(URL + '/api/sale-receipts?limit=all', {
      headers: { Authorization: 'Bearer ' + setupToken },
    })
    const body = await resp.json()
    let candidate = body.data.find(r => r.status === 'done' && !r.quickbooks_id)
    if (!candidate) {
      candidate = body.data.find(r => r.status === 'done' && r.quickbooks_id)
      assert.ok(candidate, 'Préalable : un reçu status=done requis')
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

  test('le compte 14000 « Stock de pièces » est listé dans le dropdown Compte de dépense', async () => {
    await page.getByTestId('qb-expense-select').click()
    const portal = page.locator('#qb-select-portal')
    await portal.waitFor({ state: 'visible', timeout: 5000 })
    const options = await portal.locator('button').allTextContents()
    const has14000 = options.some(o => /^\s*14000\s+—\s+/.test(o))
    assert.ok(
      has14000,
      `Le compte 14000 « Stock de pièces » devrait apparaître. Options 14xxx vues : ${JSON.stringify(options.filter(o => /^\s*1\d{4}/.test(o)))}`
    )
  })
})
