const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('Fiche reçu — boutons Archiver / Supprimer dans le document', () => {
  let browser, ctx, page
  let receiptId = null
  const PREFIX = `__e2e_detail_actions_${Date.now()}`

  async function archivedAt(id) {
    return page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/sale-receipts/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok) return 'GONE'
      return (await r.json()).archived_at
    }, id)
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    receiptId = await page.evaluate(async ({ b64, prefix }) => {
      const token = localStorage.getItem('erp_token')
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const fd = new FormData()
      fd.append('file', new Blob([bytes], { type: 'image/png' }), `${prefix}.png`)
      const r = await fetch('/erp/api/sale-receipts/upload', {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
      })
      return (await r.json()).id
    }, { b64: PNG_1x1, prefix: PREFIX })
    assert.ok(receiptId, 'le reçu de test doit être créé')
  })

  after(async () => {
    // Supprime le reçu s'il existe encore (le test de delete peut ne pas avoir tourné)
    if (page && receiptId) {
      await page.evaluate(async (id) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/sale-receipts/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      }, receiptId)
    }
    await browser?.close()
  })

  test('Archiver puis Désarchiver depuis la fiche', async () => {
    await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'networkidle' })
    const btn = page.locator('[data-testid="receipt-archive"]')
    await btn.waitFor({ state: 'visible', timeout: 10000 })
    assert.match(await btn.textContent(), /Archiver/, 'le bouton doit proposer « Archiver » au départ')

    // Archiver
    await btn.click()
    await page.waitForFunction(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/sale-receipts/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      return !!(await r.json()).archived_at
    }, receiptId, { timeout: 5000 })
    await page.locator('[data-testid="receipt-archive"]:has-text("Désarchiver")').waitFor({ state: 'visible', timeout: 3000 })

    // Désarchiver
    await page.locator('[data-testid="receipt-archive"]').click()
    await page.waitForFunction(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/sale-receipts/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      return (await r.json()).archived_at === null
    }, receiptId, { timeout: 5000 })
    await page.locator('[data-testid="receipt-archive"]:has-text("Archiver")').waitFor({ state: 'visible', timeout: 3000 })
    assert.equal(await archivedAt(receiptId), null)
  })

  test('Supprimer depuis la fiche (avec confirmation) → retour à la liste', async () => {
    await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'networkidle' })
    await page.locator('[data-testid="receipt-delete"]').waitFor({ state: 'visible', timeout: 10000 })
    await page.locator('[data-testid="receipt-delete"]').click()

    // Modale de confirmation
    const modal = page.locator('.fixed.inset-0.z-50 .bg-white.rounded-2xl').first()
    await modal.waitFor({ state: 'visible', timeout: 3000 })
    await modal.locator('button:has-text("Supprimer")').click()

    // Redirection vers la liste
    await page.waitForURL(u => /\/sale-receipts$/.test(u.toString().replace(/[?#].*$/, '')), { timeout: 5000 })

    // L'API ne retrouve plus le reçu
    assert.equal(await archivedAt(receiptId), 'GONE', 'le reçu doit avoir été supprimé')
    receiptId = null // déjà supprimé — évite un double delete dans after()
  })
})
