// Per-user landing page.
//
// pap@orisha.io (a specific user id) should land on /agent; everyone else on
// /dashboard. The redirect is computed client-side in App.jsx from the decoded
// JWT (payload = { id, role, name }), so we can verify both branches:
//   1. A normal login (claude@orisha.io) lands on /dashboard — change is scoped.
//   2. Visiting "/" while logged in as claude redirects to /dashboard.
//   3. With pap's id in the (client-decoded) token, "/" redirects to /agent.
//
// The client decodes the JWT payload without verifying the signature for
// routing purposes, so test 3 injects a token carrying pap's id. No real data
// is created; nothing to clean up.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const PAP_USER_ID = '5637ebf2-74e8-4245-9f1e-64d80b53b216'

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

describe('Page d\'accueil par utilisateur', () => {
  let browser

  before(async () => { browser = await chromium.launch() })
  after(async () => { await browser?.close() })

  test('claude@orisha.io atterrit sur /dashboard', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    const page = await ctx.newPage()
    await login(page)
    // After login, the app redirects away from /login to the home path.
    assert.match(page.url(), /\/dashboard/, 'un utilisateur normal doit atterrir sur /dashboard')

    // Visiting "/" explicitly should also resolve to /dashboard.
    await page.goto(URL + '/', { waitUntil: 'domcontentloaded' })
    await page.waitForURL(u => u.toString().includes('/dashboard'), { timeout: 10000 })
    assert.match(page.url(), /\/dashboard/)
    await ctx.close()
  })

  test('un token portant l\'id de pap@orisha.io atterrit sur /agent', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    const page = await ctx.newPage()
    // Load the app origin first so localStorage is writable for this origin.
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })

    // Forge a token the client will decode to pap's id. App.jsx routing reads
    // only the decoded payload; the signature isn't checked for redirecting.
    await page.evaluate((papId) => {
      const payload = { id: papId, role: 'admin', name: 'PAP Test', exp: 4102444800 }
      const b64 = btoa(JSON.stringify(payload))
      localStorage.setItem('erp_token', `x.${b64}.x`)
    }, PAP_USER_ID)

    await page.goto(URL + '/', { waitUntil: 'domcontentloaded' })
    await page.waitForURL(u => u.toString().includes('/agent'), { timeout: 10000 })
    assert.match(page.url(), /\/agent/, 'pap@orisha.io doit atterrir sur /agent')
    await ctx.close()
  })
})
