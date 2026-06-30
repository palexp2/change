// Agent autonome — prompt général consultable & modifiable.
//
// Vérifie la nouvelle section "Prompt général" de la page /agent :
//   1. Le panneau est présent et, déplié, montre la valeur courante du prompt
//      (consultable) dans un textarea.
//   2. Éditer le textarea et sortir du champ (blur) autosauvegarde via
//      PUT /agent/settings → la valeur est persistée (lue par GET /agent/settings).
//   3. Après rechargement de la page, le textarea ré-affiche la valeur enregistrée.
//
// L'agent est forcé OFF pour tout le run (aucun subprocess Claude). La valeur
// réelle du prompt ET du toggle sont capturées au setup et restaurées en after()
// — règle CLAUDE.md : ne jamais écraser une config sans backup/restauration.

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

describe('Agent autonome — prompt général', () => {
  let browser, ctx, page
  let originalEnabled = false
  let originalPrompt

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)

    // Capture la config réelle AVANT de la toucher, pour restauration en after().
    const s = await apiGet(page, '/agent/settings')
    originalEnabled = !!s.enabled
    originalPrompt = s.generalPrompt
    await apiPut(page, '/agent/settings', { enabled: false })
  })

  after(async () => {
    // Restaure toujours, même si le test a échoué.
    try {
      if (page && originalPrompt !== undefined) {
        await apiPut(page, '/agent/settings', { enabled: originalEnabled, generalPrompt: originalPrompt })
      } else if (page) {
        await apiPut(page, '/agent/settings', { enabled: originalEnabled })
      }
    } catch {}
    await browser?.close()
  })

  test('consultable + modifiable + persistant', async () => {
    // L'API doit déjà exposer une valeur (défaut serveur si jamais configurée).
    assert.equal(typeof originalPrompt, 'string', 'GET /agent/settings doit renvoyer generalPrompt')
    assert.ok(originalPrompt.length > 0, 'generalPrompt ne doit pas être vide (défaut serveur)')

    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })

    // 1. Le panneau "Prompt général" est présent ; le déplier révèle le textarea
    //    contenant la valeur courante → consultable.
    await page.waitForSelector('text=Prompt général', { timeout: 10000 })
    await page.click('text=Prompt général')
    const ta = page.locator('[data-testid="prompt-textarea-general"]')
    await ta.waitFor({ timeout: 5000 })
    assert.equal(await ta.inputValue(), originalPrompt, 'le textarea doit afficher le prompt courant')

    // 2. Éditer + blur → autosave via PUT /agent/settings.
    const marker = `\n\n[E2E marker ${Date.now()}]`
    const edited = originalPrompt + marker
    await ta.fill(edited)
    await ta.blur()
    await page.waitForTimeout(600)
    const after = await apiGet(page, '/agent/settings')
    assert.equal(after.generalPrompt, edited, 'le prompt édité doit être persisté côté serveur')

    // 3. Recharger la page → le textarea ré-affiche la valeur enregistrée.
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.click('text=Prompt général')
    const ta2 = page.locator('[data-testid="prompt-textarea-general"]')
    await ta2.waitFor({ timeout: 5000 })
    assert.equal(await ta2.inputValue(), edited, 'le prompt enregistré doit survivre au rechargement')
  })
})
