// Webhook automations (kind='webhook') — builder UI + moteur entrant, bout en bout.
//
// Couvre :
//   UI  — la page « Nouveau webhook » affiche le builder (modes Déclaratif/Script,
//         ajout d'étape, section notification d'échec) et, à la création, génère
//         et affiche l'URL publique /api/hooks/hook…
//   E2E — un webhook déclaratif (update tickets WHERE title=param → set description)
//         est réellement déclenché par un appel HTTP PUBLIC (sans token d'auth) sur
//         /api/hooks/:token : le ticket est mis à jour, la réponse est templatée,
//         le 0-match renvoie 500, et les deux runs sont journalisés (success+error).
//
// Cleanup (hook after, exécuté même en cas d'échec) :
//   - DELETE du ticket jetable (créé sans airtable_id → aucun write-back Airtable)
//   - DELETE des automations créées (UI + API)
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

// Appel PUBLIC du webhook : surtout PAS de header Authorization (le token EST le secret).
function publicHit(page) {
  return (path) => page.evaluate(async (p) => {
    const r = await fetch('/erp/api' + p, { method: 'GET' })
    let json = null
    try { json = await r.json() } catch { /* no body */ }
    return { status: r.status, body: json }
  }, path)
}

describe('Webhook automations — builder + moteur entrant', () => {
  let browser, ctx, page, api, hit
  let uiAutomationId = null
  let apiAutomationId = null
  let ticketId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
    api = apiFactory(page)
    hit = publicHit(page)
  })

  after(async () => {
    if (ticketId) { try { await api('DELETE', `/tickets/${ticketId}`) } catch { /* best effort */ } }
    if (uiAutomationId) { try { await api('DELETE', `/automations/${uiAutomationId}`) } catch { /* best effort */ } }
    if (apiAutomationId) { try { await api('DELETE', `/automations/${apiAutomationId}`) } catch { /* best effort */ } }
    await browser?.close()
  })

  test('UI — builder webhook + génération de l\'URL à la création', async () => {
    await page.goto(`${URL}/automations/new?kind=webhook`, { waitUntil: 'networkidle' })

    // Le builder est présent : modes, placeholder d'URL, ajout d'étape, notification d'échec.
    await page.locator('button:has-text("Déclaratif")').waitFor({ state: 'visible', timeout: 10000 })
    await page.locator('button:has-text("Script")').first().waitFor({ state: 'visible' })
    await page.locator('text=L\'URL sera générée à la création').waitFor({ state: 'visible' })
    await page.locator('text=Notification d\'échec').waitFor({ state: 'visible' })
    await page.locator('button:has-text("Ajouter une étape")').waitFor({ state: 'visible' })

    // Créer le webhook (config déclarative vide = valide) → navigation + URL générée.
    const tag = `E2E Webhook ${Date.now()}`
    await page.fill('input[placeholder="Mon automation"]', tag)
    await page.locator('button:has-text("Créer")').click()
    await page.waitForURL(u => /\/automations\/aut_/.test(u.toString()), { timeout: 15000 })
    uiAutomationId = page.url().match(/automations\/(aut_[a-z0-9]+)/)?.[1]
    assert.ok(uiAutomationId, 'un id d\'automation devrait apparaître dans l\'URL après création')

    // L'URL publique du webhook s'affiche et pointe sur /api/hooks/hook…
    const urlField = page.locator('[data-testid="webhook-url"]')
    await urlField.waitFor({ state: 'visible', timeout: 8000 })
    const val = await urlField.inputValue()
    assert.match(val, /\/api\/hooks\/hook/, `l'URL devrait contenir /api/hooks/hook… (reçu: ${val})`)

    // Le builder d'étapes fonctionne : ajouter une étape fait apparaître la carte + le select de type.
    await page.locator('button:has-text("Ajouter une étape")').click()
    await page.locator('text=Étape 1').waitFor({ state: 'visible', timeout: 5000 })
    const typeSelect = page.locator('select').filter({ has: page.locator('option[value="upsert"]') }).first()
    await typeSelect.waitFor({ state: 'visible', timeout: 5000 })
  })

  test('E2E — appel HTTP public déclenche update + réponse templatée + échec 0-match', async () => {
    const ts = Date.now()
    const title = `E2E-HOOK-${ts}`

    // 1. Ticket jetable (sans airtable_id → aucun write-back Airtable).
    const tk = await api('POST', '/tickets', { title, description: 'orig' })
    assert.equal(tk.status, 201, `création ticket: ${JSON.stringify(tk.body)}`)
    ticketId = tk.body.id

    // 2. Webhook déclaratif : update tickets WHERE title=param('title') → description=param('note').
    const action_config = {
      mode: 'declarative',
      steps: [{
        type: 'update', table: 'tickets',
        match: { field: 'title', param: 'title' },
        fields: [{ column: 'description', source: 'param', value: 'note' }],
      }],
      response_rules: [],
      default_response: { status: 200, body: { ok: true, updated: '{{steps.0.record.description}}' } },
    }
    const created = await api('POST', '/automations', {
      kind: 'webhook', name: `E2E hook api ${ts}`, active: 1,
      action_config: JSON.stringify(action_config),
    })
    assert.equal(created.status, 201, `création webhook: ${JSON.stringify(created.body)}`)
    apiAutomationId = created.body.id
    const token = created.body.webhook_token
    assert.match(token || '', /^hook/, 'un token compact « hook… » devrait être généré')

    // 3. Appel PUBLIC (aucun auth) → 200 + réponse templatée avec la valeur écrite.
    const ok = await hit(`/hooks/${token}?title=${encodeURIComponent(title)}&note=CHANGED`)
    assert.equal(ok.status, 200, `appel public: ${JSON.stringify(ok.body)}`)
    assert.equal(ok.body.updated, 'CHANGED', 'la réponse par défaut devrait templater {{steps.0.record.description}}')

    // 4. Le ticket a bien été mis à jour en DB.
    const after = await api('GET', `/tickets/${ticketId}`)
    assert.equal(after.body.description, 'CHANGED', 'la description du ticket devrait être mise à jour par le webhook')

    // 5. 0-match → 500 (échec) sur un titre inexistant.
    const fail = await hit(`/hooks/${token}?title=NOPE-${ts}&note=x`)
    assert.equal(fail.status, 500, 'un update sans correspondance devrait renvoyer 500')

    // 6. Les deux runs sont journalisés (success + error) dans automation_logs.
    const logs = await api('GET', `/automations/${apiAutomationId}/logs`)
    assert.equal(logs.status, 200, 'logs accessibles')
    assert.ok(logs.body.some(l => l.status === 'success'), 'un run en succès devrait être journalisé')
    assert.ok(logs.body.some(l => l.status === 'error'), 'le 0-match devrait être journalisé en erreur')
  })
})
