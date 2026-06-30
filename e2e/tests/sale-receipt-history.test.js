const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('Fiche reçu — onglet Historique (ajout + modifications)', () => {
  let browser, ctx, page
  let receiptId = null
  const PREFIX = `__e2e_history_${Date.now()}`

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Créer un reçu, puis générer des événements : modification (memo) + archivage.
    receiptId = await page.evaluate(async ({ b64, prefix }) => {
      const token = localStorage.getItem('erp_token')
      const H = { Authorization: `Bearer ${token}` }
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const fd = new FormData()
      fd.append('file', new Blob([bytes], { type: 'image/png' }), `${prefix}.png`)
      const up = await fetch('/erp/api/sale-receipts/upload', { method: 'POST', headers: H, body: fd })
      const id = (await up.json()).id
      // Modification (memo)
      await fetch(`/erp/api/sale-receipts/${id}`, {
        method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ memo: 'note historique e2e' }),
      })
      // Archivage
      await fetch(`/erp/api/sale-receipts/${id}/archive`, { method: 'POST', headers: H })
      return id
    }, { b64: PNG_1x1, prefix: PREFIX })
    assert.ok(receiptId, 'reçu de test créé')
  })

  after(async () => {
    if (page && receiptId) {
      await page.evaluate(async (id) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/sale-receipts/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      }, receiptId)
    }
    await browser?.close()
  })

  test('l\'onglet Historique liste l\'ajout, la modification et l\'archivage avec auteur', async () => {
    await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'networkidle' })

    // Basculer sur l'onglet Historique
    await page.locator('[data-testid="tab-history"]').click()
    await page.locator('[data-testid="history-tab"]').waitFor({ state: 'visible', timeout: 10000 })

    // Bloc « Ajouté par » avec un nom d'utilisateur
    const creator = await page.locator('[data-testid="history-creator"]').textContent()
    assert.ok(creator && creator.trim().length > 0 && creator !== 'Utilisateur inconnu', `créateur attendu, got "${creator}"`)

    // Les trois actions doivent apparaître dans le timeline
    const body = await page.locator('[data-testid="history-tab"]').innerText()
    assert.match(body, /Document ajouté/, 'événement création manquant')
    assert.match(body, /Modifié/, 'événement modification manquant')
    assert.match(body, /Mémo/, 'le détail du champ modifié (Mémo) doit apparaître')
    assert.match(body, /Archivé/, 'événement archivage manquant')

    // Vérif API : 3 événements journalisés (created, updated, archived)
    const actions = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/sale-receipts/${id}/history`, { headers: { Authorization: `Bearer ${token}` } })
      return (await r.json()).data.map(e => e.action)
    }, receiptId)
    assert.ok(actions.includes('created'), 'created')
    assert.ok(actions.includes('updated'), 'updated')
    assert.ok(actions.includes('archived'), 'archived')
  })
})
