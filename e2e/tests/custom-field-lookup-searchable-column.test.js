const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Modale « Nouveau champ », mode Lookup : le sélecteur de colonne à récupérer
// est recherchable (SearchableSelect) et affiche les noms de champs tels qu'ils
// apparaissent dans l'UI (label Airtable / tableDefs) plutôt que les noms
// techniques snake_case. On crée un lookup factures → orders en cherchant
// « Date du premier envoi », puis on vérifie la persistance et on nettoie.

describe('CustomFieldModal — colonne de lookup recherchable avec noms UI', () => {
  let browser, ctx, page
  let token, createdId
  const cfName = `E2E Lookup UI ${Date.now()}`

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
  })

  after(async () => {
    // Cleanup même si le test a échoué avant de capturer l'id : retrouve le
    // champ par son nom E2E unique.
    try {
      if (token && !createdId) {
        const resp = await page.request.get(URL + '/api/custom-fields/factures', {
          headers: { Authorization: 'Bearer ' + token },
        })
        const body = await resp.json()
        createdId = (body.data || []).find(f => f.name === cfName)?.id
      }
      if (token && createdId) {
        await page.request.delete(URL + '/api/custom-fields/' + createdId, {
          headers: { Authorization: 'Bearer ' + token },
        })
      }
    } catch {}
    await browser?.close()
  })

  test('rechercher « Date du premier envoi » et créer le lookup', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    const plusBtn = page.locator('button[aria-label="Ajouter un champ"]').first()
    await plusBtn.waitFor({ state: 'visible', timeout: 8000 })
    await plusBtn.click()
    await page.waitForSelector('text=Nouveau champ', { timeout: 5000 })

    // Mode Lookup + nom du champ.
    await page.getByRole('button', { name: 'Lookup' }).click()
    await page.locator('input[placeholder*="Email entreprise"]').fill(cfName)

    // FK order_id → la table cible « Commandes (orders) » est pré-remplie avec
    // son libellé UI.
    await page.getByTestId('cf-lookup-fk').selectOption('order_id')
    await page.getByTestId('cf-lookup-target-table')
      .filter({ hasText: 'Commandes (orders)' })
      .waitFor({ state: 'visible', timeout: 5000 })

    // Colonne à récupérer : recherche par le NOM UI, pas le nom technique.
    await page.getByTestId('cf-lookup-target-column').click()
    const menu = page.getByTestId('cf-lookup-target-column-menu')
    await menu.locator('input').fill('Date du premier envoi')
    const option = menu.locator('button', { hasText: 'Date du premier envoi (date_du_premier_envoi)' })
    await option.first().waitFor({ state: 'visible', timeout: 5000 })
    await option.first().click()

    // Le bouton du sélecteur affiche le libellé UI choisi.
    await page.getByTestId('cf-lookup-target-column')
      .filter({ hasText: 'Date du premier envoi' })
      .waitFor({ state: 'visible', timeout: 3000 })

    // Créer + attendre la réponse du POST (sinon le GET de vérification court-circuite).
    const [createResp] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/custom-fields/factures/lookup') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Créer' }).click(),
    ])
    assert.equal(createResp.status(), 201)

    // Persistance : le champ existe avec la bonne colonne technique.
    const resp = await page.request.get(URL + '/api/custom-fields/factures', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const body = await resp.json()
    // Le GET renvoie { data: [...] } (pagination-ready), pas un tableau nu.
    const created = (body.data || []).find(f => f.name === cfName)
    assert.ok(created, 'le champ lookup doit être créé')
    createdId = created.id
    assert.equal(created.lookup_target_column, 'date_du_premier_envoi')
    assert.equal(created.lookup_target_table, 'orders')
    assert.equal(created.lookup_fk, 'order_id')
  })
})
