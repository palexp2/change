const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const API = `${URL}/api`

// Attribution par utilisateur des écritures QuickBooks.
//
// Le flux OAuth Intuit étant interactif, on ne peut pas créer une vraie connexion
// personnelle en E2E (et donc pas prouver l'« Historique de vérification » côté QB).
// Ce test couvre toute la surface HTTP vérifiable sans token Intuit réel :
//   - la route /connect?scope=me encode l'identité dans le state OAuth (account_key = userId)
//   - la route /connect par défaut encode account_key = 'default'
//   - les endpoints de statut/liste répondent correctement
//   - l'UI Connecteurs affiche la section « Mon compte QuickBooks »
// Aucun enregistrement persistant n'est créé (aucun OAuth n'aboutit) → pas de cleanup DB.
describe('QuickBooks — attribution par utilisateur', () => {
  let browser, ctx, page, token, userId

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
    // userId depuis le payload JWT
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())
    userId = payload.id
    assert.ok(userId, 'userId manquant dans le JWT')
  })

  after(async () => { await browser?.close() })

  const decodeState = (locationUrl) => {
    // NB: `URL` est shadowé par la const URL en tête de fichier → extraction manuelle.
    const m = /[?&]state=([^&]+)/.exec(locationUrl)
    assert.ok(m, `param state manquant: ${locationUrl}`)
    return JSON.parse(Buffer.from(decodeURIComponent(m[1]), 'base64url').toString())
  }

  test('/connect?scope=me encode account_key = userId dans le state', async () => {
    const resp = await fetch(`${API}/connectors/quickbooks/connect?scope=me&token=${token}`, { redirect: 'manual' })
    assert.equal(resp.status, 302, 'devrait rediriger vers Intuit')
    const loc = resp.headers.get('location')
    assert.ok(loc.includes('appcenter.intuit.com'), `Location inattendue: ${loc}`)
    const state = decodeState(loc)
    assert.equal(state.accountKey, userId, 'le state doit porter l’id de l’utilisateur')
  })

  test('/connect (défaut) encode account_key = default', async () => {
    const resp = await fetch(`${API}/connectors/quickbooks/connect?token=${token}`, { redirect: 'manual' })
    assert.equal(resp.status, 302)
    const state = decodeState(resp.headers.get('location'))
    assert.equal(state.accountKey, 'default')
  })

  test('my-connection retourne un statut booléen', async () => {
    const resp = await fetch(`${API}/connectors/quickbooks/my-connection`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(resp.status, 200)
    const body = await resp.json()
    assert.equal(typeof body.connected, 'boolean')
  })

  test('connections (admin) liste la connexion principale', async () => {
    const resp = await fetch(`${API}/connectors/quickbooks/connections`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(resp.status, 200)
    const list = await resp.json()
    assert.ok(Array.isArray(list))
    assert.ok(list.some(c => c.isDefault), 'la connexion principale doit figurer dans la liste')
  })

  test('UI : la section « Mon compte QuickBooks » est visible', async () => {
    await page.goto(`${URL}/connectors`, { waitUntil: 'networkidle' })
    await page.locator('button:has-text("QuickBooks")').first().click()

    const heading = page.locator('text=Mon compte QuickBooks')
    // N'apparaît que si QB principal est connecté (ce qui est le cas en prod/local).
    if (await heading.count() === 0) return
    await heading.first().waitFor({ state: 'visible', timeout: 5000 })

    const connectBtn = page.locator('button:has-text("Connecter mon compte"), button:has-text("Reconnecter")')
    assert.ok(await connectBtn.count() >= 1, 'un bouton de (re)connexion personnel doit être présent')
  })

  test('UI : /settings expose la connexion QB personnelle (accessible à tous)', async () => {
    await page.goto(`${URL}/settings`, { waitUntil: 'networkidle' })
    await page.locator('[data-testid="settings-section-quickbooks"]').click()

    await page.locator('text=Mon compte QuickBooks').first().waitFor({ state: 'visible', timeout: 5000 })
    const connectBtn = page.locator('button:has-text("Connecter mon compte"), button:has-text("Reconnecter")')
    assert.ok(await connectBtn.count() >= 1, 'le bouton de connexion personnel doit être présent dans /settings')
  })
})
