const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que le Layout ne tente plus la connexion WebSocket /ws tant que
// VITE_REALTIME_ENABLED n'est pas défini (elle retournait 404 et spammait
// les access logs toutes les 5s).
describe('Layout — pas de polling WebSocket /ws', () => {
  let browser, ctx, page
  const wsAttempts = []

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()

    page.on('websocket', ws => { wsAttempts.push(ws.url()) })
    page.on('request', req => {
      const u = req.url()
      if (u.includes('/ws') && !u.includes('/erp/assets/')) wsAttempts.push(u)
    })

    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('aucune tentative /ws pendant 10s après login', async () => {
    // Laisse le Layout monter + un cycle complet des retries (5s)
    await page.waitForTimeout(10000)
    const wsHits = wsAttempts.filter(u => /\/ws(\?|$)/.test(u))
    assert.equal(wsHits.length, 0, `tentatives /ws inattendues: ${wsHits.join(', ')}`)
  })
})
