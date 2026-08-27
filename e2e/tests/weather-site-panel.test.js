const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Panneau « Météo au site » sur TicketDetail et SerialDetail.
//
// Données réelles : GeoMet (api.weather.gc.ca) pour un site canadien, Google
// Places pour le géocodage. Tout est créé sur des enregistrements jetables
// (entreprises + billets créés puis supprimés) — aucun record réel n'est muté.
describe('Météo au site', () => {
  let browser, ctx, page, token
  const created = { companies: [], tickets: [] }

  async function apiCall(method, path, body) {
    return page.evaluate(async ({ tok, m, p, b }) => {
      const r = await fetch(`/erp/api${p}`, {
        method: m,
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: b ? JSON.stringify(b) : undefined,
      })
      return { status: r.status, data: await r.json().catch(() => ({})) }
    }, { tok: token, m: method, p: path, b: body })
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))

    // Entreprise avec adresse réelle (Québec) + entreprise sans adresse.
    const stamp = Date.now()
    for (const spec of [
      { name: `E2E Météo avec adresse ${stamp}`, address: '2325 Rue de l\'Université, Québec, QC G1V 0B3, Canada' },
      { name: `E2E Météo sans adresse ${stamp}` },
    ]) {
      const r = await apiCall('POST', '/companies', spec)
      assert.equal(r.status, 201, `create company: ${JSON.stringify(r.data)}`)
      created.companies.push(r.data.id)
    }

    for (const companyId of created.companies) {
      const r = await apiCall('POST', '/tickets', {
        title: `E2E météo ${stamp}`,
        company_id: companyId,
        status: 'Waiting on us',
      })
      assert.equal(r.status, 201, `create ticket: ${JSON.stringify(r.data)}`)
      created.tickets.push(r.data.id)
    }
  })

  after(async () => {
    if (page && token) {
      for (const id of created.tickets) await apiCall('DELETE', `/tickets/${id}`)
      for (const id of created.companies) await apiCall('DELETE', `/companies/${id}`)
    }
    await browser?.close()
  })

  // Le panneau mémorise son état ouvert/fermé dans localStorage : on le remet à
  // zéro avant chaque navigation pour que les cas soient indépendants.
  async function openTicketPanel(ticketId) {
    await page.addInitScript(() => localStorage.setItem('erp_weather_panel_open', '0'))
    await page.goto(`${URL}/tickets/${ticketId}`, { waitUntil: 'domcontentloaded' })
    const panel = page.locator('[data-testid="weather-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 15000 })
    assert.ok(await panel.locator('text=Météo au site').isVisible(), 'titre du panneau visible')
    // Replié par défaut : aucun corps tant qu'on n'a pas cliqué.
    assert.equal(await page.locator('[data-testid="weather-panel-body"]').count(), 0,
      'le panneau doit être replié par défaut')
    await page.locator('[data-testid="weather-panel-toggle"]').click()
    await page.locator('[data-testid="weather-panel-body"]').waitFor({ state: 'visible', timeout: 10000 })
  }

  test('billet avec adresse : sparkline 72 h, min/max et repère de création', async () => {
    await openTicketPanel(created.tickets[0])

    // L'appel amont (Google Places + GeoMet) peut prendre quelques secondes.
    const spark = page.locator('[data-testid="weather-sparkline"]')
    await spark.waitFor({ state: 'visible', timeout: 45000 })

    const body = page.locator('[data-testid="weather-panel-body"]')
    const txt = await body.innerText()
    assert.match(txt, /Min\s/, `min attendu dans « ${txt} »`)
    assert.match(txt, /Max\s/, `max attendu dans « ${txt} »`)
    assert.match(txt, /Vent max/, 'vent max attendu')
    assert.match(txt, /°C/, 'températures attendues')

    // Le billet vient d'être créé → son repère doit tomber dans la fenêtre.
    assert.equal(await page.locator('[data-testid="weather-marker"]').count(), 1,
      'repère de création du billet attendu sur la courbe')
    assert.match(txt, /Ouverture du billet/, 'libellé du repère attendu')

    // Au moins un segment de courbe tracé.
    const polylines = await spark.locator('polyline').count()
    assert.ok(polylines >= 1, `au moins une polyline attendue, vu ${polylines}`)

    // Le géocodage doit avoir été mis en cache sur l'entreprise.
    const w = await apiCall('GET', `/weather?companyId=${created.companies[0]}`)
    assert.equal(w.status, 200)
    assert.equal(w.data.status, 'ok', `statut météo: ${JSON.stringify(w.data).slice(0, 300)}`)
    assert.ok(Number.isFinite(w.data.coordinates?.lat), 'latitude mise en cache')
    assert.ok(Number.isFinite(w.data.coordinates?.lng), 'longitude mise en cache')
    assert.ok(w.data.observations.length > 0, 'observations non vides')
  })

  test('billet sans adresse : état vide explicite, pas d\'erreur', async () => {
    await openTicketPanel(created.tickets[1])

    const empty = page.locator('[data-testid="weather-empty"]')
    await empty.waitFor({ state: 'visible', timeout: 20000 })
    const txt = await empty.innerText()
    assert.match(txt, /Aucune adresse/i, `état vide attendu, vu « ${txt} »`)
    assert.equal(await page.locator('[data-testid="weather-sparkline"]').count(), 0,
      'aucune courbe sans adresse')

    const w = await apiCall('GET', `/weather?companyId=${created.companies[1]}`)
    assert.equal(w.status, 200, 'pas d\'erreur HTTP pour une adresse manquante')
    assert.equal(w.data.status, 'no_address')
  })

  test('route protégée par requireAuth', async () => {
    const r = await page.evaluate(async (cid) => {
      const res = await fetch(`/erp/api/weather?companyId=${cid}`)
      return res.status
    }, created.companies[0])
    assert.equal(r, 401, 'sans jeton, la route doit répondre 401')
  })

  test('le panneau est présent sur la fiche d\'un numéro de série', async () => {
    // Lecture seule : on ne déplie pas (pas de géocodage d'une vraie entreprise).
    const list = await apiCall('GET', '/serials?limit=1')
    const serial = (list.data?.data || [])[0]
    assert.ok(serial?.id, 'au moins un numéro de série attendu en base')

    await page.addInitScript(() => localStorage.setItem('erp_weather_panel_open', '0'))
    await page.goto(`${URL}/serials/${serial.id}`, { waitUntil: 'domcontentloaded' })
    const toggle = page.locator('[data-testid="weather-panel-toggle"]')
    await toggle.waitFor({ state: 'visible', timeout: 15000 })
    assert.match(await toggle.innerText(), /Météo au site/)
  })
})
