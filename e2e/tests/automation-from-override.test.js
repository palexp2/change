const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const SYSTEM_IDS = ['sys_installation_followup', 'sys_shipment_tracking_email']

describe('Per-automation from override (Postmark)', () => {
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

  for (const id of SYSTEM_IDS) {
    test(`PATCH ${id}.action_config.from persiste, re-GET renvoie la valeur`, async () => {
      // Capture original so we can restore
      const original = await page.evaluate(async (autoId) => {
        const token = localStorage.getItem('erp_token')
        const r = await fetch(`/erp/api/automations/${autoId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        return r.json()
      }, id)
      const originalFrom = (() => {
        try { return JSON.parse(original.action_config || '{}').from || null } catch { return null }
      })()

      // Set override to info@orisha.io
      const patched = await page.evaluate(async (autoId) => {
        const token = localStorage.getItem('erp_token')
        const r = await fetch(`/erp/api/automations/${autoId}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action_config: JSON.stringify({ from: 'info@orisha.io' }) }),
        })
        return { status: r.status, body: await r.json() }
      }, id)
      assert.strictEqual(patched.status, 200, `PATCH ${id} devrait réussir`)
      const patchedFrom = (() => { try { return JSON.parse(patched.body.action_config || '{}').from } catch { return null } })()
      assert.strictEqual(patchedFrom, 'info@orisha.io')

      // Re-GET and confirm persistence
      const refetched = await page.evaluate(async (autoId) => {
        const token = localStorage.getItem('erp_token')
        const r = await fetch(`/erp/api/automations/${autoId}`, { headers: { Authorization: `Bearer ${token}` } })
        return r.json()
      }, id)
      const refetchedFrom = JSON.parse(refetched.action_config || '{}').from
      assert.strictEqual(refetchedFrom, 'info@orisha.io')

      // Restore
      await page.evaluate(async ({ autoId, from }) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/automations/${autoId}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action_config: JSON.stringify({ from: from || null }) }),
        })
      }, { autoId: id, from: originalFrom })
    })
  }

  test('PATCH refuse une adresse hors liste autorisée', async () => {
    const res = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/automations/sys_installation_followup', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action_config: JSON.stringify({ from: 'intrus@badomain.com' }) }),
      })
      return { status: r.status, body: await r.json() }
    })
    assert.strictEqual(res.status, 400, 'doit rejeter une adresse non autorisée')
  })

  test('PATCH refuse action_config sur un sys non-email', async () => {
    const res = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/automations/sys_gmail_sync', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action_config: JSON.stringify({ from: 'info@orisha.io' }) }),
      })
      return { status: r.status, body: await r.json() }
    })
    assert.strictEqual(res.status, 403, 'sys automations non-email ne doivent pas accepter action_config')
  })

  test('UI AutomationDetail affiche le picker sur sys_installation_followup', async () => {
    await page.goto(`${URL}/automations/sys_installation_followup`, { waitUntil: 'networkidle' })
    const label = page.locator('h2:has-text("Expéditeur")').first()
    await label.waitFor({ state: 'visible', timeout: 8000 })
    const select = page.locator('h2:has-text("Expéditeur") ~ select, section:has(h2:has-text("Expéditeur")) select').first()
    // Fallback: search any select under the same card (the Expéditeur card)
    const anySelect = page.locator('div:has(> h2:has-text("Expéditeur")) select').first()
    const target = (await select.count()) > 0 ? select : anySelect
    await target.waitFor({ state: 'visible', timeout: 5000 })
    const optionValues = await target.locator('option').evaluateAll(opts => opts.map(o => o.value))
    assert.ok(optionValues.includes('info@orisha.io'), 'info@ manquant dans picker UI')
    assert.ok(optionValues.includes('support@orisha.io'), 'support@ manquant dans picker UI')
  })
})
