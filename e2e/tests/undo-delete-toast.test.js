const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie le pattern undo-toast après suppression d'une tâche :
// - suppression → la tâche disparaît + toast "Annuler" apparaît
// - clic Annuler → la tâche revient + DB est mise à jour (deleted_at = NULL)
// - laisser le toast s'effacer → la tâche reste supprimée
describe('Undo toast — suppression de tâche', () => {
  let browser, ctx, page, token
  const createdTaskIds = []

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
  })

  after(async () => {
    // Purge des tâches résiduelles (peu importe deleted_at) — l'admin trash purge fait le hard delete final.
    for (const id of createdTaskIds) {
      await page.evaluate(async ({ tok, id }) => {
        await fetch(`/erp/api/tasks/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } }).catch(() => {})
      }, { tok: token, id }).catch(() => {})
    }
    await browser?.close()
  })

  test('suppression → toast Annuler → restore via clic', async () => {
    const title = `UndoTest-${Date.now()}`
    // Récupère l'user_id à partir du JWT pour assigner la tâche au user courant (vue par défaut "Mes tâches")
    const userId = await page.evaluate(() => {
      const tok = localStorage.getItem('erp_token')
      return JSON.parse(atob(tok.split('.')[1])).id
    })
    const created = await page.evaluate(async ({ tok, title, userId }) => {
      const r = await fetch('/erp/api/tasks', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, assigned_to: userId }),
      })
      return r.json()
    }, { tok: token, title, userId })
    createdTaskIds.push(created.id)

    await page.goto(`${URL}/tasks`, { waitUntil: 'networkidle' })
    const search = page.locator('input[placeholder*="Recherch" i]').first()
    await search.waitFor({ timeout: 10000 })
    await search.fill(title)
    // DataTable utilise des <div> CSS-grid (pas de <tr>) — on clique directement sur le texte
    const titleCell = page.locator(`text=${title}`).first()
    await titleCell.waitFor({ timeout: 10000 })

    // Ouvre la tâche, supprime
    await titleCell.click()
    await page.waitForSelector('button:has-text("Supprimer cette tâche")', { timeout: 5000 })
    await page.locator('button:has-text("Supprimer cette tâche")').click()

    // Toast Annuler apparaît
    const toast = page.locator('text=Tâche supprimée').first()
    await toast.waitFor({ timeout: 5000 })
    const undoBtn = page.locator('button:has-text("Annuler")').first()
    await undoBtn.waitFor({ timeout: 2000 })

    // DB : deleted_at posé (le GET /:id renvoie 200 mais la liste filtre — vérifions la liste)
    const afterDelete = await page.evaluate(async (tok) => {
      const r = await fetch(`/erp/api/tasks?limit=all`, { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    }, token)
    const stillVisible = (afterDelete.data || []).some(t => t.id === created.id)
    assert.ok(!stillVisible, 'tâche supprimée ne doit plus apparaître dans la liste')

    // Clic Annuler
    await undoBtn.click()

    // Le toast de succès "Restauré" apparaît
    await page.waitForSelector('text=Restauré', { timeout: 3000 })

    // DB : la tâche est restaurée (présente dans la liste à nouveau)
    const afterUndo = await page.evaluate(async (tok) => {
      const r = await fetch(`/erp/api/tasks?limit=all`, { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    }, token)
    const restored = (afterUndo.data || []).find(t => t.id === created.id)
    assert.ok(restored, 'tâche restaurée — apparaît dans la liste')
    assert.equal(restored.title, title)
  })

  test('endpoint POST /undo/:table/:id refuse table non whitelistée', async () => {
    const r = await page.evaluate(async (tok) => {
      const res = await fetch('/erp/api/undo/employees/foo', {
        method: 'POST', headers: { Authorization: `Bearer ${tok}` },
      })
      return { status: res.status, body: await res.json() }
    }, token)
    assert.equal(r.status, 400)
    assert.match(r.body.error, /non supportée/)
  })

  test('endpoint POST /undo/:table/:id 404 si introuvable', async () => {
    const r = await page.evaluate(async (tok) => {
      const res = await fetch('/erp/api/undo/tasks/00000000-aaaa-bbbb-cccc-000000000000', {
        method: 'POST', headers: { Authorization: `Bearer ${tok}` },
      })
      return { status: res.status }
    }, token)
    assert.equal(r.status, 404)
  })
})
