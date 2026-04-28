const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Tasks — champ Type', () => {
  let browser, ctx, page, createdId

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

  after(async () => {
    if (createdId) {
      await page.evaluate(async (id) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/tasks/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      }, createdId)
    }
    await browser?.close()
  })

  test('POST /tasks accepte type="Problème" et PUT persiste un changement', async () => {
    const result = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

      // Create with type=Problème
      const created = await fetch('/erp/api/tasks', {
        method: 'POST', headers,
        body: JSON.stringify({ title: `__type_test_${Date.now()}`, type: 'Problème', status: 'À faire' }),
      }).then(r => r.json())

      // Re-GET to confirm persistence
      const fetched = await fetch(`/erp/api/tasks/${created.id}`, { headers }).then(r => r.json())

      // PUT to clear type
      await fetch(`/erp/api/tasks/${created.id}`, {
        method: 'PUT', headers,
        body: JSON.stringify({ ...fetched, type: '' }),
      })
      const afterClear = await fetch(`/erp/api/tasks/${created.id}`, { headers }).then(r => r.json())

      return { createdType: created.type, fetchedType: fetched.type, afterClearType: afterClear.type, id: created.id }
    })
    createdId = result.id
    assert.strictEqual(result.createdType, 'Problème', 'POST doit retourner type=Problème')
    assert.strictEqual(result.fetchedType, 'Problème', 'GET doit retourner type=Problème')
    assert.strictEqual(result.afterClearType, null, 'PUT avec type="" doit persister NULL')
  })

  test('UI : formulaire "Nouvelle tâche" propose le champ Type', async () => {
    await page.goto(`${URL}/tasks`, { waitUntil: 'networkidle' })
    await page.click('button:has-text("Nouvelle tâche")')
    await page.waitForSelector('text=Nouvelle tâche', { timeout: 5000 })
    const typeLabel = page.locator('label:has-text("Type")').first()
    await typeLabel.waitFor({ state: 'visible', timeout: 3000 })
    // Récupérer les options du <select> adjacent
    const options = await page.locator('label:has-text("Type") + select option').allTextContents()
    // Doit contenir l'option vide ("—") et "Problème"
    assert.ok(options.includes('—'), `attendu option vide ("—"), options = ${JSON.stringify(options)}`)
    assert.ok(options.includes('Problème'), `attendu option "Problème", options = ${JSON.stringify(options)}`)
    assert.equal(options.length, 2, `exactement 2 options, got ${options.length}: ${JSON.stringify(options)}`)
    await page.keyboard.press('Escape')
  })

  test('UI : colonne Type disponible dans les paramètres de la table', async () => {
    // Forcer la vue "Toutes les tâches" pour voir la config de colonnes par défaut
    await page.evaluate(() => localStorage.setItem('erp_lastView_tasks', 'null'))
    await page.goto(`${URL}/tasks`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })
    // Ouvrir le panneau "Champs" du ViewToolbar
    await page.click('button:has-text("Champs")')
    await page.waitForTimeout(300)
    // "Type" doit apparaître comme colonne sélectionnable
    const typeRow = page.locator('text=/^Type$/').first()
    await typeRow.waitFor({ state: 'visible', timeout: 3000 })
  })
})
