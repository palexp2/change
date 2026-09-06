const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const ERP = process.env.ERP_URL || 'http://localhost:3004/erp'
const ADMIN_EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const ADMIN_PASS = process.env.ERP_PASS
if (!ADMIN_PASS) throw new Error('ERP_PASS env var required')

async function apiCall(token, method, path, body) {
  const res = await fetch(`${ERP}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, body: json }
}

async function loginToken(email, password) {
  const r = await apiCall(null, 'POST', '/auth/login', { email, password })
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`)
  return r.body.token
}

async function uiLogin(page, email, password) {
  await page.goto(ERP + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', password)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(/\/dashboard/, { timeout: 10000 })
}

describe('Rôle RH — UI (nav + redirection)', () => {
  const ts = Date.now()
  const opsEmail = `e2e-ui-ops-${ts}@example.com`
  const password = 'testpassword123'

  let browser, adminToken, opsUser

  before(async () => {
    adminToken = await loginToken(ADMIN_EMAIL, ADMIN_PASS)
    const r = await apiCall(adminToken, 'POST', '/admin/users', { email: opsEmail, name: 'E2E UI Ops', password, role: 'ops' })
    if (r.status !== 201) throw new Error(`create ops failed: ${r.status} ${JSON.stringify(r.body)}`)
    opsUser = r.body
    browser = await chromium.launch()
  })

  after(async () => {
    if (browser) await browser.close()
    if (opsUser?.id) await apiCall(adminToken, 'DELETE', `/admin/users/${opsUser.id}`)
  })

  test('ops : nav cache Employés et Codes d\'activité, mais montre Feuille / Paies / Banque', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    const page = await ctx.newPage()
    await uiLogin(page, opsEmail, password)

    // Déplier le groupe RH dans la nav (le bouton est intitulé "RH")
    const rhGroup = page.locator('nav button:has-text("RH")')
    if (await rhGroup.count() > 0) await rhGroup.first().click()
    await page.waitForTimeout(200)

    const navLinks = await page.locator('nav a').allTextContents()
    const navText = navLinks.join(' | ')
    assert.ok(!navText.includes('Employés'), 'ops ne doit PAS voir le lien Employés. Nav: ' + navText)
    assert.ok(!navText.includes("Codes d'activité"), 'ops ne doit PAS voir le lien Codes d\'activité. Nav: ' + navText)
    assert.ok(navText.includes('Feuille de temps'), 'ops doit voir Feuille de temps')
    assert.ok(navText.includes('Paies'), 'ops doit voir Paies')
    assert.ok(navText.includes("Banque d'heures"), 'ops doit voir Banque d\'heures')

    await ctx.close()
  })

  test('ops : /employees redirige vers /dashboard', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    const page = await ctx.newPage()
    await uiLogin(page, opsEmail, password)
    await page.goto(ERP + '/employees', { waitUntil: 'domcontentloaded' })
    await page.waitForURL(/\/dashboard/, { timeout: 5000 })
    assert.match(page.url(), /\/dashboard/, 'doit être redirigé sur /dashboard')
    await ctx.close()
  })

  test('admin : nav montre tout (Employés + Codes d\'activité)', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    const page = await ctx.newPage()
    await uiLogin(page, ADMIN_EMAIL, ADMIN_PASS)
    const rhGroup = page.locator('nav button:has-text("RH")')
    if (await rhGroup.count() > 0) await rhGroup.first().click()
    await page.waitForTimeout(200)
    const navText = (await page.locator('nav a').allTextContents()).join(' | ')
    assert.ok(navText.includes('Employés'), 'admin doit voir Employés')
    assert.ok(navText.includes("Codes d'activité"), 'admin doit voir Codes d\'activité')
    await ctx.close()
  })
})
