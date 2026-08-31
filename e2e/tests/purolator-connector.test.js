// Connecteur Purolator : page Connecteurs (identifiants + bascule d'env.),
// bouton « Créer étiquette » / tarification Purolator côte à côte avec
// Novoxpress sur une fiche envoi.
//
// IMPORTANT (CLAUDE.md) : la DB de test EST la DB de prod. Ce test est
// STRICTEMENT en lecture — il n'achète aucune étiquette Purolator, n'enregistre
// aucun identifiant et ne modifie aucun enregistrement. Il s'appuie sur le fait
// qu'aucune erreur n'est silencieuse : sans identifiants Purolator, chaque
// action répond par un message d'erreur explicite, et c'est ce message qu'on
// vérifie (même stratégie que ups-connector.test.js).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Connecteur Purolator', () => {
  let browser, ctx, page
  let shipmentId = null
  let purolatorConfiguredAtStart = false

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

    const st = await apiCall('GET', '/purolator/status')
    purolatorConfiguredAtStart = !!st.json?.configured

    // Enregistrement EXISTANT, jamais créé ni modifié par le test.
    const ships = await apiCall('GET', '/shipments?limit=50')
    shipmentId = (ships.json?.data || []).find(s => s.address_id)?.id
      || (ships.json?.data || [])[0]?.id
      || null
  })

  after(async () => {
    await browser?.close()
  })

  test('le connecteur répond son état sans identifiants enregistrés', async () => {
    const r = await apiCall('GET', '/purolator/status')
    assert.equal(r.status, 200)
    assert.equal(typeof r.json.configured, 'boolean')
    assert.ok(['dev', 'production'].includes(r.json.config.environment), 'environnement dev ou production')
    // Aucun secret ne ressort de l'API : uniquement des booléens « renseigné ».
    assert.equal(r.json.config.password, undefined)
    assert.equal(typeof r.json.config.password_set, 'boolean')
    assert.equal(typeof r.json.config.account_number_set, 'boolean')
  })

  test('la page Connecteurs affiche Purolator avec ses trois identifiants', async () => {
    await page.goto(URL + '/connectors', { waitUntil: 'domcontentloaded' })
    const card = page.locator('.card', { has: page.locator('span:text-is("Purolator")') }).first()
    await card.waitFor({ state: 'visible', timeout: 20000 })
    await card.locator('span:text-is("Purolator")').click()

    await page.waitForSelector('[data-testid="purolator-config"]', { timeout: 10000 })
    for (const id of ['purolator-key', 'purolator-password', 'purolator-account-number']) {
      assert.ok(await page.locator(`[data-testid="${id}"]`).isVisible(), `${id} visible`)
    }
    // Bascule dev / production visible (l'environnement est pilotable).
    assert.ok(await page.locator('[data-testid="purolator-env-dev"]').isVisible(), 'bascule dev visible')
    assert.ok(await page.locator('[data-testid="purolator-env-production"]').isVisible(), 'bascule production visible')
  })

  test('la tarification Purolator est refusée proprement sans identifiants (aucun appel réseau réel)', async () => {
    if (purolatorConfiguredAtStart) return // ne jamais risquer un achat réel
    assert.ok(shipmentId, 'un envoi existant est disponible pour la lecture')

    const r = await apiCall('POST', `/purolator/shipments/${shipmentId}/rates`, {
      packages: [{ quantity: '1', weight: '2', length: '20', width: '16', depth: '8' }],
    })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /Purolator non configuré/)

    const empty = await apiCall('POST', `/purolator/shipments/${shipmentId}/rates`, {})
    assert.equal(empty.status, 400)
    assert.match(empty.json.error, /packages requis/)
  })

  test('l\'achat d\'étiquette Purolator valide service_id et packages avant tout appel transporteur', async () => {
    if (purolatorConfiguredAtStart) return
    assert.ok(shipmentId)

    const noService = await apiCall('POST', `/purolator/shipments/${shipmentId}/label`, {
      packages: [{ quantity: '1', weight: '2', length: '20', width: '16', depth: '8' }],
    })
    assert.equal(noService.status, 400)
    assert.match(noService.json.error, /service_id requis/)

    const before = await apiCall('GET', `/shipments/${shipmentId}`)
    const noPackages = await apiCall('POST', `/purolator/shipments/${shipmentId}/label`, { service_id: 'PurolatorExpress' })
    assert.equal(noPackages.status, 400)
    assert.match(noPackages.json.error, /packages requis/)
    // Rien n'a été écrit avant le refus.
    const after_ = await apiCall('GET', `/shipments/${shipmentId}`)
    assert.equal(after_.json.purolator_shipment_id ?? null, before.json.purolator_shipment_id ?? null)
    assert.equal(after_.json.tracking_number ?? null, before.json.tracking_number ?? null)
  })

  test('le rafraîchissement horaire du suivi Purolator est visible et pilotable (page Automations)', async () => {
    // DataTable virtualisé (Automations liste ~50 lignes) : on vérifie via
    // l'API qui l'alimente plutôt que de dépendre du scroll/recherche UI.
    const r = await apiCall('GET', '/automations')
    const list = r.json?.data || r.json || []
    const auto = list.find(a => a.id === 'sys_purolator_tracking')
    assert.ok(auto, "sys_purolator_tracking devrait être seedée et listée")
    assert.equal(typeof auto.active, 'number')
    assert.match(auto.description, /Purolator/)
  })

  test('la fiche envoi propose la création d\'étiquette avec la tarification Purolator côte à côte', async () => {
    assert.ok(shipmentId, 'un envoi existant est disponible pour la lecture')
    await page.goto(`${URL}/envois/${shipmentId}`, { waitUntil: 'domcontentloaded' })
    // Attendre le chargement asynchrone de la fiche (le bouton dépend du
    // statut du connecteur ET des données de l'envoi, chargés après le montage).
    await page.locator('h2:has-text("Informations")').first().waitFor({ state: 'visible', timeout: 15000 })

    const openBtn = page.locator('button', { hasText: /Créer étiquette|Réimprimer/ }).first()
    // Le bouton n'apparaît que si l'envoi a une adresse ET qu'au moins un des
    // deux transporteurs (Novoxpress ou Purolator) est configuré — sur un
    // environnement sans aucun des deux, ce test s'arrête proprement ici.
    const visible = await openBtn.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)
    if (!visible) return

    await openBtn.click()
    await page.locator('text=Créer une étiquette postale').first().waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('text=Type de colis').first().waitFor({ state: 'visible' })

    await page.getByRole('button', { name: /Obtenir les tarifs/ }).click()
    // Que Novoxpress réponde ou échoue, l'étape 'rates' doit s'afficher avec le
    // bloc Purolator disponible à côté (CLAUDE.md : côte à côte).
    const purolatorBtn = page.locator('[data-testid="purolator-get-rates"]')
    await purolatorBtn.waitFor({ state: 'visible', timeout: 15000 })
    assert.match(await purolatorBtn.innerText(), /Tarifer/)

    if (purolatorConfiguredAtStart) return // pas de verdict figé si Purolator répond vraiment

    await purolatorBtn.click()
    const errBox = page.locator('[data-testid="purolator-rate-error"]')
    await errBox.waitFor({ state: 'visible', timeout: 15000 })
    assert.match(await errBox.innerText(), /Purolator non configuré/)

    // Fermer sans rien acheter.
    await page.locator('button:has-text("← Retour")').first().click()
    await page.locator('button:has-text("Annuler")').first().click()
    await page.locator('text=Créer une étiquette postale').first().waitFor({ state: 'hidden', timeout: 5000 })
  })
})
