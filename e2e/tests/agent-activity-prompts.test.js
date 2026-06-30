// Agent autonome — modèles de prompt par activité (génération / discussion / exécution).
//
// Vérifie que TOUT ce que le modèle reçoit en prompt est désormais consultable et
// éditable depuis /agent :
//   1. GET /agent/settings expose generationPrompt + conversationPrompt + executionPrompt
//      ET un bloc `defaults` (pour le bouton « Réinitialiser »).
//   2. Le panneau « Prompt — génération d'idées » montre le modèle courant (avec ses
//      jetons {{…}}) dans un textarea, et l'édition + blur autosauvegarde via
//      PUT /agent/settings.
//   3. Le bouton « Réinitialiser le modèle par défaut » restaure le défaut serveur.
//
// L'agent est forcé OFF pour tout le run (aucun subprocess Claude). La valeur réelle
// du modèle de génération ET du toggle sont capturées au setup et restaurées en
// after() — règle CLAUDE.md : ne jamais écraser une config sans backup/restauration.

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

async function apiGet(page, p) {
  return page.evaluate(async (path) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api' + path, { headers: { Authorization: `Bearer ${tok}` } })
    return r.json()
  }, p)
}
async function apiPut(page, p, body) {
  return page.evaluate(async ({ path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api' + path, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) })
    return r.json()
  }, { path: p, body })
}

describe('Agent autonome — modèles de prompt par activité', () => {
  let browser, ctx, page
  let originalEnabled = false
  let originalGeneration
  let serverDefault

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)

    // Capture la config réelle AVANT de la toucher, pour restauration en after().
    const s = await apiGet(page, '/agent/settings')
    originalEnabled = !!s.enabled
    originalGeneration = s.generationPrompt
    serverDefault = s.defaults && s.defaults.generationPrompt
    await apiPut(page, '/agent/settings', { enabled: false })
  })

  after(async () => {
    // Restaure toujours, même si le test a échoué.
    try {
      if (page && originalGeneration !== undefined) {
        await apiPut(page, '/agent/settings', { enabled: originalEnabled, generationPrompt: originalGeneration })
      } else if (page) {
        await apiPut(page, '/agent/settings', { enabled: originalEnabled })
      }
    } catch {}
    await browser?.close()
  })

  test('API expose les 3 modèles + defaults', async () => {
    const s = await apiGet(page, '/agent/settings')
    for (const k of ['generationPrompt', 'conversationPrompt', 'executionPrompt']) {
      assert.equal(typeof s[k], 'string', `GET /agent/settings doit renvoyer ${k}`)
      assert.ok(s[k].length > 0, `${k} ne doit pas être vide (défaut serveur)`)
    }
    assert.ok(s.defaults, 'GET doit inclure un bloc defaults')
    assert.equal(typeof s.defaults.generationPrompt, 'string', 'defaults.generationPrompt requis pour le bouton Réinitialiser')
    // Le modèle de génération doit contenir ses jetons de templating.
    assert.ok(s.generationPrompt.includes('{{general}}'), 'le modèle de génération doit contenir {{general}}')
    assert.ok(s.generationPrompt.includes('{{slots}}'), 'le modèle de génération doit contenir {{slots}}')
  })

  test('édition + autosave + réinitialisation', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })

    // Déplier le panneau de génération → le textarea montre le modèle courant.
    await page.click('text=Prompt — génération d\'idées')
    const ta = page.locator('[data-testid="prompt-textarea-generation"]')
    await ta.waitFor({ timeout: 5000 })
    const shown = await ta.inputValue()
    assert.ok(shown.includes('{{slots}}'), 'le textarea doit afficher le modèle avec ses jetons')

    // 1. Éditer + blur → autosave via PUT /agent/settings.
    const marker = `\n\n[E2E marker ${Date.now()}]`
    const edited = shown + marker
    await ta.fill(edited)
    await ta.blur()
    await page.waitForTimeout(700)
    let after = await apiGet(page, '/agent/settings')
    assert.equal(after.generationPrompt, edited, 'le modèle édité doit être persisté côté serveur')

    // 2. Le badge « Personnalisé » + le bouton Réinitialiser apparaissent (valeur ≠ défaut).
    const resetBtn = page.locator('[data-testid="prompt-reset-generation"]')
    await resetBtn.waitFor({ timeout: 5000 })

    // 3. Cliquer Réinitialiser → restaure le défaut serveur (persisté + affiché).
    await resetBtn.click()
    await page.waitForTimeout(700)
    after = await apiGet(page, '/agent/settings')
    assert.equal(after.generationPrompt, serverDefault, 'Réinitialiser doit restaurer le modèle par défaut')
    assert.equal(await ta.inputValue(), serverDefault, 'le textarea doit ré-afficher le défaut après réinitialisation')
  })
})
