const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Picker adresse expéditeur Postmark', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('endpoint /connectors/postmark retourne adresses + défaut', async () => {
    const data = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api/connectors/postmark', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.json()
    })
    assert.ok(Array.isArray(data.addresses), 'addresses doit être un tableau')
    assert.ok(data.addresses.includes('info@orisha.io'), 'alias info@ manquant')
    assert.ok(data.addresses.includes('support@orisha.io'), 'alias support@ manquant')
    assert.ok(data.addresses.includes('rescue@orisha.io'), 'alias rescue@ manquant')
    assert.ok(data.addresses.some(a => /^pap@orisha\.io$/.test(a)), 'adresse utilisateur attendue absente')
    assert.ok('default_from' in data, 'default_from doit être présent')
  })

  test('endpoint refuse adresse hors domaine', async () => {
    const res = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/connectors/postmark/default', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_from: 'test@badomain.com' }),
      })
      return { status: r.status, body: await r.json() }
    })
    assert.strictEqual(res.status, 400, 'doit rejeter une adresse hors @orisha.io')
  })

  test('PUT /connectors/postmark/default accepte une adresse @orisha.io et persiste', async () => {
    const initial = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/connectors/postmark', { headers: { Authorization: `Bearer ${token}` } })
      return r.json()
    })

    const result = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/connectors/postmark/default', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_from: 'info@orisha.io' }),
      })
      return { status: r.status, body: await r.json() }
    })
    assert.strictEqual(result.status, 200, 'doit accepter info@orisha.io')
    assert.strictEqual(result.body.default_from, 'info@orisha.io')

    // Vérifier que la valeur est bien persistée
    const refetched = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/connectors/postmark', { headers: { Authorization: `Bearer ${token}` } })
      return r.json()
    })
    assert.strictEqual(refetched.default_from, 'info@orisha.io')

    // Restaurer l'état initial
    await page.evaluate(async (val) => {
      const token = localStorage.getItem('erp_token')
      await fetch('/erp/api/connectors/postmark/default', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_from: val }),
      })
    }, initial.default_from || null)
  })

  test('UI Connectors → Postmark affiche le picker avec les adresses attendues', async () => {
    await page.goto(`${URL}/connectors`, { waitUntil: 'networkidle' })

    const postmarkBtn = page.locator('button:has-text("Postmark")').first()
    await postmarkBtn.waitFor({ state: 'visible', timeout: 5000 })
    await postmarkBtn.click()

    // Attendre que le panneau affiche le select
    const label = page.locator('p:has-text("Adresse expéditeur par défaut")')
    await label.waitFor({ state: 'visible', timeout: 5000 })

    const select = page.locator('p:has-text("Adresse expéditeur par défaut") ~ select').first()
    await select.waitFor({ state: 'visible', timeout: 5000 })
    const optionValues = await select.locator('option').evaluateAll(opts => opts.map(o => o.value))
    assert.ok(optionValues.includes('info@orisha.io'), 'info@ manquant dans picker UI')
    assert.ok(optionValues.includes('support@orisha.io'), 'support@ manquant dans picker UI')
    assert.ok(optionValues.includes('rescue@orisha.io'), 'rescue@ manquant dans picker UI')
  })
})
