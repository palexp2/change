const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

// Vérifie l'infra champs custom formule + lookup sur la page Factures.
// 1. Le champ formule "Mois du document" (cf_mois_du_document, expr
//    substr(document_date, 1, 7)) est exposé par l'API et calculé pour toutes
//    les factures, y compris les 131 historiquement vides.
// 2. La création d'un lookup via l'API régénère factures_v et la valeur
//    apparaît dans le payload du list endpoint.
describe('Factures — champs custom (formule + lookup via VUE)', () => {
  let browser, ctx, page, token

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Récupère le token JWT depuis le localStorage pour appels API directs
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
    assert.ok(token, 'Token JWT introuvable après login')
  })

  after(async () => { await browser?.close() })

  test('GET /api/projets/factures retourne cf_mois_du_document calculé', async () => {
    const res = await page.request.get(URL + '/api/projets/factures?limit=20', {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status(), 200)
    const body = await res.json()
    assert.ok(Array.isArray(body.data), 'data doit être un tableau')
    assert.ok(body.data.length > 0, 'au moins une facture attendue')

    // Toutes les factures avec document_date doivent avoir cf_mois_du_document = YYYY-MM
    const sourcesStripe = body.data.filter(f => f.source === 'stripe' && f.document_date)
    assert.ok(sourcesStripe.length > 0, 'au moins une facture stripe avec document_date')
    for (const f of sourcesStripe) {
      assert.equal(
        f.cf_mois_du_document,
        f.document_date.slice(0, 7),
        `cf_mois_du_document=${f.cf_mois_du_document} doit valoir substr(document_date, 1, 7) pour ${f.id}`,
      )
    }
  })

  test('GET /api/custom-fields/factures liste cf_mois_du_document comme formule', async () => {
    const res = await page.request.get(URL + '/api/custom-fields/factures', {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status(), 200)
    const body = await res.json()
    const mois = body.data.find(f => f.column_name === 'cf_mois_du_document')
    assert.ok(mois, 'cf_mois_du_document doit être listé')
    assert.equal(mois.kind, 'formula')
    assert.equal(mois.formula_expr, 'substr(document_date, 1, 7)')
    assert.equal(mois.result_type, 'text')
  })

  test('création d\'un lookup company.name régénère factures_v', async () => {
    // Création
    const createRes = await page.request.post(URL + '/api/custom-fields/factures/lookup', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {
        name: 'Test entreprise (E2E)',
        lookup_fk: 'company_id',
        lookup_target_table: 'companies',
        lookup_target_column: 'name',
        result_type: 'text',
      },
    })
    assert.equal(createRes.status(), 201, `create lookup: ${createRes.status()} ${await createRes.text()}`)
    const created = await createRes.json()
    assert.equal(created.kind, 'lookup')
    assert.equal(created.column_name, 'cf_test_entreprise_e2e')

    try {
      // Le list endpoint expose maintenant le lookup
      const listRes = await page.request.get(URL + '/api/projets/factures?limit=5', {
        headers: { Authorization: `Bearer ${token}` },
      })
      assert.equal(listRes.status(), 200)
      const body = await listRes.json()
      const stripeFactures = body.data.filter(f => f.source === 'stripe' && f.company_name)
      assert.ok(stripeFactures.length > 0, 'au moins une facture stripe avec company_name')
      // Le lookup doit retourner la même valeur que company_name (qui vient du JOIN
      // direct sur la requête, alors que cf_test_entreprise_e2e vient de la VUE).
      for (const f of stripeFactures) {
        assert.equal(
          f.cf_test_entreprise_e2e,
          f.company_name,
          `lookup cf_test_entreprise_e2e doit égaler company_name pour ${f.id}`,
        )
      }
    } finally {
      // Cleanup : supprime le lookup test pour ne pas polluer
      await page.request.delete(URL + `/api/custom-fields/${created.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    }
  })

  test('expression formule avec mot-clé interdit est rejetée', async () => {
    const res = await page.request.post(URL + '/api/custom-fields/factures/formula', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {
        name: 'Test injection',
        formula_expr: '(SELECT password_hash FROM users LIMIT 1)',
        result_type: 'text',
      },
    })
    assert.equal(res.status(), 400, 'doit refuser SELECT')
    const body = await res.json()
    assert.ok(/interdit/i.test(body.error), `message d'erreur attendu, reçu: ${body.error}`)
  })

  test('lookup vers table non-whitelistée est rejeté', async () => {
    const res = await page.request.post(URL + '/api/custom-fields/factures/lookup', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {
        name: 'Test users lookup',
        lookup_fk: 'company_id',
        lookup_target_table: 'users',
        lookup_target_column: 'password_hash',
        result_type: 'text',
      },
    })
    assert.equal(res.status(), 400, 'doit refuser users en cible de lookup')
  })
})
