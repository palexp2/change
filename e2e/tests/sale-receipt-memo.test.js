const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Extraction de données — Description principale + Mémo (autosave + persistance)', () => {
  let browser, ctx, page
  let receiptId = null
  let originalMemo // valeurs à restaurer (on édite un reçu existant)
  let originalDesc
  const TEST_MEMO = `E2E note ${Date.now()}`
  const TEST_DESC = `E2E description ${Date.now()}`

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Choisir un reçu déjà extrait (status=done) — les champs n'apparaissent que dans cet état.
    const picked = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/sale-receipts?limit=all', { headers: { Authorization: `Bearer ${token}` } })
      const list = (await r.json()).data || []
      const done = list.find(x => x.status === 'done')
      return done ? { id: done.id, memo: done.memo ?? null, general_description: done.general_description ?? null } : null
    })
    assert.ok(picked, 'aucun reçu status=done disponible pour le test')
    receiptId = picked.id
    originalMemo = picked.memo
    originalDesc = picked.general_description
  })

  after(async () => {
    // Toujours restaurer les valeurs originales — même si le test échoue.
    if (page && receiptId) {
      await page.evaluate(async ({ id, memo, desc }) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/sale-receipts/${id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ memo, general_description: desc }),
        })
      }, { id: receiptId, memo: originalMemo, desc: originalDesc })
    }
    await browser?.close()
  })

  test('Description principale → autosave → persiste après rechargement', async () => {
    await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'networkidle' })
    const desc = page.locator('[data-testid="receipt-general-description"]')
    await desc.waitFor({ state: 'visible', timeout: 10000 })

    await desc.fill(TEST_DESC)
    await desc.blur()

    // L'API persiste general_description
    await page.waitForFunction(async ({ id, expected }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/sale-receipts/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      const row = await r.json()
      return row.general_description === expected
    }, { id: receiptId, expected: TEST_DESC }, { timeout: 5000 })

    await page.reload({ waitUntil: 'networkidle' })
    const desc2 = page.locator('[data-testid="receipt-general-description"]')
    await desc2.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await desc2.inputValue(), TEST_DESC, 'la description principale doit persister après rechargement')
  })

  test('Note personnalisée → autosave → persiste après rechargement', async () => {
    await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'networkidle' })
    const memo = page.locator('[data-testid="receipt-memo"]')
    await memo.waitFor({ state: 'visible', timeout: 10000 })

    await memo.fill(TEST_MEMO)
    await memo.blur()

    await page.waitForFunction(async ({ id, expected }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/sale-receipts/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      const row = await r.json()
      return row.memo === expected
    }, { id: receiptId, expected: TEST_MEMO }, { timeout: 5000 })

    await page.reload({ waitUntil: 'networkidle' })
    const memo2 = page.locator('[data-testid="receipt-memo"]')
    await memo2.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await memo2.inputValue(), TEST_MEMO, 'la note doit persister après rechargement')
  })
})
