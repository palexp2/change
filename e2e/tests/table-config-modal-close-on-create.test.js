// Vérifie que la modale "Vues" se ferme automatiquement après la création
// d'une nouvelle vue, puis nettoie la vue créée pour ne pas polluer le compte.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('TableConfigModal — fermeture après création de vue', () => {
  let browser, ctx, page
  let createdViewId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    // Cleanup : supprimer la vue créée si elle existe encore
    if (createdViewId) {
      try {
        await page.evaluate(async ({ id }) => {
          const tok = localStorage.getItem('erp_token')
          await fetch(`/erp/api/views/factures/pills/${id}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${tok}` },
          })
        }, { id: createdViewId })
      } catch {}
    }
    await browser?.close()
  })

  test('création d\'une vue ferme la modale', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'networkidle' })

    // Ouvre la modale de gestion des vues (icône Settings)
    await page.locator('button[title="Gérer les vues de la table"]').click()
    await page.waitForSelector('text=/^Vues —/', { timeout: 5000 })

    // Clique "Nouvelle vue", saisit un nom et clique "Créer"
    const viewName = `__test_close_${Date.now()}`
    await page.click('button:has-text("Nouvelle vue")')
    await page.fill('input[placeholder="Nom de la vue..."]', viewName)
    await page.click('button:has-text("Créer")')

    // La modale doit se fermer (titre "Vues —" disparaît)
    await page.waitForSelector('text=/^Vues —/', { state: 'detached', timeout: 5000 })

    // Récupère l'ID de la vue créée pour cleanup
    const pills = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/views/factures', { headers: { Authorization: `Bearer ${tok}` } })
      const data = await r.json()
      return data.pills || []
    })
    const created = pills.find(p => p.label === viewName)
    assert.ok(created, `vue "${viewName}" non trouvée après création`)
    createdViewId = created.id
  })
})
