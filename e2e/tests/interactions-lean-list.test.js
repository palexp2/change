const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que la liste /api/interactions renvoie un payload allégé
// (sans body_html / transcript_formatted / body_text / meeting_notes) et
// que le panneau détail fetch ces champs via GET /api/interactions/:id
// à l'ouverture.
describe('Interactions — liste allégée + détail à la demande', () => {
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

  test('liste omet les champs lourds; détail les fetche', async () => {
    const heavyFields = ['body_html', 'body_text', 'transcript_formatted', 'meeting_notes']

    // Intercepte la 1ère réponse liste et la 1ère réponse détail
    const listResp = page.waitForResponse(
      r => /\/api\/interactions\?/.test(r.url()) && !r.url().includes('include=heavy') && r.ok(),
      { timeout: 15000 }
    )
    await page.goto(`${URL}/interactions`, { waitUntil: 'domcontentloaded' })
    const list = await (await listResp).json()
    assert.ok(Array.isArray(list.interactions) && list.interactions.length > 0, 'liste non vide')

    // Aucune ligne de la liste ne doit porter les champs lourds
    for (const f of heavyFields) {
      const leaked = list.interactions.find(r => r[f])
      assert.equal(leaked, undefined, `champ lourd ${f} présent dans la liste (${leaked?.id})`)
    }

    // Cliquer sur la 1ère ligne; le détail doit déclencher GET /api/interactions/:id
    await page.waitForSelector('.cursor-pointer.hover\\:bg-slate-50', { timeout: 10000 })
    const detailResp = page.waitForResponse(
      r => /\/api\/interactions\/[0-9a-f-]+(?:\?|$)/.test(r.url()) && r.ok(),
      { timeout: 5000 }
    )
    await page.locator('.cursor-pointer.hover\\:bg-slate-50').first().click()
    const detail = await (await detailResp).json()
    assert.ok(detail.id, 'détail contient un id')
    const hasHeavyKeys = heavyFields.some(f => f in detail)
    assert.ok(hasHeavyKeys, 'détail expose les clés des champs lourds')
  })
})
