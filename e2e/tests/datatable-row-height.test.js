const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('DataTable — hauteur de ligne compacte (32px)', () => {
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

  async function measureRowHeights(path) {
    await page.goto(URL + path, { waitUntil: 'domcontentloaded' })
    // Attendre qu'au moins une ligne virtualisée soit rendue (jusqu'à 15s).
    await page.waitForFunction(() => {
      const rows = Array.from(document.querySelectorAll('main .card div[style]'))
        .filter(el => {
          const s = el.getAttribute('style') || ''
          return s.includes('position: absolute') && s.includes('grid-template-columns')
        })
      return rows.length > 0
    }, null, { timeout: 30000 })

    return await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('main .card div[style]'))
        .filter(el => {
          const s = el.getAttribute('style') || ''
          return s.includes('position: absolute') && s.includes('grid-template-columns')
        })
      return rows.slice(0, 10).map(r => r.getBoundingClientRect().height)
    })
  }

  for (const path of ['/factures', '/companies', '/contacts', '/products']) {
    test(`${path} : lignes DataTable à 32px`, async () => {
      const rowHeights = await measureRowHeights(path)
      assert.ok(rowHeights.length > 0, `${path}: aucune ligne trouvée`)
      // Lignes normales = 32px. Groupes = 26px. Toutes les lignes doivent être ≤ 32px,
      // et au moins une doit être exactement 32 (ligne data).
      const has32 = rowHeights.some(h => Math.round(h) === 32)
      const allCompact = rowHeights.every(h => Math.round(h) <= 32)
      assert.ok(
        has32 && allCompact,
        `${path}: hauteurs lignes = [${rowHeights.map(h => Math.round(h)).join(', ')}] (attendu lignes ≤ 32px, au moins une à 32)`
      )
    })
  }
})
