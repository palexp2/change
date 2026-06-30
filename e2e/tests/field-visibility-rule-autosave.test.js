const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Facture d'abonnement (subscription_id populé) — réutilisée par les autres
// tests de field-visibility ; le placeholder masqué de is_sent y est visible.
const SUBSCRIPTION_FACTURE_ID = '60c4e062-c349-43e7-8309-5b49bf9bce2f'

async function api(token, method, path, body) {
  const res = await fetch(URL + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined,
  })
  const txt = await res.text()
  let json
  try { json = JSON.parse(txt) } catch { json = txt }
  return { status: res.status, body: json }
}

async function login() {
  const r = await fetch(URL + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  })
  if (!r.ok) throw new Error('login failed: ' + r.status)
  return (await r.json()).token
}

function parseConditions(rule) {
  const c = rule?.conditions
  if (typeof c === 'string') { try { return JSON.parse(c) } catch { return null } }
  return c
}

// Vérifie l'autosave de FieldVisibilityRuleModal : éditer une règle EXISTANTE
// (op AND → OR) persiste automatiquement (debounce), sans bouton « Enregistrer ».
describe('FieldVisibilityRuleModal — autosave d\'une règle existante', () => {
  let browser, ctx, page, token
  let createdRuleId = null
  // Sauvegarde des règles is_sent préexistantes (config user à restaurer).
  let backupRules = []

  before(async () => {
    token = await login()

    // Sauvegarde puis retire les règles is_sent existantes pour partir d'un état net.
    const existing = await api(token, 'GET', '/field-visibility-rules?context=facture')
    for (const r of existing.body.data || []) {
      if (r.field_id === 'is_sent') {
        backupRules.push({ context: r.context, field_id: r.field_id, conditions: parseConditions(r) })
        await api(token, 'DELETE', '/field-visibility-rules/' + r.id)
      }
    }

    // Crée la règle à éditer : cacher is_sent si subscription_id populé (op AND).
    const create = await api(token, 'POST', '/field-visibility-rules', {
      context: 'facture',
      field_id: 'is_sent',
      conditions: { op: 'AND', rules: [{ field: 'subscription_id', operator: 'populated' }] },
    })
    assert.equal(create.status, 201, 'POST règle: ' + JSON.stringify(create.body))
    createdRuleId = create.body.id

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    if (createdRuleId) {
      await api(token, 'DELETE', '/field-visibility-rules/' + createdRuleId)
    }
    // Restaure les règles is_sent préexistantes écrasées par le test.
    for (const r of backupRules) {
      await api(token, 'POST', '/field-visibility-rules', r)
    }
    await browser?.close()
  })

  test('changer op AND → OR persiste automatiquement, sans bouton Enregistrer', async () => {
    await page.goto(`${URL}/factures/${SUBSCRIPTION_FACTURE_ID}`, { waitUntil: 'networkidle' })

    // Ouvre le menu admin via clic droit sur le placeholder masqué.
    const placeholder = page.locator('[data-field-hidden="true"][data-field-id="is_sent"]')
    await placeholder.waitFor({ state: 'visible', timeout: 5000 })
    await placeholder.click({ button: 'right' })
    await page.click('button:has-text("Gérer les règles de visibilité")')

    // La modale s'ouvre — le select de combinaison (ET/OU) de la règle existante.
    const comboSelect = page.locator('select').filter({
      has: page.locator('option[value="OR"]'),
    }).first()
    await comboSelect.waitFor({ state: 'visible', timeout: 5000 })

    // Aucun bouton « Enregistrer » ne doit exister pour une règle existante
    // (autosave). Le bouton « Créer la règle » n'apparaît que pour une nouvelle.
    assert.equal(
      await page.locator('button:has-text("Enregistrer")').count(),
      0,
      'aucun bouton Enregistrer attendu sur une règle existante (autosave)',
    )

    // Change la combinaison AND → OR : déclenche onChange → debounce autosave.
    await comboSelect.selectOption('OR')

    // L'indicateur d'autosave doit apparaître puis confirmer la sauvegarde.
    await page.locator('[data-testid="rule-autosave-status"]').first()
      .waitFor({ state: 'visible', timeout: 5000 })

    // Poll côté serveur : la règle doit refléter op === 'OR' sans aucun clic Save.
    let persisted = false
    for (let i = 0; i < 20; i++) {
      const r = await api(token, 'GET', '/field-visibility-rules?context=facture')
      const rule = (r.body.data || []).find(x => x.id === createdRuleId)
      const cond = parseConditions(rule)
      if (cond && cond.op === 'OR') { persisted = true; break }
      await new Promise(res => setTimeout(res, 300))
    }
    assert.ok(persisted, 'la règle doit être persistée avec op=OR via autosave')
  })
})
