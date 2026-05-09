const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie le flow de suppression d'une interaction via l'UI :
// - création d'une note via l'API
// - ouverture du panneau détail dans /interactions
// - clic sur "Supprimer" + confirmation
// - vérification : l'interaction disparaît de la liste (deleted_at posé)
//
// Les pills par défaut filtrent (Courriels=email, Appels=call) — on crée donc
// un pill temporaire sans filtre, on l'active via localStorage, et on le purge
// en cleanup pour ne pas polluer les vues utilisateur.
describe('Interactions — suppression via panneau détail', () => {
  let browser, ctx, page, token
  const createdIds = []
  let tempPillId

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

    // Crée un pill temporaire sans filtre + active-le via localStorage
    const pill = await page.evaluate(async (tok) => {
      const r = await fetch('/erp/api/views/interactions/pills', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: '__test_all', filters: [], sort_order: 999 }),
      })
      return r.json()
    }, token)
    tempPillId = pill.id
    await page.evaluate(id => localStorage.setItem('erp_lastView_interactions', id), tempPillId)
  })

  after(async () => {
    // Cleanup hard delete via la route DELETE (idempotent — déjà soft-deleted)
    for (const id of createdIds) {
      await page.evaluate(async ({ tok, id }) => {
        await fetch(`/erp/api/interactions/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } }).catch(() => {})
      }, { tok: token, id }).catch(() => {})
    }
    if (tempPillId) {
      await page.evaluate(async ({ tok, id }) => {
        await fetch(`/erp/api/views/interactions/pills/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } }).catch(() => {})
      }, { tok: token, id: tempPillId }).catch(() => {})
    }
    await browser?.close()
  })

  test('clic Supprimer + confirmation → interaction disparaît de la liste', async () => {
    const tag = `DeleteTest-${Date.now()}`

    const created = await page.evaluate(async ({ tok, title }) => {
      const r = await fetch('/erp/api/interactions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'note', title, notes: 'note de test pour suppression' }),
      })
      return r.json()
    }, { tok: token, title: tag })
    assert.ok(created.id, 'création OK')
    createdIds.push(created.id)

    await page.goto(`${URL}/interactions`, { waitUntil: 'networkidle' })

    const search = page.locator('input[placeholder*="Recherch" i]').first()
    await search.waitFor({ timeout: 10000 })
    await search.fill(tag)

    // La search filtre la liste à la note unique ; clique sur la 1ère ligne
    // de données (la colonne "summary" qui afficherait le tag est masquée par
    // défaut, donc on ne peut pas se baser sur le texte du tag).
    const row = page.locator('.cursor-pointer.hover\\:bg-slate-50').first()
    await row.waitFor({ timeout: 10000 })
    await row.click()

    const deleteBtn = page.locator('button:has-text("Supprimer")').first()
    await deleteBtn.waitFor({ timeout: 5000 })
    await deleteBtn.click()

    const confirmBtn = page.locator('button:has-text("Confirmer")').first()
    await confirmBtn.waitFor({ timeout: 3000 })
    await confirmBtn.click()

    await page.waitForSelector('text=Interaction supprimée', { timeout: 5000 })

    const after = await page.evaluate(async (tok) => {
      const r = await fetch('/erp/api/interactions?limit=all', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    }, token)
    const stillThere = (after.interactions || []).some(i => i.id === created.id)
    assert.ok(!stillThere, 'interaction supprimée ne doit plus apparaître dans la liste')
  })
})
