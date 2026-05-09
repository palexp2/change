// Smoke test: section "Permissions" sur OrderDetail —
//   - liste les items dont le produit est de type 'JWT'
//   - affiche l'adresse du contrôleur opérationnel du client
//   - expose un bouton "Configurer" pointant vers orisha-config://configure?controller=<address>

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

describe('OrderDetail — section Permissions', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => { await browser?.close() })

  test('un order avec items JWT + contrôleur opérationnel affiche la section et le bouton Configurer', async () => {
    // Trouve une commande avec au moins un item JWT et un contrôleur opérationnel.
    // On scanne les commandes récentes jusqu'à matcher.
    const found = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const list = await fetch('/erp/api/orders?limit=200', {
        headers: { Authorization: `Bearer ${tok}` },
      }).then(r => r.json())
      for (const o of (list.data || [])) {
        const detail = await fetch(`/erp/api/orders/${o.id}`, {
          headers: { Authorization: `Bearer ${tok}` },
        }).then(r => r.json())
        const hasJwt = (detail.items || []).some(i => i.product_type === 'JWT')
        const hasController = Array.isArray(detail.central_controllers) && detail.central_controllers.length > 0
        if (hasJwt && hasController) {
          return {
            id: o.id,
            jwtCount: detail.items.filter(i => i.product_type === 'JWT').length,
            address: detail.central_controllers[0].address,
          }
        }
      }
      return null
    })

    assert.ok(found, 'aucune commande trouvée avec items JWT + contrôleur opérationnel — scanner plus loin ou créer une fixture')

    await page.goto(`${URL}/orders/${found.id}`, { waitUntil: 'networkidle' })

    // Le titre "Permissions (n)" doit être présent.
    const heading = page.locator(`h2:has-text("Permissions (${found.jwtCount})")`)
    await heading.waitFor({ state: 'visible', timeout: 5000 })

    // L'adresse du contrôleur doit apparaître textuellement dans le header de la section.
    await page.locator(`text=${found.address}`).first().waitFor({ state: 'visible', timeout: 5000 })

    // Un bouton "Configurer" pointant vers orisha-config:// doit exister.
    const cfgLink = page.locator('a[href^="orisha-config://configure"]').first()
    await cfgLink.waitFor({ state: 'visible', timeout: 5000 })
    const href = await cfgLink.getAttribute('href')
    assert.match(href, /^orisha-config:\/\/configure\?controller=/)
    assert.ok(href.includes(encodeURIComponent(found.address)), `href doit contenir l'adresse encodée du contrôleur : ${href}`)
  })
})
