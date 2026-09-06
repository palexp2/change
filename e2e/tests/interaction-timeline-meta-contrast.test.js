const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// La ligne « date · utilisateur » sous chaque bulle de la timeline est posée
// SUR LE FOND DE PAGE, pas dans la bulle. Elle héritait de la couleur méta de
// la bulle sortante (brand-200, très clair) → quasi illisible. Elle doit
// désormais utiliser une teinte neutre lisible dans les deux sens.
describe('Timeline interactions — lisibilité de la ligne date · utilisateur', () => {
  let browser, ctx, page, contactId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Un contact ayant au moins une interaction sortante (bulle verte) —
    // c'est le cas problématique. Lecture seule, aucune mutation.
    contactId = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/interactions?limit=all', { headers: { Authorization: `Bearer ${token}` } })
      const all = (await r.json()).interactions || []
      const out = all.find(i => i.direction === 'out' && i.contact_id)
      return out ? out.contact_id : null
    })
    if (!contactId) throw new Error('Aucune interaction sortante rattachée à un contact')
  })

  after(async () => { await browser?.close() })

  test('contraste suffisant sur le fond de page (≥ 4.5:1)', async () => {
    await page.goto(`${URL}/contacts/${contactId}`, { waitUntil: 'networkidle' })
    const meta = page.locator('[data-testid="interaction-meta"]')
    await meta.first().waitFor({ state: 'visible', timeout: 10000 })

    const results = await meta.evaluateAll(nodes => {
      const parse = c => (c.match(/[\d.]+/g) || []).map(Number)
      const lum = ([r, g, b]) => {
        const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
      }
      return nodes.map(n => {
        const color = parse(getComputedStyle(n).color).slice(0, 3)
        // Remonter jusqu'au premier ancêtre au fond non transparent
        let el = n, bg = [255, 255, 255]
        while (el) {
          const c = parse(getComputedStyle(el).backgroundColor)
          if (c.length >= 3 && (c[3] === undefined || c[3] > 0)) { bg = c.slice(0, 3); break }
          el = el.parentElement
        }
        const l1 = lum(color), l2 = lum(bg)
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
        return { ratio, color: color.join(','), bg: bg.join(','), text: n.textContent.trim().slice(0, 40) }
      })
    })

    assert.ok(results.length > 0, 'au moins une ligne méta attendue')
    for (const r of results) {
      assert.ok(
        r.ratio >= 4.5,
        `contraste trop faible (${r.ratio.toFixed(2)}:1) sur « ${r.text} » — texte rgb(${r.color}) sur rgb(${r.bg})`,
      )
    }
  })
})
