// Bulle d'aide (FeedbackFab) — bouton de portée « Toute l'application ».
// Par défaut la demande est liée à la page courante ; un bouton permet de
// basculer la portée vers l'ensemble de l'app. Le contexte joint au prompt
// déposé dans la file Travaux reflète ce choix.
//
// Agent forcé OFF (capturé/restauré) : l'item reste `queued` et NE spawn AUCUNE
// exécution. Nettoyage en after() : item de file supprimé.

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

async function api(page, method, p, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: body ? JSON.stringify(body) : undefined,
    })
    return r.json()
  }, { method, path: p, body })
}

describe('Bulle d\'aide — portée « Toute l\'application »', () => {
  let browser, ctx, page
  let originalEnabled = false
  let promptId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
    const s = await api(page, 'GET', '/agent/settings')
    originalEnabled = !!s.enabled
    await api(page, 'PUT', '/agent/settings', { enabled: false })
  })

  after(async () => {
    try { if (promptId && page) await api(page, 'DELETE', `/travaux/prompts/${promptId}`) } catch {}
    try { if (page) await api(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('le bouton bascule la portée et le contexte joint devient global', async () => {
    await page.goto(URL + '/interactions', { waitUntil: 'networkidle' })

    // Ouvrir la bulle → le formulaire s'ouvre directement (demande générale).
    await page.click('[data-testid="feedback-fab"]')
    await page.waitForSelector('[data-testid="feedback-fab-text"]', { timeout: 5000 })

    // Par défaut : le bouton affiche le chemin de la page courante.
    const scope = page.locator('[data-testid="feedback-scope-toggle"]')
    await scope.waitFor({ timeout: 5000 })
    assert.ok((await scope.innerText()).includes('/interactions'), 'par défaut le bouton montre la page courante')

    // Clic → bascule vers « Toute l'application ».
    await scope.click()
    assert.ok((await scope.innerText()).includes('Toute l\'application'), 'après clic le bouton montre la portée globale')

    const text = `E2E fab scope ${Date.now()} : uniformiser la police des titres partout dans l'app.`
    await page.fill('[data-testid="feedback-fab-text"]', text)
    await page.click('[data-testid="feedback-fab-submit"]')
    // La modale se referme d'elle-même — plus d'écran de confirmation.
    await page.waitForSelector('[data-testid="feedback-fab-text"]', { state: 'detached', timeout: 10000 })

    // L'item existe dans la file Travaux et son contexte mentionne l'ensemble
    // de l'application.
    const { prompts } = await api(page, 'GET', '/travaux/prompts')
    const item = (prompts || []).find(p => (p.prompt || '').includes(text))
    assert.ok(item, 'l\'item doit exister côté API')
    promptId = item.id
    assert.ok(
      /ensemble de l'application/i.test(item.prompt),
      `le contexte doit mentionner l'ensemble de l'application (reçu: ${item.prompt})`
    )
  })
})
