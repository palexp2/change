const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Même facture d'abonnement que field-visibility-rules.test.js (subscription_id populé)
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

// Vérifie que la suppression d'une règle dans FieldVisibilityRuleModal passe par
// la ConfirmModal centralisée (await confirm({...})) et non window.confirm().
describe('FieldVisibilityRuleModal — suppression via ConfirmModal centralisée', () => {
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
        backupRules.push({ context: r.context, field_id: r.field_id, conditions: r.conditions })
        await api(token, 'DELETE', '/field-visibility-rules/' + r.id)
      }
    }

    // Crée la règle à supprimer via l'UI : cacher is_sent si subscription_id populé.
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
    // Cleanup : supprime la règle de test si elle subsiste (échec avant suppression UI).
    if (createdRuleId) {
      await api(token, 'DELETE', '/field-visibility-rules/' + createdRuleId)
    }
    // Restaure les règles is_sent préexistantes écrasées par le test.
    for (const r of backupRules) {
      await api(token, 'POST', '/field-visibility-rules', r)
    }
    await browser?.close()
  })

  test('clic « Supprimer » → ConfirmModal centralisée, pas window.confirm', async () => {
    // Intercepte tout dialog natif : aucun ne doit s'ouvrir.
    const nativeDialogs = []
    page.on('dialog', d => { nativeDialogs.push(d.message()); d.dismiss() })

    await page.goto(`${URL}/factures/${SUBSCRIPTION_FACTURE_ID}`, { waitUntil: 'networkidle' })

    // Ouvre le menu admin via clic droit sur le placeholder masqué.
    const placeholder = page.locator('[data-field-hidden="true"][data-field-id="is_sent"]')
    await placeholder.waitFor({ state: 'visible', timeout: 5000 })
    await placeholder.click({ button: 'right' })
    await page.click('button:has-text("Gérer les règles de visibilité")')

    // La modale d'édition des règles s'ouvre — le bouton « Supprimer » de la règle.
    const deleteRuleBtn = page.locator('button:has-text("Supprimer")').first()
    await deleteRuleBtn.waitFor({ state: 'visible', timeout: 5000 })
    await deleteRuleBtn.click()

    // La ConfirmModal centralisée doit apparaître avec le titre « Supprimer cette règle ? ».
    const confirmModal = page.locator('.fixed.inset-0.z-50 .bg-white.rounded-2xl').filter({
      hasText: 'Supprimer cette règle',
    }).first()
    await confirmModal.waitFor({ state: 'visible', timeout: 3000 })
    assert.ok(
      await confirmModal.locator('button:has-text("Annuler")').isVisible(),
      'bouton Annuler attendu sur la ConfirmModal',
    )

    // Confirme la suppression.
    await confirmModal.locator('button:has-text("Supprimer")').click()
    await confirmModal.waitFor({ state: 'hidden', timeout: 3000 })

    // Aucun window.confirm natif ne doit avoir été déclenché.
    assert.equal(nativeDialogs.length, 0, `aucun dialog natif attendu — reçu: ${nativeDialogs.join(', ')}`)

    // La règle doit avoir été supprimée côté serveur.
    const after = await api(token, 'GET', '/field-visibility-rules?context=facture')
    const stillThere = (after.body.data || []).some(r => r.id === createdRuleId)
    assert.equal(stillThere, false, 'la règle doit être supprimée après confirmation')
    createdRuleId = null
  })
})
