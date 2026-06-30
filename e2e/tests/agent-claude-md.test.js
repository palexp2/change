// Agent → Instructions projet — consultable & modifiable (admin).
//
// Vérifie le panneau "Instructions projet" de la page /agent :
//   1. Le panneau est présent et, déplié, affiche le contenu courant de CLAUDE.md
//      dans un textarea (consultable).
//   2. Éditer le textarea + blur autosauvegarde via PUT /agent/claude-md → le
//      contenu est persisté (relu par GET /agent/claude-md).
//   3. Après rechargement, le textarea ré-affiche le contenu enregistré.
//
// CLAUDE.md est un fichier de config existant (versionné) : on capture son contenu
// réel au setup et on le RESTAURE en after() — règle CLAUDE.md : ne jamais écraser
// une config sans backup/restauration.

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

describe('Agent — Instructions projet', () => {
  let browser, ctx, page
  let originalContent

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)

    // Capture le contenu réel AVANT de le toucher, pour restauration en after().
    const r = await apiGet(page, '/agent/claude-md')
    originalContent = r.content
  })

  after(async () => {
    // Restaure toujours le contenu original, même si le test a échoué.
    try {
      if (page && typeof originalContent === 'string') {
        await apiPut(page, '/agent/claude-md', { content: originalContent })
      }
    } catch {}
    await browser?.close()
  })

  test('consultable + modifiable + persistant', async () => {
    assert.equal(typeof originalContent, 'string', 'GET /agent/claude-md doit renvoyer content')
    assert.ok(originalContent.length > 0, 'CLAUDE.md ne doit pas être vide')

    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })

    // 1. Déplier le panneau "Instructions projet" → le textarea montre le contenu courant.
    await page.waitForSelector('text=Instructions projet', { timeout: 10000 })
    await page.click('text=Instructions projet')
    const ta = page.locator('[data-testid="claude-md-textarea"]')
    await ta.waitFor({ timeout: 10000 })
    assert.equal(await ta.inputValue(), originalContent, 'le textarea doit afficher le CLAUDE.md courant')

    // 2. Éditer + blur → autosave via PUT /agent/claude-md.
    const marker = `\n\n<!-- E2E marker ${Date.now()} -->`
    const edited = originalContent + marker
    await ta.fill(edited)
    await ta.blur()
    await page.waitForTimeout(600)
    const saved = await apiGet(page, '/agent/claude-md')
    assert.equal(saved.content, edited, 'le contenu édité doit être persisté côté serveur')

    // 3. Recharger → le textarea ré-affiche le contenu enregistré.
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.click('text=Instructions projet')
    const ta2 = page.locator('[data-testid="claude-md-textarea"]')
    await ta2.waitFor({ timeout: 10000 })
    assert.equal(await ta2.inputValue(), edited, 'le contenu enregistré doit survivre au rechargement')
  })
})
