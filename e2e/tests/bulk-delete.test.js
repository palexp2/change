const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Suppression en lot — toggle admin + DataTable', () => {
  let browser, ctx, page, createdIds = []

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Créer 3 tâches jetables qu'on pourra supprimer en lot
    const ids = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const created = []
      for (let i = 0; i < 3; i++) {
        const r = await fetch('/erp/api/tasks', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: `__bulk_delete_test_${Date.now()}_${i}`, status: 'À faire' }),
        })
        const t = await r.json()
        if (t.id) created.push(t.id)
      }
      return created
    })
    createdIds = ids
    assert.equal(createdIds.length, 3, 'devrait avoir créé 3 tâches de test')
  })

  after(async () => {
    // Cleanup : supprimer toutes les tâches de test restantes + désactiver le toggle
    if (page) {
      await page.evaluate(async (ids) => {
        const token = localStorage.getItem('erp_token')
        for (const id of ids) {
          await fetch(`/erp/api/tasks/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
        }
        await fetch('/erp/api/views/tasks/bulk-delete-enabled', {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        })
      }, createdIds)
    }
    await browser?.close()
  })

  test('API GET /views/tasks retourne bulk_delete_enabled', async () => {
    const cfg = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/views/tasks', { headers: { Authorization: `Bearer ${token}` } })
      return (await r.json()).config
    })
    assert.ok('bulk_delete_enabled' in cfg, 'config doit exposer bulk_delete_enabled')
    assert.equal(typeof cfg.bulk_delete_enabled, 'boolean')
  })

  test('PATCH /views/tasks/bulk-delete-enabled activate/désactive', async () => {
    const res = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const on = await fetch('/erp/api/views/tasks/bulk-delete-enabled', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      }).then(r => r.json())
      const cfg = await fetch('/erp/api/views/tasks', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      return { on, enabled: cfg.config.bulk_delete_enabled }
    })
    assert.equal(res.on.bulk_delete_enabled, true)
    assert.equal(res.enabled, true, 'le flag doit être persisté en DB')
  })

  test('checkboxes visibles sur /tasks quand toggle ON', async () => {
    // Forcer la vue "Toutes les tâches" pour éviter qu'un pill filtre les lignes
    await page.evaluate(() => localStorage.setItem('erp_lastView_tasks', 'null'))
    await page.goto(`${URL}/tasks`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })
    const headerCheckbox = page.locator('input[aria-label="Tout sélectionner"]').first()
    await headerCheckbox.waitFor({ state: 'visible', timeout: 5000 })
    const rowCheckbox = page.locator('input[aria-label="Sélectionner la ligne"]').first()
    await rowCheckbox.waitFor({ state: 'visible', timeout: 5000 })
  })

  test('suppression en lot : sélection + confirm + réduction du compteur', async () => {
    await page.evaluate(() => localStorage.setItem('erp_lastView_tasks', 'null'))
    await page.goto(`${URL}/tasks`, { waitUntil: 'networkidle' })
    await page.waitForSelector('input[placeholder="Rechercher..."]', { timeout: 10000 })

    // Filtrer par le préfixe de nos tâches de test
    await page.fill('input[placeholder="Rechercher..."]', '__bulk_delete_test_')
    await page.waitForTimeout(400)

    // On doit voir exactement 3 lignes
    const counterTxt = await page.locator('text=/\\d+\\s+lignes?/').first().textContent()
    const before = parseInt(counterTxt.match(/(\d+)/)[1], 10)
    assert.equal(before, 3, `attendu 3 lignes de test, got ${before}`)

    // Sélectionner toutes les lignes visibles via le header
    await page.click('input[aria-label="Tout sélectionner"]')

    // La barre d'action doit apparaître avec "3 sélectionnés"
    const bar = page.locator('text=/3 sélectionné/')
    await bar.waitFor({ state: 'visible', timeout: 3000 })

    // Aucune boîte de dialogue native ne doit s'ouvrir — on utilise maintenant une ConfirmModal
    const nativeDialog = []
    page.on('dialog', d => { nativeDialog.push(d.message()); d.dismiss() })

    // Cliquer le bouton Supprimer
    await page.click('button:has-text("Supprimer")')

    // La ConfirmModal doit apparaître — cliquer "Confirmer" pour valider
    const modal = page.locator('.fixed.inset-0.z-50 .bg-white.rounded-2xl').first()
    await modal.waitFor({ state: 'visible', timeout: 3000 })
    await modal.locator('button:has-text("Confirmer")').click()
    await modal.waitFor({ state: 'hidden', timeout: 3000 })
    assert.equal(nativeDialog.length, 0, `aucun window.confirm attendu — reçu: ${nativeDialog.join(', ')}`)

    // Attendre que le compteur descende à 0
    await page.waitForFunction(() => {
      const m = document.body.innerText.match(/(\d+)\s+lignes?/)
      return m && parseInt(m[1], 10) === 0
    }, { timeout: 5000 })

    // Confirmer côté API que les tâches sont bien supprimées
    const stillExists = await page.evaluate(async (ids) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/tasks?limit=all', { headers: { Authorization: `Bearer ${token}` } })
      const data = await r.json()
      const list = data.data || []
      return ids.filter(id => list.some(t => t.id === id))
    }, createdIds)
    assert.equal(stillExists.length, 0, `toutes les tâches de test doivent être supprimées (reste: ${stillExists.length})`)
  })
})
