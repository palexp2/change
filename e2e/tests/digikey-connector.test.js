const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Connecteur DigiKey — OAuth2 « client credentials », rapatriement des commandes
// et de leurs factures PDF vers des achats fournisseurs en brouillon.
//
// IMPORTANT (CLAUDE.md) : la DB de test EST la DB de prod. Ce test ne crée aucun
// enregistrement métier — il n'écrit que la configuration du connecteur DigiKey,
// dont l'état initial est relevé dans before() et remis dans after(). La tournée
// déclenchée vise volontairement une adresse injoignable (https://localhost:1) :
// elle échoue avant tout appel vers DigiKey et avant toute écriture, ce qui
// vérifie le journal de sync sans rien créer.
describe('Connecteur DigiKey', () => {
  let browser, ctx, page
  let initialConfig = null
  let initialConfigured = false

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

  // L'ERP local peut mettre plusieurs secondes à répondre (bootstrap, syncs
  // Airtable en cours) : toute lecture d'état passe par une attente active.
  async function waitForStatus(predicate, label, tries = 30) {
    let last = null
    for (let i = 0; i < tries; i++) {
      const st = await apiCall('GET', '/digikey/status')
      last = st.json
      if (last && predicate(last)) return last
      await page.waitForTimeout(1000)
    }
    assert.fail(`${label} — dernier état : ${JSON.stringify(last).slice(0, 300)}`)
  }

  // Ouvre la carte DigiKey de /connectors, dépliée et hydratée par le serveur.
  async function openDigikeyCard() {
    await page.goto(URL + '/connectors', { waitUntil: 'domcontentloaded' })
    const card = page.locator('.card', { has: page.getByText('DigiKey', { exact: true }) }).first()
    await card.waitFor({ timeout: 30000 })
    if (!(await card.getByTestId('digikey-save-credentials').isVisible().catch(() => false))) {
      await card.getByRole('button', { name: /DigiKey/ }).first().click()
    }
    await card.getByTestId('digikey-save-credentials').waitFor({ timeout: 30000 })
    // Le panneau lit son état au montage : on attend que l'API ait répondu,
    // sinon les champs sont encore vides et les assertions lisent du vide.
    await card.getByPlaceholder(/Site \(CA\)/).and(page.locator('input:not([value=""])'))
      .first().waitFor({ timeout: 30000 }).catch(() => {})
    for (let i = 0; i < 30; i++) {
      if (await card.getByPlaceholder(/Site \(CA\)/).inputValue()) break
      await page.waitForTimeout(1000)
    }
    return card
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 30000 })

    const st = await apiCall('GET', '/digikey/status')
    assert.equal(st.status, 200, 'GET /digikey/status répond')
    initialConfig = st.json?.config || null
    initialConfigured = !!st.json?.configured
  })

  after(async () => {
    if (page) {
      // On efface la configuration posée par le test puis on remet les réglages
      // non secrets d'origine. Le secret n'est jamais relu par l'API, donc jamais
      // réécrit — before() a vérifié l'état de départ et le rapport le signale.
      await apiCall('DELETE', '/digikey/config')
      if (initialConfig) {
        const restore = { ...initialConfig }
        delete restore.client_secret_set
        if (!initialConfigured) delete restore.client_id
        await apiCall('PUT', '/digikey/config', restore)
      }
    }
    if (browser) await browser.close()
  })

  test('la carte DigiKey apparaît dans Connecteurs et se déplie', async () => {
    const card = await openDigikeyCard()
    await card.getByPlaceholder(/Client ID/).waitFor({ timeout: 10000 })
    await card.getByPlaceholder(/Client Secret/).waitFor({ timeout: 10000 })
    assert.equal(
      await card.getByPlaceholder(/Site \(CA\)/).inputValue(), 'CA',
      'le site par défaut du connecteur est chargé depuis le serveur'
    )
  })

  test('enregistrer les identifiants OAuth marque le connecteur comme connecté', async () => {
    const card = await openDigikeyCard()
    await card.getByPlaceholder(/Client ID/).fill('E2E-CLIENT-ID')
    await card.getByPlaceholder(/Client Secret/).fill('E2E-CLIENT-SECRET')
    await card.getByTestId('digikey-save-credentials').click()

    const st = await waitForStatus(s => s.configured === true, 'le connecteur devient configuré')
    assert.equal(st.config.client_id, 'E2E-CLIENT-ID')
    assert.equal(st.config.client_secret_set, true, 'le secret est enregistré')
    assert.ok(!('client_secret' in st.config), 'le secret ne ressort jamais de l\'API')

    // L'UI reflète l'état sans rechargement de page.
    await card.getByText('Application configurée', { exact: true }).waitFor({ timeout: 20000 })
    await card.getByRole('button', { name: 'Importer les commandes' }).waitFor({ timeout: 20000 })
  })

  test('les réglages non secrets se sauvegardent tout seuls (autosave au blur)', async () => {
    const card = await openDigikeyCard()
    const site = card.getByPlaceholder(/Site \(CA\)/)
    await site.fill('US')
    await site.blur()

    await waitForStatus(s => s.config?.locale_site === 'US', 'le site est enregistré sans bouton')

    // Rechargement complet : la valeur tient, sans « Enregistrer ».
    const again = await openDigikeyCard()
    assert.equal(await again.getByPlaceholder(/Site \(CA\)/).inputValue(), 'US')

    const back = again.getByPlaceholder(/Site \(CA\)/)
    await back.fill('CA')
    await back.blur()
    await waitForStatus(s => s.config?.locale_site === 'CA', 'le site revient à CA')
  })

  test('une tournée en échec est journalisée sous le module digikey', async () => {
    // Adresse injoignable : la tournée échoue avant tout appel à DigiKey et
    // avant toute écriture (aucun achat, aucune commande créée).
    const saved = await apiCall('PUT', '/digikey/config', { api_base: 'https://localhost:1' })
    assert.equal(saved.status, 200, 'adresse d\'API acceptée')

    const before = await apiCall('GET', '/digikey/status')
    const beforeAt = before.json?.last_sync?.created_at || null

    const card = await openDigikeyCard()
    await card.getByRole('button', { name: 'Importer les commandes' }).click()

    const st = await waitForStatus(
      s => s.last_sync && s.last_sync.created_at !== beforeAt,
      'une ligne de journal est écrite pour le module digikey'
    )
    assert.equal(st.last_sync.status, 'error', 'la tournée est journalisée en erreur')
    assert.ok(st.last_sync.error_message, 'le message d\'erreur est conservé')

    // Aucune commande n'a été enregistrée par cette tournée en échec.
    const orders = await apiCall('GET', '/digikey/orders')
    assert.equal(orders.status, 200)
    assert.equal((orders.json.data || []).length, 0, 'aucune commande DigiKey enregistrée')
  })
})
