const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Connecteur UPS : page Connecteurs (identifiants + « Tester la connexion »),
// bouton d'étiquette de retour sur une fiche retour, comparaison de tarifs et
// rafraîchissement de suivi sur une fiche envoi.
//
// IMPORTANT (CLAUDE.md) : la DB de test EST la DB de prod. Ce test est
// STRICTEMENT en lecture — il n'achète aucune étiquette, n'enregistre aucun
// identifiant UPS et ne modifie aucun enregistrement. Il s'appuie sur le fait
// qu'aucune erreur n'est silencieuse : sans identifiants UPS, chaque action
// répond par un message d'erreur explicite, et c'est ce message qu'on vérifie.
describe('Connecteur UPS', () => {
  let browser, ctx, page
  let returnId = null
  let shipmentId = null
  let upsConfiguredAtStart = false

  async function apiCall(method, path, body) {
    return page.evaluate(async ({ base, method, path, body }) => {
      const t = localStorage.getItem('erp_token')
      const r = await fetch(base + path, {
        method,
        headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await r.text()
      try { return { status: r.status, json: JSON.parse(text) } } catch { return { status: r.status, text } }
    }, { base: URL.replace(/\/erp$/, '') + '/api', method, path, body })
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    const st = await apiCall('GET', '/ups/status')
    upsConfiguredAtStart = !!st.json?.configured

    // Enregistrements EXISTANTS, jamais créés ni modifiés par le test.
    const rets = await apiCall('GET', '/projets/retours?limit=1')
    returnId = rets.json?.data?.[0]?.id || null
    const ships = await apiCall('GET', '/shipments?limit=50')
    shipmentId = (ships.json?.data || []).find(s => s.tracking_number)?.id || null
  })

  after(async () => {
    await browser?.close()
  })

  test('le connecteur répond son état sans identifiants enregistrés', async () => {
    const r = await apiCall('GET', '/ups/status')
    assert.equal(r.status, 200)
    assert.equal(typeof r.json.configured, 'boolean')
    assert.ok(['cie', 'production'].includes(r.json.config.environment), 'environnement CIE ou production')
    // Aucun secret ne ressort de l'API : uniquement des booléens « renseigné ».
    assert.equal(r.json.config.client_secret, undefined)
    assert.equal(typeof r.json.config.client_secret_set, 'boolean')
    assert.equal(typeof r.json.config.account_number_set, 'boolean')
  })

  test('la page Connecteurs affiche UPS avec ses trois identifiants', async () => {
    await page.goto(URL + '/connectors', { waitUntil: 'domcontentloaded' })
    const card = page.locator('.card', { has: page.locator('span:text-is("UPS")') }).first()
    await card.waitFor({ state: 'visible', timeout: 20000 })
    await card.locator('span:text-is("UPS")').click()

    await page.waitForSelector('[data-testid="ups-config"]', { timeout: 10000 })
    for (const id of ['ups-client-id', 'ups-client-secret', 'ups-account-number']) {
      assert.ok(await page.locator(`[data-testid="${id}"]`).isVisible(), `${id} visible`)
    }
    // Bascule CIE / production visible (le flag d'environnement est pilotable).
    assert.ok(await page.locator('[data-testid="ups-env-cie"]').isVisible(), 'bascule CIE visible')
    assert.ok(await page.locator('[data-testid="ups-env-production"]').isVisible(), 'bascule production visible')
  })

  test('« Tester la connexion » dit clairement ce qui manque', async () => {
    await page.click('[data-testid="ups-test-connection"]')
    const result = page.locator('[data-testid="ups-test-result"]')
    await result.waitFor({ state: 'visible', timeout: 20000 })
    const text = await result.innerText()
    if (upsConfiguredAtStart) {
      // Identifiants déjà en place : on n'exige pas un verdict précis (le
      // réseau UPS n'est pas garanti), seulement un verdict lisible.
      assert.ok(text.length > 5, 'un verdict est affiché')
    } else {
      assert.match(text, /UPS non configuré/, "l'absence d'identifiants est expliquée, pas avalée")
    }
  })

  test('la fiche retour offre « Créer l\'étiquette de retour UPS » et annonce le sens de l\'expédition', async () => {
    assert.ok(returnId, 'un retour existant est disponible pour la lecture')
    await page.goto(`${URL}/retours/${returnId}`, { waitUntil: 'domcontentloaded' })
    const btn = page.locator('[data-testid="ups-return-label-button"]')
    await btn.waitFor({ state: 'visible', timeout: 20000 })
    assert.match(await btn.innerText(), /Créer l'étiquette de retour UPS/)

    await btn.click()
    // La modale explique que le client expédie et que l'atelier Orisha reçoit.
    const confirm = page.locator('[data-testid="ups-return-confirm"]')
    await confirm.waitFor({ state: 'visible', timeout: 20000 })
    const body = await page.locator('text=Sens de l\'expédition').first().innerText()
    assert.match(body, /Sens de l'expédition/)
    assert.ok(await page.locator('[data-testid="ups-return-weight"]').isVisible(), 'poids saisissable')
    assert.ok(await page.locator('[data-testid="ups-return-service"]').isVisible(), 'service UPS choisissable')
    assert.ok(await page.locator('[data-testid="ups-return-email"]').isVisible(), 'courriel du client saisissable')

    // On referme SANS acheter — aucun achat réel dans un test.
    await page.keyboard.press('Escape')
    await confirm.waitFor({ state: 'detached', timeout: 10000 })
  })

  test('sans identifiants, l\'achat d\'étiquette est refusé avec un message explicite (aucune écriture)', async () => {
    if (upsConfiguredAtStart) return // ne jamais risquer un achat réel
    const before = await apiCall('GET', `/projets/retours/${returnId}`)
    const r = await apiCall('POST', `/ups/returns/${returnId}/return-label`, {
      packages: [{ quantity: '1', weight: '2', length: '20', width: '16', depth: '8' }],
      service_code: '11',
    })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /UPS non configuré/)
    // Le retour est intact : rien n'a été écrit avant le refus.
    const after_ = await apiCall('GET', `/projets/retours/${returnId}`)
    assert.equal(after_.json.return_ups_shipment_id ?? null, before.json.return_ups_shipment_id ?? null)
    assert.equal(after_.json.return_label_tracking_number ?? null, before.json.return_label_tracking_number ?? null)
  })

  test('l\'achat valide le colis côté serveur avant tout appel à UPS', async () => {
    const r = await apiCall('POST', `/ups/returns/${returnId}/return-label`, { packages: [] })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /packages requis/)

    const bad = await apiCall('POST', `/ups/returns/${returnId}/return-label`, {
      packages: [{ quantity: '1', weight: '0', length: '20', width: '16', depth: '8' }],
    })
    assert.equal(bad.status, 400)
    assert.match(bad.json.error, /poids/)
  })

  test('la fiche envoi propose le rafraîchissement du suivi UPS et remonte l\'erreur brute', async () => {
    assert.ok(shipmentId, 'un envoi avec numéro de suivi existe')
    await page.goto(`${URL}/envois/${shipmentId}`, { waitUntil: 'domcontentloaded' })
    const btn = page.locator('[data-testid="ups-refresh-tracking"]')
    await btn.waitFor({ state: 'visible', timeout: 20000 })

    if (upsConfiguredAtStart) return // pas de verdict figé si UPS répond vraiment
    await btn.click()
    // Toast rouge avec le message du serveur — jamais un échec silencieux.
    await page.locator('text=UPS non configuré').first().waitFor({ state: 'visible', timeout: 15000 })
  })

  test('la comparaison de tarifs UPS est refusée proprement sans identifiants', async () => {
    if (upsConfiguredAtStart) return
    const r = await apiCall('POST', `/ups/shipments/${shipmentId}/rates`, {
      packages: [{ quantity: '1', weight: '2', length: '20', width: '16', depth: '8' }],
    })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /UPS non configuré/)

    const empty = await apiCall('POST', `/ups/shipments/${shipmentId}/rates`, {})
    assert.equal(empty.status, 400)
    assert.match(empty.json.error, /packages requis/)
  })
})
