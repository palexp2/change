// Régression : la section "Permissions" (items JWT + contrôleur + bouton
// Configurer) a été retirée de OrderDetail. Le test vérifie qu'elle ne réapparaît
// pas, même pour une commande qui combine items JWT + contrôleur opérationnel.

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

describe('OrderDetail — section Permissions retirée', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => { await browser?.close() })

  test('une commande avec items JWT + contrôleur opérationnel n\'affiche plus la section Permissions ni le bouton Configurer', async () => {
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
        if (hasJwt && hasController) return { id: o.id }
      }
      return null
    })

    assert.ok(found, 'aucune commande trouvée avec items JWT + contrôleur opérationnel — scanner plus loin ou créer une fixture')

    await page.goto(`${URL}/orders/${found.id}`, { waitUntil: 'networkidle' })

    // On attend le rendu de l'en-tête pour s'assurer que la page est bien chargée.
    await page.locator('text=/Créée le /').first().waitFor({ state: 'visible', timeout: 5000 })

    // Aucun titre "Permissions (...)".
    const permHeadings = await page.locator('h2', { hasText: /^Permissions \(/ }).count()
    assert.equal(permHeadings, 0, `attendu 0 section Permissions, trouvé ${permHeadings}`)

    // Aucun lien orisha-config://configure.
    const cfgLinks = await page.locator('a[href^="orisha-config://configure"]').count()
    assert.equal(cfgLinks, 0, `attendu 0 lien Configurer, trouvé ${cfgLinks}`)
  })
})
