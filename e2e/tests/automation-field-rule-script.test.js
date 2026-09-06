// Field-rule "script" action + numeric operators, end to end.
//
// Couvre :
//   UI  — l'éditeur de règle de champ propose l'opérateur « > » (gt) et, en
//         action « Script », affiche le textarea + la case anti-cycle.
//   E2E — une règle orders.order_number > 1 / action script est réellement
//         déclenchée par le fieldRuleWatcher lorsqu'on crée une commande
//         (change_log → poll → script → automation_rule_fires).
//
// Cleanup (hook after, exécuté même en cas d'échec) :
//   - DELETE de la commande jetable créée
//   - DELETE de la règle créée (cascade automation_rule_fires via FK)
// Aucune configuration utilisateur existante n'est modifiée.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

// fetch helper bound to the browser session token.
function apiFactory(page) {
  return (method, path, body) => page.evaluate(async ({ method, path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api' + path, {
      method,
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let json = null
    try { json = await r.json() } catch { /* no body */ }
    return { status: r.status, body: json }
  }, { method, path, body })
}

describe('Field-rule script action + opérateur numérique', () => {
  let browser, ctx, page, api
  let automationId = null
  let orderId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
    api = apiFactory(page)
  })

  after(async () => {
    // Toujours nettoyer, même si un test a échoué avant le cleanup.
    if (orderId) {
      try { await api('DELETE', `/orders/${orderId}`) } catch { /* best effort */ }
    }
    if (automationId) {
      try { await api('DELETE', `/automations/${automationId}`) } catch { /* best effort */ }
    }
    await browser?.close()
  })

  test('UI — opérateur « > » et éditeur de script présents', async () => {
    await page.goto(`${URL}/automations/new?kind=field_rule`, { waitUntil: 'networkidle' })

    // L'opérateur gt est proposé dans le <select> des opérateurs.
    const opSelect = page.locator('select').filter({ has: page.locator('option[value="gt"]') }).first()
    await opSelect.waitFor({ state: 'visible', timeout: 10000 })
    const gtLabel = await opSelect.locator('option[value="gt"]').innerText()
    assert.match(gtLabel, />/, 'l\'option gt devrait afficher le symbole >')

    // Choisir l'action « Script » → textarea + case anti-cycle visibles.
    await page.locator('button:has-text("Script")').click()
    const scriptArea = page.locator('textarea[placeholder*="row ="]')
    await scriptArea.waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('text=Autoriser l\'écriture d\'une colonne-déclencheur')
      .waitFor({ state: 'visible', timeout: 5000 })
    // On ne clique jamais « Créer » → aucun record en DB depuis ce test UI.
  })

  test('E2E — la règle script est déclenchée par la création d\'une commande', async () => {
    // 1. Créer la règle : orders.order_number > 1 → script (log seulement, aucune écriture).
    const tag = `E2E script ${Date.now()}`
    const created = await api('POST', '/automations', {
      kind: 'field_rule',
      name: tag,
      active: 1,
      trigger_type: 'field_rule',
      trigger_config: JSON.stringify({ erp_table: 'orders', column: 'order_number', op: 'gt', value: 1 }),
      action_type: 'script',
      action_config: JSON.stringify({ script: "log('e2e fired for', row.id)" }),
    })
    assert.equal(created.status, 201, `création règle: ${JSON.stringify(created.body)}`)
    automationId = created.body.id
    assert.ok(automationId, 'la règle devrait avoir un id')

    // 2. Créer une commande jetable (sans company_id → pas de side-effect rachat).
    const ord = await api('POST', '/orders', { notes: tag, items: [] })
    assert.equal(ord.status, 201, `création commande: ${JSON.stringify(ord.body)}`)
    orderId = ord.body.id
    assert.ok(ord.body.order_number > 1, 'la commande devrait avoir un order_number > 1')

    // 3. Attendre que le watcher (poll 5s) déclenche la règle sur cette commande.
    let fired = false
    for (let i = 0; i < 8 && !fired; i++) {
      await page.waitForTimeout(3000)
      const fires = await api('GET', `/automations/${automationId}/fires`)
      if (fires.status === 200 && Array.isArray(fires.body)) {
        fired = fires.body.some(f => f.record_id === orderId && f.record_table === 'orders')
      }
    }
    assert.ok(fired, 'le script aurait dû être déclenché sur la commande créée (automation_rule_fires)')

    // 4. Le log d'exécution confirme que le script a tourné avec succès.
    const logs = await api('GET', `/automations/${automationId}/logs`)
    assert.equal(logs.status, 200, 'logs accessibles')
    assert.ok(
      Array.isArray(logs.body) && logs.body.some(l => l.status === 'success'),
      'au moins un run en succès devrait être journalisé'
    )
  })
})
