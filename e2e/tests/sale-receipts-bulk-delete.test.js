const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// 1x1 PNG transparent — assez pour passer la validation upload sans coût IA notable.
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('Extraction de données — suppression en lot des reçus', () => {
  let browser, ctx, page
  let createdIds = []
  const PREFIX = `__e2e_bulk_receipt_${Date.now()}_`

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Créer 3 reçus jetables via upload (multipart). Les cases de sélection sont
    // visibles par défaut sur cette page (bulkDeleteAlways) — pas de toggle à activer.
    const result = await page.evaluate(async ({ b64, prefix }) => {
      const token = localStorage.getItem('erp_token')
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const created = []
      for (let i = 0; i < 3; i++) {
        const fd = new FormData()
        fd.append('file', new Blob([bytes], { type: 'image/png' }), `${prefix}${i}.png`)
        const r = await fetch('/erp/api/sale-receipts/upload', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        })
        const t = await r.json()
        if (t.id) created.push(t.id)
      }
      return created
    }, { b64: PNG_1x1, prefix: PREFIX })
    createdIds = result
    assert.equal(createdIds.length, 3, 'devrait avoir créé 3 reçus de test')
  })

  after(async () => {
    // Cleanup : supprimer les reçus de test restants.
    if (page) {
      await page.evaluate(async (ids) => {
        const token = localStorage.getItem('erp_token')
        for (const id of ids) {
          await fetch(`/erp/api/sale-receipts/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
        }
      }, createdIds)
    }
    await browser?.close()
  })

  test('checkboxes visibles par défaut sur /sale-receipts (sans toggle)', async () => {
    await page.evaluate(() => localStorage.setItem('erp_lastView_sale_receipts', 'null'))
    await page.goto(`${URL}/sale-receipts`, { waitUntil: 'networkidle' })
    await page.waitForSelector('input[placeholder="Rechercher..."]', { timeout: 10000 })
    const headerCheckbox = page.locator('input[aria-label="Tout sélectionner"]').first()
    await headerCheckbox.waitFor({ state: 'visible', timeout: 5000 })
    const rowCheckbox = page.locator('input[aria-label="Sélectionner la ligne"]').first()
    await rowCheckbox.waitFor({ state: 'visible', timeout: 5000 })
  })

  test('sélection + confirm + suppression des 3 reçus de test', async () => {
    await page.evaluate(() => localStorage.setItem('erp_lastView_sale_receipts', 'null'))
    await page.goto(`${URL}/sale-receipts`, { waitUntil: 'networkidle' })
    await page.waitForSelector('input[placeholder="Rechercher..."]', { timeout: 10000 })

    // Filtrer sur le préfixe de nos reçus de test (recherche sur original_name)
    await page.fill('input[placeholder="Rechercher..."]', PREFIX)
    await page.waitForTimeout(500)

    const counterTxt = await page.locator('text=/\\d+\\s+lignes?/').first().textContent()
    const before = parseInt(counterTxt.match(/(\d+)/)[1], 10)
    assert.equal(before, 3, `attendu 3 lignes de test, got ${before}`)

    // Sélectionner toutes les lignes visibles
    await page.click('input[aria-label="Tout sélectionner"]')

    const bar = page.locator('text=/3 sélectionné/')
    await bar.waitFor({ state: 'visible', timeout: 3000 })

    // Aucune boîte de dialogue native — on utilise une ConfirmModal
    const nativeDialog = []
    page.on('dialog', d => { nativeDialog.push(d.message()); d.dismiss() })

    await page.click('button:has-text("Supprimer")')

    const modal = page.locator('.fixed.inset-0.z-50 .bg-white.rounded-2xl').first()
    await modal.waitFor({ state: 'visible', timeout: 3000 })
    await modal.locator('button:has-text("Confirmer")').click()
    await modal.waitFor({ state: 'hidden', timeout: 3000 })
    assert.equal(nativeDialog.length, 0, `aucun window.confirm attendu — reçu: ${nativeDialog.join(', ')}`)

    // Le compteur doit redescendre à 0
    await page.waitForFunction(() => {
      const m = document.body.innerText.match(/(\d+)\s+lignes?/)
      return m && parseInt(m[1], 10) === 0
    }, { timeout: 5000 })

    // Vérification API : les reçus n'existent plus
    const stillExists = await page.evaluate(async (ids) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/sale-receipts?limit=all', { headers: { Authorization: `Bearer ${token}` } })
      const data = await r.json()
      const list = data.data || data || []
      return ids.filter(id => list.some(t => t.id === id))
    }, createdIds)
    assert.equal(stillExists.length, 0, `tous les reçus de test doivent être supprimés (reste: ${stillExists.length})`)
  })
})
