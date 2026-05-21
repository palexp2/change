const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Facture d'abonnement utilisée pour vérifier le masquage (subscription_id populé).
// L'autre test cible une facture sans subscription_id.
const SUBSCRIPTION_FACTURE_ID = '60c4e062-c349-43e7-8309-5b49bf9bce2f'

async function api(token, method, path, body) {
  const res = await fetch(URL + '/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
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

describe('Field visibility rules — masquage conditionnel des champs', () => {
  let browser, ctx, page, token
  let createdRuleId = null
  let nonSubscriptionFactureId = null

  before(async () => {
    token = await login()

    // Trouver une facture SANS subscription_id pour le test de non-masquage.
    const r = await api(token, 'GET', '/projets/factures?limit=all')
    const noSub = r.body.data.find(f =>
      !f.subscription_id && !f.subscription_local_id && f.id !== SUBSCRIPTION_FACTURE_ID
    )
    if (!noSub) throw new Error('Aucune facture sans subscription trouvée')
    nonSubscriptionFactureId = noSub.id

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
    // Cleanup obligatoire : supprime la règle même en cas d'échec.
    if (createdRuleId) {
      await api(token, 'DELETE', '/field-visibility-rules/' + createdRuleId)
    }
    await browser?.close()
  })

  test('sans règle : le champ « Envoyée » est visible sur la facture abonnement', async () => {
    // S'assurer qu'il n'y a aucune règle pour is_sent au démarrage
    const existing = await api(token, 'GET', '/field-visibility-rules?context=facture')
    for (const r of existing.body.data || []) {
      if (r.field_id === 'is_sent') {
        await api(token, 'DELETE', '/field-visibility-rules/' + r.id)
      }
    }
    await page.goto(`${URL}/factures/${SUBSCRIPTION_FACTURE_ID}`, { waitUntil: 'networkidle' })
    // Le bloc avec data-field-id="is_sent" doit être visible (pas le placeholder)
    const hiddenPlaceholders = await page.locator('[data-field-hidden="true"][data-field-id="is_sent"]').count()
    assert.equal(hiddenPlaceholders, 0, 'aucun placeholder « masqué » attendu sans règle')
    const visibleBlock = page.locator('[data-field-id="is_sent"]').first()
    await visibleBlock.waitFor({ state: 'visible', timeout: 5000 })
    const text = await visibleBlock.innerText()
    assert.ok(text.includes('Envoyée'), 'le bloc devrait contenir le libellé « Envoyée »')
  })

  test('création d\'une règle : « cacher is_sent si subscription_id populé »', async () => {
    const create = await api(token, 'POST', '/field-visibility-rules', {
      context: 'facture',
      field_id: 'is_sent',
      conditions: {
        op: 'AND',
        rules: [{ field: 'subscription_id', operator: 'populated' }],
      },
    })
    assert.equal(create.status, 201, 'POST devrait renvoyer 201, got ' + create.status + ' ' + JSON.stringify(create.body))
    assert.ok(create.body.id, 'la règle créée doit avoir un id')
    createdRuleId = create.body.id
  })

  test('avec règle : la facture d\'abonnement masque « Envoyée » (placeholder admin)', async () => {
    await page.goto(`${URL}/factures/${SUBSCRIPTION_FACTURE_ID}`, { waitUntil: 'networkidle' })
    // L'utilisateur est admin → placeholder visible avec data-field-hidden="true"
    const placeholder = page.locator('[data-field-hidden="true"][data-field-id="is_sent"]')
    await placeholder.waitFor({ state: 'visible', timeout: 5000 })
    // Le badge vert original ne doit plus être affiché : il devrait n'y avoir
    // qu'un seul élément data-field-id="is_sent" (le placeholder, pas le bloc original).
    const count = await page.locator('[data-field-id="is_sent"]').count()
    assert.equal(count, 1, 'seul le placeholder doit être présent, pas l\'ancien bloc')
  })

  test('la facture SANS abonnement garde le champ « Envoyée » visible', async () => {
    await page.goto(`${URL}/factures/${nonSubscriptionFactureId}`, { waitUntil: 'networkidle' })
    const hidden = await page.locator('[data-field-hidden="true"][data-field-id="is_sent"]').count()
    assert.equal(hidden, 0, 'pas de masquage sur une facture sans subscription_id')
    const visible = page.locator('[data-field-id="is_sent"]').first()
    await visible.waitFor({ state: 'visible', timeout: 5000 })
  })

  test('clic droit sur le placeholder ouvre le menu admin', async () => {
    await page.goto(`${URL}/factures/${SUBSCRIPTION_FACTURE_ID}`, { waitUntil: 'networkidle' })
    const placeholder = page.locator('[data-field-hidden="true"][data-field-id="is_sent"]')
    await placeholder.waitFor({ state: 'visible' })
    await placeholder.click({ button: 'right' })
    // Le menu contextuel doit afficher l'option de gestion
    const menuItem = page.locator('button:has-text("Gérer les règles de visibilité")')
    await menuItem.waitFor({ state: 'visible', timeout: 3000 })
  })

  test('suppression de la règle : le champ redevient visible', async () => {
    if (!createdRuleId) return
    const del = await api(token, 'DELETE', '/field-visibility-rules/' + createdRuleId)
    assert.equal(del.status, 200)
    createdRuleId = null

    await page.goto(`${URL}/factures/${SUBSCRIPTION_FACTURE_ID}`, { waitUntil: 'networkidle' })
    const hidden = await page.locator('[data-field-hidden="true"][data-field-id="is_sent"]').count()
    assert.equal(hidden, 0, 'plus de placeholder après suppression de la règle')
  })

  test('validation : POST rejette des conditions invalides', async () => {
    const r1 = await api(token, 'POST', '/field-visibility-rules', {
      context: 'facture',
      field_id: 'is_sent',
      conditions: { op: 'XOR', rules: [{ field: 'x', operator: 'populated' }] },
    })
    assert.equal(r1.status, 400, 'op invalide doit échouer')

    const r2 = await api(token, 'POST', '/field-visibility-rules', {
      context: 'facture',
      field_id: 'is_sent',
      conditions: { op: 'AND', rules: [{ field: 'x', operator: 'foo' }] },
    })
    assert.equal(r2.status, 400, 'operator invalide doit échouer')

    const r3 = await api(token, 'POST', '/field-visibility-rules', {
      context: 'facture',
      field_id: 'is_sent',
      conditions: { op: 'AND', rules: [{ field: 'x', operator: 'equals' }] },
    })
    assert.equal(r3.status, 400, 'equals sans value doit échouer')
  })
})
