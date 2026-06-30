// Diagnostic Novoxpress en environnement dev (système temporaire) :
//   - POST /api/novoxpress/diagnostic/:shipmentId rejoue le payload contre
//     https://api.novoxpress.ca/dev (gratuit, aucun achat réel) et bissecte
//     par substitution contrôlée pour isoler le champ fautif.
//   - Côté UI, NovoxpressDiagnosticPanel affiche le verdict dans les modales
//     étiquette/ramassage : lien manuel app.novoxpress.ca pour les verdicts
//     « côté Novo », bloc « Copier le prompt pour Claude » quand un champ est
//     isolé. Bouton « Diagnostiquer en dev » pour les erreurs claires (le
//     serveur ne lance le diagnostic auto que sur erreur opaque).
//
// Les volets API appellent le VRAI env dev Novoxpress (aucune facturation, et
// rien n'est créé dans notre DB — seulement une ligne sync_log auto-purgée).
// Les volets UI mockent les routes côté navigateur pour ne pas dépendre de la
// prod Novoxpress.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const VERDICTS = ['novo_prod', 'novo_down', 'carrier_unavailable', 'not_isolated', 'field_isolated']

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

describe('Novoxpress — diagnostic en environnement dev', () => {
  let browser, ctx, page
  let orderId, shipmentId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    const status = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/novoxpress/status', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    })
    if (!status?.configured) throw new Error('Novoxpress non configuré — test skip')
    assert.ok(status.diagnostic_available, 'api_token Novoxpress non configuré (page Connecteurs) — diagnostic indisponible')

    const found = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const list = await fetch('/erp/api/orders?limit=200', { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json())
      for (const o of (list.data || [])) {
        const detail = await fetch(`/erp/api/orders/${o.id}`, { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json())
        const sh = (detail.shipments || []).find(s => s.address_id)
        if (sh) return { orderId: o.id, shipmentId: sh.id }
      }
      return null
    })
    assert.ok(found, 'aucune commande avec un shipment adressé trouvée')
    orderId = found.orderId
    shipmentId = found.shipmentId
  })

  after(async () => {
    await browser?.close()
  })

  // ── Volet API — vrais appels à l'env dev Novoxpress ──

  test('API · op rate — le diagnostic tourne contre le vrai env dev et rend un verdict', async () => {
    const res = await page.evaluate(async ({ shipmentId }) => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/novoxpress/diagnostic/${shipmentId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'rate' }),
      })
      return { status: r.status, body: await r.json() }
    }, { shipmentId })

    // buildRecipient peut refuser localement (courriel/téléphone manquants sur
    // la fiche) — c'est un 400 « validation locale » légitime, pas un échec du
    // système de diagnostic.
    if (res.status === 400 && /Validation locale/.test(res.body?.error || '')) return

    assert.equal(res.status, 200, `diagnostic HTTP ${res.status}: ${JSON.stringify(res.body)}`)
    assert.equal(res.body.available, true)
    assert.ok(VERDICTS.includes(res.body.verdict), `verdict inconnu: ${res.body.verdict}`)
    assert.ok(res.body.attempts.length >= 1, 'au moins une tentative attendue')
    assert.ok(res.body.message, 'message de verdict attendu')
    // Tout verdict « pas notre côté » doit pointer vers la création manuelle.
    if (['novo_prod', 'novo_down', 'not_isolated', 'carrier_unavailable'].includes(res.body.verdict)) {
      assert.match(res.body.manualUrl || '', /app\.novoxpress\.ca/)
    }
    // Un champ isolé doit produire le prompt à donner à Claude.
    if (res.body.verdict === 'field_isolated') {
      assert.ok(res.body.claudePrompt, 'claudePrompt attendu pour field_isolated')
      assert.ok(res.body.faultyField, 'faultyField attendu pour field_isolated')
    }
  })

  test('API · op pickup — chaîne shipment dev jetable + create-pickup dev', async () => {
    // Prochain jour ouvrable
    const d = new Date()
    d.setDate(d.getDate() + 1)
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)

    const res = await page.evaluate(async ({ shipmentId, date }) => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/novoxpress/diagnostic/${shipmentId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'pickup', pickup: { date, quantity: 1, weight: '2' } }),
      })
      return { status: r.status, body: await r.json() }
    }, { shipmentId, date: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() } })

    if (res.status === 400 && /Validation locale/.test(res.body?.error || '')) return

    assert.equal(res.status, 200, `diagnostic HTTP ${res.status}: ${JSON.stringify(res.body)}`)
    assert.equal(res.body.available, true)
    assert.ok(VERDICTS.includes(res.body.verdict), `verdict inconnu: ${res.body.verdict}`)
    assert.ok(res.body.attempts.length >= 1, 'au moins une tentative attendue')
  })

  // ── Volet UI — modale étiquette, routes mockées côté navigateur ──

  const MOCK_DIAGNOSTIC_ISOLATED = {
    available: true,
    op: 'label',
    verdict: 'field_isolated',
    faultyField: 'company_name',
    faultyLabel: "nom d'entreprise (recipient.company_name)",
    faultyValue: { company_name: 'Ferme E2E & Cie' },
    message: 'Champ fautif isolé : nom d\'entreprise. (mock e2e)',
    claudePrompt: 'PROMPT-E2E-MOCK — corrige buildRecipient pour « Ferme E2E & Cie ».',
    attempts: [
      { label: 'T1 · replay du payload réel en dev', outcome: 'fail', error: 'illegal character (mock)', ms: 1200 },
      { label: 'T2 · payload témoin connu-bon (adresse Orisha)', outcome: 'success', error: null, ms: 900 },
      { label: 'T3 · nom d\'entreprise remplacé par la valeur témoin', outcome: 'success', error: null, ms: 1100 },
    ],
  }

  async function installUiMocks({ labelResponse, diagnosticResponse }) {
    await page.route(`**/api/shipments/${shipmentId}`, async route => {
      if (route.request().method() !== 'GET') return route.continue()
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          id: shipmentId, order_id: orderId, order_number: 'TEST',
          company_name: 'Test Co', address_country: 'CA',
          order_items: [{ id: 'x', shipment_id: shipmentId, weight_lbs: 2, qty: 1, product_name: 'X' }],
        }),
      })
    })
    await page.route(`**/api/novoxpress/rates/${shipmentId}`, async route => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          request_id: 'req-test',
          rates: [{ service_id: 'canadapost-292', service_name: 'Expedited Parcel', carrier_name: 'Canada Post', total: { value: '21.33', currency: 'CAD' } }],
        }),
      })
    })
    await page.route(`**/api/novoxpress/label/${shipmentId}`, async route => {
      await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify(labelResponse) })
    })
    if (diagnosticResponse) {
      await page.route(`**/api/novoxpress/diagnostic/${shipmentId}`, async route => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(diagnosticResponse) })
      })
    }
  }

  async function uninstallUiMocks() {
    await page.unroute(`**/api/shipments/${shipmentId}`)
    await page.unroute(`**/api/novoxpress/rates/${shipmentId}`)
    await page.unroute(`**/api/novoxpress/label/${shipmentId}`)
    await page.unroute(`**/api/novoxpress/diagnostic/${shipmentId}`).catch(() => {})
  }

  async function driveModalToFailedPurchase() {
    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Mode expédition/ }).click()
    await page.locator('h2:has-text("Envois de cette commande")').waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('button', { hasText: /Étiquette Novoxpress|Réimprimer/ }).first().click()
    await page.locator('text=Créer une étiquette postale').first().waitFor({ state: 'visible', timeout: 5000 })
    await page.getByRole('button', { name: /Obtenir les tarifs/ }).click()
    await page.locator('text=Expedited Parcel').first().waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('button', { hasText: /Expedited Parcel/ }).first().click()
    await page.locator('text=Récapitulatif').waitFor({ state: 'visible', timeout: 5000 })
    await page.getByRole('button', { name: /Confirmer et acheter/ }).click()
  }

  test('UI · erreur opaque — le panneau de diagnostic auto s\'affiche avec le prompt Claude', async () => {
    await installUiMocks({
      labelResponse: {
        error: 'Novoxpress /shipment/create-shipment (400): {"message":"Request failed with status code 500"}',
        diagnostic: MOCK_DIAGNOSTIC_ISOLATED,
      },
    })
    await driveModalToFailedPurchase()

    await page.locator('text=Champ fautif isolé — correction de notre côté').waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('button:has-text("Copier le prompt pour Claude")').waitFor({ state: 'visible', timeout: 3000 })
    // Le détail des tentatives est repliable et liste T1/T2/T3
    await page.locator('summary:has-text("Détail des 3 tentatives")').click()
    await page.locator('text=T2 · payload témoin connu-bon').waitFor({ state: 'visible', timeout: 3000 })
    // Pas de bouton « Diagnostiquer en dev » quand le diagnostic auto a déjà tourné
    assert.equal(await page.locator('button:has-text("Diagnostiquer en dev")').count(), 0)

    await uninstallUiMocks()
  })

  test('UI · erreur claire — bouton « Diagnostiquer en dev » → verdict côté Novo avec lien manuel', async () => {
    await installUiMocks({
      labelResponse: {
        error: 'Novoxpress /shipment/create-shipment (400): {"message":"Recipient company name can be 30 characters only"}',
        diagnostic: null, // erreur claire → pas de diagnostic auto côté serveur
      },
      diagnosticResponse: {
        available: true,
        op: 'label',
        verdict: 'novo_prod',
        message: 'Le même payload passe sans erreur dans l\'environnement dev Novoxpress. (mock e2e)',
        manualUrl: 'https://app.novoxpress.ca/create-shipment',
        attempts: [{ label: 'T1 · replay du payload réel en dev', outcome: 'success', error: null, ms: 1500 }],
      },
    })
    await driveModalToFailedPurchase()

    const diagBtn = page.locator('button:has-text("Diagnostiquer en dev")')
    await diagBtn.waitFor({ state: 'visible', timeout: 5000 })
    await diagBtn.click()

    await page.locator('text=Vos données sont valides — problème côté Novoxpress').waitFor({ state: 'visible', timeout: 5000 })
    const link = page.locator('a:has-text("Créer l\'envoi à la main sur app.novoxpress.ca")')
    await link.waitFor({ state: 'visible', timeout: 3000 })
    assert.equal(await link.getAttribute('href'), 'https://app.novoxpress.ca/create-shipment')

    await uninstallUiMocks()
  })
})
