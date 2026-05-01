const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const BRAND_500 = 'rgb(43, 194, 92)'
const BRAND_600 = 'rgb(33, 177, 75)'
const BRAND_700 = 'rgb(27, 142, 60)'

describe('Brand palette — couleur primaire #21B14B', () => {
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

  after(async () => {
    await browser?.close()
  })

  test('sidebar — l\'item actif utilise brand-600 (#21B14B)', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    const activeBg = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a, button'))
      const active = links.find(el => {
        const cls = el.className || ''
        return typeof cls === 'string' && cls.includes('bg-brand-600')
      })
      if (!active) return null
      return getComputedStyle(active).backgroundColor
    })
    assert.equal(activeBg, BRAND_600, `attendu ${BRAND_600}, reçu ${activeBg}`)
  })

  test('aucune référence indigo dans le CSS du build', async () => {
    const cssUrl = await page.evaluate(() => {
      const link = document.querySelector('link[rel="stylesheet"]')
      return link?.href || null
    })
    assert.ok(cssUrl, 'CSS bundle introuvable')
    const cssText = await page.evaluate(async (u) => fetch(u).then(r => r.text()), cssUrl)
    // Tailwind indigo-600 = #4f46e5, indigo-500 = #6366f1, indigo-50 = #eef2ff
    const hits = (cssText.match(/(#4f46e5|#6366f1|#eef2ff|#e0e7ff|#c7d2fe)/gi) || []).length
    assert.equal(hits, 0, `${hits} couleurs indigo Tailwind trouvées dans le CSS`)
  })

  test('palette brand présente dans le CSS', async () => {
    const cssUrl = await page.evaluate(() => document.querySelector('link[rel="stylesheet"]')?.href)
    const cssText = await page.evaluate(async (u) => fetch(u).then(r => r.text()), cssUrl)
    assert.ok(cssText.toLowerCase().includes('#21b14b'), 'brand-600 (#21B14B) absent du bundle CSS')
  })
})
