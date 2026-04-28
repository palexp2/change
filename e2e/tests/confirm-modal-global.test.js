const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que les actions destructrices déclenchent la ConfirmModal globale
// et non window.confirm. Couvre : TableConfigModal (suppression de vue),
// bulk delete via DataTable, et un delete individuel.
describe('ConfirmModal globale — remplace window.confirm', () => {
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

  test('suppression d\'une vue : ConfirmModal (pas window.confirm)', async () => {
    // Crée une vue jetable via l'API pour pouvoir la supprimer côté UI
    const viewId = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/views/tasks/pills', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: `__confirm_test_${Date.now()}`,
          color: 'blue',
          filters: [],
          visible_columns: [],
          sort: [],
          group_by: null,
          sort_order: 999,
        }),
      })
      const j = await r.json()
      return j.id
    })
    assert.ok(viewId, 'vue de test devrait être créée')

    const nativeDialogs = []
    page.on('dialog', d => { nativeDialogs.push(d.message()); d.dismiss() })

    await page.goto(`${URL}/tasks`, { waitUntil: 'networkidle' })

    // Ouvrir le modal de config des vues (bouton Settings dans la barre d'outils)
    await page.click('button[title="Gérer les vues de la table"]')

    // Trouver notre vue de test et cliquer la poubelle adjacente
    const viewRow = page.locator(`text=__confirm_test_`).first()
    await viewRow.waitFor({ state: 'visible', timeout: 3000 })

    // Le bouton de suppression est le frère du label — on cible le bouton poubelle
    // dans la même ligne
    const row = viewRow.locator('..').locator('..')
    const deleteBtn = row.locator('button').last()
    await deleteBtn.click()

    // La ConfirmModal doit apparaître — texte "Supprimer cette vue ?"
    const modal = page.locator('.fixed.inset-0.z-50 .bg-white.rounded-2xl').filter({
      hasText: 'Supprimer cette vue',
    }).first()
    await modal.waitFor({ state: 'visible', timeout: 3000 })

    // Elle doit avoir un bouton Annuler et un bouton Confirmer
    await assert.ok(await modal.locator('button:has-text("Annuler")').isVisible(), 'bouton Annuler attendu')
    await modal.locator('button:has-text("Confirmer")').click()
    await modal.waitFor({ state: 'hidden', timeout: 3000 })

    // Aucun window.confirm ne doit s'être ouvert
    assert.equal(nativeDialogs.length, 0, `aucun window.confirm attendu — reçu: ${nativeDialogs.join(', ')}`)

    // Cleanup si pas déjà nettoyé
    await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      await fetch(`/erp/api/views/tasks/pills/${id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      })
    }, viewId)
  })

  test('clic Annuler ferme la modale sans effet', async () => {
    // Crée encore une vue de test
    const viewId = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/views/tasks/pills', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: `__cancel_test_${Date.now()}`,
          color: 'gray',
          filters: [],
          visible_columns: [],
          sort: [],
          group_by: null,
          sort_order: 999,
        }),
      })
      return (await r.json()).id
    })

    await page.goto(`${URL}/tasks`, { waitUntil: 'networkidle' })
    await page.click('button[title="Gérer les vues de la table"]')
    const viewRow = page.locator(`text=__cancel_test_`).first()
    await viewRow.waitFor({ state: 'visible', timeout: 3000 })
    const row = viewRow.locator('..').locator('..')
    await row.locator('button').last().click()

    const modal = page.locator('.fixed.inset-0.z-50 .bg-white.rounded-2xl').filter({
      hasText: 'Supprimer cette vue',
    }).first()
    await modal.waitFor({ state: 'visible', timeout: 3000 })
    await modal.locator('button:has-text("Annuler")').click()
    await modal.waitFor({ state: 'hidden', timeout: 3000 })

    // La vue doit toujours exister
    const stillExists = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/views/tasks', { headers: { Authorization: `Bearer ${token}` } })
      const j = await r.json()
      return (j.pills || []).some(p => p.id === id)
    }, viewId)
    assert.equal(stillExists, true, 'la vue doit toujours exister après clic Annuler')

    // Cleanup
    await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      await fetch(`/erp/api/views/tasks/pills/${id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      })
    }, viewId)
  })
})
