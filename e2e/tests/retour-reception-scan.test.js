// Section « Réception » de la fiche retour : réceptionniste + date pré-remplis,
// et un code scanné affiche l'instruction d'étagère.
//
// AUCUNE écriture réelle : le POST de réception est intercepté et répondu par
// une réponse fabriquée (le retour ouvert sert de support en lecture seule).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const BASE = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
const TOKEN = process.env.ERP_TOKEN
if (!PASS && !TOKEN) throw new Error('ERP_PASS or ERP_TOKEN env var required')

const MESSAGE = "Bonjour Martin, SVP place l'article dans l'étagère d'analyse."

function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('RetourDetail — section Réception', () => {
  let browser, ctx, page, posted

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' })
    if (TOKEN) {
      await page.evaluate(t => localStorage.setItem('erp_token', t), TOKEN)
    } else {
      await page.fill('input[type="email"]', EMAIL)
      await page.fill('input[type="password"]', PASS)
      await page.click('button:has-text("Se connecter")')
      await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    }

    // Garde-fou : toute écriture est bloquée, sauf le scan, qui est simulé.
    await page.route('**/api/**', async route => {
      const req = route.request()
      if (['GET', 'HEAD'].includes(req.method())) return route.continue()
      if (req.url().includes('/receive-scan')) {
        posted = req.postDataJSON()
        return route.fulfill({
          status: 200,
          json: {
            action: 'received',
            code: posted.code,
            item: { id: 'e2e', serial_number: posted.code, product_name: 'Article de test' },
            message: MESSAGE,
            shelf: 'analyse',
          },
        })
      }
      return route.abort()
    })
  })

  after(async () => { await browser?.close() })

  test('réceptionniste et date pré-remplis, scan → instruction affichée', async () => {
    // Un retour au hasard, ouvert en lecture seule.
    const returnId = await page.evaluate(async () => {
      const r = await fetch('/erp/api/projets/retours?limit=1', {
        headers: { Authorization: `Bearer ${localStorage.getItem('erp_token')}` },
      })
      return (await r.json()).data[0].id
    })
    const me = await page.evaluate(async () => {
      const r = await fetch('/erp/api/auth/me', {
        headers: { Authorization: `Bearer ${localStorage.getItem('erp_token')}` },
      })
      const j = await r.json()
      return (j.user || j).name
    })
    await page.goto(`${BASE}/retours/${returnId}`, { waitUntil: 'domcontentloaded' })

    const section = page.locator('[data-testid="retour-reception"]')
    await section.waitFor({ timeout: 15000 })
    // Réceptionniste par défaut = l'utilisateur connecté.
    assert.equal((await section.locator('[data-testid="reception-person"]').innerText()).trim(), me)
    assert.equal(await section.locator('[data-testid="reception-date"]').inputValue(), todayISO())

    await section.locator('[data-testid="manual-scan-input"]').fill('TH0001')
    await section.locator('[data-testid="manual-scan-form"] button[type="submit"]').click()

    await section.locator('[data-testid="reception-message"]').waitFor({ timeout: 10000 })
    assert.match(await section.locator('[data-testid="reception-message"]').innerText(), /étagère d'analyse/)
    assert.equal(posted.received_by, me)
    assert.equal(posted.received_at, todayISO())
    assert.equal(posted.code, 'TH0001')
  })
})
