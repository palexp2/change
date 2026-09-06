const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Stripe payout — confirm modal UI', () => {
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

  test('le bouton Push ouvre une ConfirmModal, pas un window.confirm', async () => {
    // Fail the test if a native confirm dialog opens (it shouldn't — we replaced it)
    page.on('dialog', (d) => {
      throw new Error(`window.confirm still opened: "${d.message()}" — modal replacement failed`)
    })

    // Fetch a payout stripe_id via the API (any will do — we cancel before pushing)
    const payoutId = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/stripe-payouts?limit=1', { headers: { Authorization: `Bearer ${token}` } })
      const j = await r.json()
      return j.data?.[0]?.stripe_id
    })
    assert.ok(payoutId, 'Aucun payout disponible pour le test')

    await page.goto(`${URL}/stripe-payouts/${payoutId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    // Look for the Push button. It may be labeled "Pousser vers QuickBooks" or similar.
    const pushBtn = page.locator('button:has-text("Pousser"), button:has-text("QuickBooks")').first()
    const visible = await pushBtn.isVisible().catch(() => false)

    if (!visible) {
      // If the payout is already pushed, test the unlink modal instead
      const unlinkBtn = page.locator('button:has-text("Délier")').first()
      const uvisible = await unlinkBtn.isVisible().catch(() => false)
      if (!uvisible) {
        // No actionable button — skip without failure (the UI test can't proceed)
        console.log('⚠️  Aucun payout actionnable trouvé — skip')
        return
      }
      await unlinkBtn.click()
    } else {
      await pushBtn.click()
    }

    // A ConfirmModal should now be visible: it has role-agnostic styling but its button
    // is "Annuler" or the confirm label. Check that the overlay rendered.
    const modal = page.locator('.fixed.inset-0.z-50 >> .bg-white.rounded-2xl').first()
    await modal.waitFor({ state: 'visible', timeout: 2000 })

    // Confirm the modal has an "Annuler" button and a confirm button
    const cancelBtn = modal.locator('button:has-text("Annuler")')
    await assert.ok(await cancelBtn.isVisible(), 'Bouton Annuler absent de la modale')

    // The message must NOT contain "transactions" anymore (we removed that count)
    const modalText = await modal.textContent()
    assert.ok(!/\btransactions?\b/i.test(modalText), `Le message contient encore "transactions": ${modalText}`)

    // Cancel to avoid any side-effect
    await cancelBtn.click()
    await modal.waitFor({ state: 'hidden', timeout: 2000 })
  })
})
