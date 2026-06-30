const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// Vérifie que cliquer « Archiver » DEPUIS un document (fiche détail) sort du
// document et renvoie vers l'interface Extraction de données (liste).
// On crée un reçu jetable, on l'ouvre, on archive, puis on le supprime.

describe('Extraction de données : archiver depuis un document renvoie à la liste', () => {
  let browser, ctx, page
  let createdId
  const NAME = `__e2e_archive_nav_${Date.now()}.png`

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    createdId = await page.evaluate(async ({ b64, name }) => {
      const token = localStorage.getItem('erp_token')
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const fd = new FormData()
      fd.append('file', new Blob([bytes], { type: 'image/png' }), name)
      const r = await fetch('/erp/api/sale-receipts/upload', {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
      })
      return (await r.json()).id
    }, { b64: PNG_1x1, name: NAME })
    assert.ok(createdId, 'reçu de test créé')
  })

  after(async () => {
    if (page && createdId) {
      await page.evaluate(async (id) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/sale-receipts/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      }, createdId)
    }
    await browser?.close()
  })

  test('cliquer Archiver dans le document renvoie sur /sale-receipts', async () => {
    await page.goto(`${URL}/sale-receipts/${createdId}`, { waitUntil: 'networkidle' })
    const archiveBtn = page.getByTestId('receipt-archive')
    await archiveBtn.waitFor({ state: 'visible', timeout: 10000 })
    assert.match(page.url(), new RegExp(`/sale-receipts/${createdId}$`), 'on est bien dans le document avant archivage')

    await archiveBtn.click()

    // On doit revenir à la liste (sortie du document)
    await page.waitForFunction(() => /\/sale-receipts$/.test(location.pathname), null, { timeout: 8000 })
    assert.match(page.url(), /\/sale-receipts$/, `retour à la liste attendu, vu : ${page.url()}`)

    // Et le reçu est bien archivé en DB
    const archivedAt = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/sale-receipts/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      return (await r.json()).archived_at
    }, createdId)
    assert.ok(archivedAt, 'archived_at doit être renseigné')
  })
})
