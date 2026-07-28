const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vue jetable créée via API (nettoyée en after()). Deux labels : avant/après renommage.
const STAMP = Date.now()
const TEST_VIEW = `Vue CtxMenu E2E ${STAMP}`
const TEST_VIEW_RENAMED = `Vue CtxMenu E2E ${STAMP} renommée`

describe('Clic droit sur un onglet de vue : renommer / verrouiller / supprimer', () => {
  let browser, ctx, page, token, pillId

  async function api(method, path, body) {
    const r = await fetch(`${URL}/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status}`)
    return r.json()
  }

  before(async () => {
    const auth = await fetch(`${URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    }).then(r => r.json())
    token = auth.token
    assert.ok(token, 'login API échoué')

    // Vue jetable en fin de barre — on ne touche à aucune vue existante.
    const pill = await api('POST', '/views/factures/pills', {
      label: TEST_VIEW, color: 'blue', filters: [], sort_order: 99,
    })
    pillId = pill.id

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => {
    // Nettoyage : déverrouiller puis supprimer toute vue jetable restante.
    try {
      const data = await api('GET', '/views/factures')
      const leftovers = (data.pills || []).filter(p => [TEST_VIEW, TEST_VIEW_RENAMED].includes(p.label))
      for (const p of leftovers) {
        if (p.locked) await api('PATCH', `/views/factures/pills/${p.id}/locked`, { locked: false })
        await api('DELETE', `/views/factures/pills/${p.id}`)
      }
    } catch {}
    await browser?.close()
  })

  test('le clic droit sur un onglet ouvre le menu contextuel', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'networkidle' })
    const tab = page.locator(`button:has-text("${TEST_VIEW}")`)
    await tab.waitFor({ state: 'visible', timeout: 10000 })

    await tab.click({ button: 'right' })
    const menu = page.locator('[data-testid="view-context-menu"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })

    assert.ok(await menu.locator('[data-testid="view-menu-rename"]').isVisible(), 'Renommer absent du menu')
    assert.ok(await menu.locator('[data-testid="view-menu-lock"]').isVisible(), 'Verrouiller absent du menu')
    assert.ok(await menu.locator('[data-testid="view-menu-delete"]').isVisible(), 'Supprimer absent du menu')
    assert.equal(await menu.locator('[data-testid="view-menu-lock"]').innerText(), 'Verrouiller')

    // Fermer via clic sur l'overlay
    await page.mouse.click(10, 500)
    await menu.waitFor({ state: 'detached', timeout: 5000 })
  })

  test('renommer via le menu contextuel', async () => {
    const tab = page.locator(`button:has-text("${TEST_VIEW}")`)
    await tab.click({ button: 'right' })
    await page.click('[data-testid="view-menu-rename"]')

    const input = page.locator('[data-testid="view-rename-input"]')
    await input.waitFor({ state: 'visible', timeout: 5000 })
    await input.fill(TEST_VIEW_RENAMED)
    await input.press('Enter')

    // L'onglet se met à jour (rechargement des pills via views:updated)
    await page.locator(`button:has-text("${TEST_VIEW_RENAMED}")`).waitFor({ state: 'visible', timeout: 5000 })

    // Et le serveur a bien persisté le nouveau label
    const data = await api('GET', '/views/factures')
    const pill = data.pills.find(p => p.id === pillId)
    assert.equal(pill?.label, TEST_VIEW_RENAMED, 'label non persisté côté serveur')
  })

  test('verrouiller via le menu : vue en lecture seule, menu réduit à Déverrouiller', async () => {
    const tab = page.locator(`button:has-text("${TEST_VIEW_RENAMED}")`)
    // Activer la vue pour vérifier le badge « Lecture seule » ensuite
    await tab.click()
    await tab.click({ button: 'right' })
    await page.click('[data-testid="view-menu-lock"]')

    // Badge lecture seule + boutons de config désactivés
    await page.locator('span:has-text("Lecture seule")').first().waitFor({ state: 'visible', timeout: 5000 })
    assert.ok(await page.locator('button[data-panel-btn="filter"]').isDisabled(), 'bouton Filtrer non désactivé en vue verrouillée')

    // Serveur : locked=true
    let data = await api('GET', '/views/factures')
    assert.equal(data.pills.find(p => p.id === pillId)?.locked, true, 'locked non persisté')

    // Le menu d'une vue verrouillée ne propose plus que Déverrouiller
    await tab.click({ button: 'right' })
    const menu = page.locator('[data-testid="view-context-menu"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    assert.equal(await menu.locator('[data-testid="view-menu-rename"]').count(), 0, 'Renommer encore visible sur vue verrouillée')
    assert.equal(await menu.locator('[data-testid="view-menu-delete"]').count(), 0, 'Supprimer encore visible sur vue verrouillée')
    assert.equal(await menu.locator('[data-testid="view-menu-lock"]').innerText(), 'Déverrouiller')

    // Déverrouiller pour la suite
    await menu.locator('[data-testid="view-menu-lock"]').click()
    await page.locator('span:has-text("Lecture seule")').waitFor({ state: 'detached', timeout: 5000 })
    data = await api('GET', '/views/factures')
    assert.equal(data.pills.find(p => p.id === pillId)?.locked, false, 'unlock non persisté')
  })

  test('supprimer via le menu contextuel (avec confirmation)', async () => {
    const tab = page.locator(`button:has-text("${TEST_VIEW_RENAMED}")`)
    await tab.click({ button: 'right' })
    await page.click('[data-testid="view-menu-delete"]')
    await page.click('button:has-text("Confirmer")') // ConfirmProvider

    await tab.waitFor({ state: 'detached', timeout: 5000 })

    const data = await api('GET', '/views/factures')
    assert.equal(data.pills.some(p => p.id === pillId), false, 'pill encore présente côté serveur')
  })
})
