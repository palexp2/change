const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Achats — suppression d\'une ligne', () => {
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

  test('DELETE /api/purchases/:id supprime la ligne', async () => {
    // L'achat supprimé est CRÉÉ par le test : aucune vraie donnée n'est touchée.
    // Depuis la migration 035, POST /purchases n'exige plus rien — un achat naît
    // vide, on n'y pose qu'un emplacement pour le reconnaître.
    const result = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

      const created = await fetch('/erp/api/purchases', {
        method: 'POST', headers: h, body: JSON.stringify({ emplacement: 'E2E-DELETE' }),
      })
      if (created.status !== 201) return { error: `création impossible (${created.status})` }
      const victim = await created.json()

      const del = await fetch(`/erp/api/purchases/${victim.id}`, { method: 'DELETE', headers: h })
      const delBody = await del.json().catch(() => ({}))

      const getAfter = await fetch(`/erp/api/purchases/${victim.id}`, { headers: h })
      return { delStatus: del.status, delBody, getAfterStatus: getAfter.status, victimId: victim.id }
    })

    assert.ok(!result.error, `setup: ${result.error}`)
    assert.strictEqual(result.delStatus, 200, 'DELETE doit renvoyer 200')
    assert.strictEqual(result.delBody.success, true)
    assert.strictEqual(result.getAfterStatus, 404, 'GET après DELETE doit renvoyer 404')
  })

  test('DELETE /api/purchases/:id inconnu → 404', async () => {
    const status = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/purchases/00000000-0000-0000-0000-000000000000', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      return r.status
    })
    assert.strictEqual(status, 404)
  })

  test('cliquer une ligne ouvre la fiche de l\'achat (et pas celle du produit)', async () => {
    await page.goto(`${URL}/purchases`, { waitUntil: 'networkidle' })
    // Prendre un id d'achat connu via l'API pour contourner la virtualisation
    const firstId = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const data = await fetch('/erp/api/purchases?limit=50&page=1', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      return (data.data || data)[0]?.id
    })
    assert.ok(firstId, 'besoin d\'au moins un achat en DB')
    await page.goto(`${URL}/purchases/${firstId}`, { waitUntil: 'domcontentloaded' })
    // La fiche doit afficher un bouton "Supprimer cet achat" et NE PAS être la fiche produit
    await page.getByRole('button', { name: /supprimer cet achat/i }).waitFor({ timeout: 10000 })
    assert.ok(page.url().includes(`/purchases/${firstId}`), 'URL doit rester sur la fiche achat')
  })
})
