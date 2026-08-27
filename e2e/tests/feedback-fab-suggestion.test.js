// Bulle d'aide (FeedbackFab) — flux complet demande → item dans la file de la
// section Travaux → fiche visible sur /travaux.
//
// Destination unique depuis la fusion des deux boutons : l'envoi dépose toujours
// un prompt dans la file (il part tout de suite si rien ne tourne, sinon il
// attend son tour en fin de file).
//
// L'agent est forcé OFF (capturé/restauré) : l'item reste `queued` et NE spawn
// AUCUNE exécution. Nettoyé en after() : prompt supprimé via l'API.

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

describe('Bulle d\'aide — demande → file Travaux', () => {
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
    // Cleanup même en cas d'échec : item de file, puis toggle restauré.
    try { if (promptId && page) await api(page, 'DELETE', `/travaux/prompts/${promptId}`) } catch {}
    try { if (page) await api(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('soumission → item en file Travaux (agent OFF, rien ne démarre)', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    // 1. Ouvrir la bulle → le formulaire s'ouvre directement (demande générale).
    await page.click('[data-testid="feedback-fab"]')
    await page.waitForSelector('[data-testid="feedback-fab-text"]', { timeout: 5000 })
    const text = `E2E fab ${Date.now()} : le tri par montant de la page Achats ignore le signe.`
    await page.fill('[data-testid="feedback-fab-text"]', text)
    await page.click('[data-testid="feedback-fab-submit"]')

    // 2. La modale se referme d'elle-même (aucun écran de confirmation).
    await page.waitForSelector('[data-testid="feedback-fab-text"]', { state: 'detached', timeout: 10000 })

    // 3. Item créé côté API, dans la file finance, avec la page d'origine dans
    //    le prompt — et rien au backlog agent.
    const { prompts } = await api(page, 'GET', '/travaux/prompts')
    const item = (prompts || []).find(p => (p.prompt || '').includes(text))
    assert.ok(item, 'l\'item doit exister dans la file Travaux')
    promptId = item.id
    assert.equal(item.space, 'finance', 'file de la section Travaux (/travaux)')
    assert.equal(item.status, 'queued', 'agent OFF → l\'item attend, rien ne démarre')
    assert.ok(item.prompt.includes('/dashboard'), 'la page d\'origine doit être jointe au prompt')
    assert.ok(item.created_by, 'l\'auteur doit être enregistré')
    const backlog = await api(page, 'GET', '/agent/backlog')
    assert.ok(!backlog.some(i => (i.text || '').includes(text)),
      'plus rien ne part vers le backlog agent')

    // 4. Suivi dans la section Travaux : l'item est bien dans la file.
    await page.goto(URL + '/travaux', { waitUntil: 'networkidle' })
    await page.locator(`[data-prompt-id="${item.id}"]`).first().waitFor({ timeout: 15000 })
  })
})
