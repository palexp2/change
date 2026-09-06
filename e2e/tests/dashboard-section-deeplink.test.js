const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Deep-link vers une section précise du dashboard : /dashboard/:section
// (ex: /dashboard/taux-de-remplacement) doit scroller directement sur la
// section correspondante. Le slug est matché de façon tolérante : avec ou
// sans tirets (« tauxderemplacement » == « taux-de-remplacement »).
describe('Dashboard — deep-link vers une section', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      timezoneId: 'America/Montreal',
    })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  // Une section est « scrollée à l'écran » si le haut de sa carte est proche
  // du haut du viewport (block: 'start') — disons dans les 200 premiers px.
  async function topOfSection(sectionId) {
    return page.evaluate((id) => {
      const el = document.querySelector(`[data-section-id="${id}"]`)
      if (!el) return null
      return el.getBoundingClientRect().top
    }, sectionId)
  }

  test('slug avec tirets : /dashboard/taux-de-remplacement scrolle sur la section', async () => {
    await page.goto(URL + '/dashboard/taux-de-remplacement', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-section-id="section_replacement_rate"]', { timeout: 15000 })
    // Laisse le smooth-scroll s'achever.
    await page.waitForTimeout(1200)
    const top = await topOfSection('section_replacement_rate')
    assert.ok(top !== null, 'section présente dans le DOM')
    assert.ok(top >= -50 && top < 200, `section scrollée en haut (top=${top})`)
  })

  test('slug sans tirets : /dashboard/tauxderemplacement résout la même section', async () => {
    await page.goto(URL + '/dashboard/tauxderemplacement', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-section-id="section_replacement_rate"]', { timeout: 15000 })
    await page.waitForTimeout(1200)
    const top = await topOfSection('section_replacement_rate')
    assert.ok(top !== null, 'section présente')
    assert.ok(top >= -50 && top < 200, `section scrollée en haut (top=${top})`)
  })

  test('autre section : /dashboard/bilan scrolle sur le Bilan QuickBooks', async () => {
    await page.goto(URL + '/dashboard/bilan', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-section-id="section_balance_sheet"]', { timeout: 15000 })
    await page.waitForTimeout(1200)
    const top = await topOfSection('section_balance_sheet')
    assert.ok(top !== null, 'section présente')
    assert.ok(top >= -50 && top < 200, `section scrollée en haut (top=${top})`)
  })

  test('slug inconnu : /dashboard/nimportequoi rend le dashboard sans scroller/planter', async () => {
    await page.goto(URL + '/dashboard/nimportequoi', { waitUntil: 'domcontentloaded' })
    // Le dashboard se charge normalement (première section visible en haut).
    await page.waitForSelector('[data-section-id]', { timeout: 15000 })
    await page.waitForTimeout(500)
    const scrollY = await page.evaluate(() => window.scrollY)
    assert.ok(scrollY < 100, `pas de scroll pour un slug inconnu (scrollY=${scrollY})`)
  })
})
