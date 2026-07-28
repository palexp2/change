// Bulle d'aide (FeedbackFab) — flux complet suggestion → implémentation directe
// (opus, effort élevé, sans proposition ni approbation) → fiche en file sur la
// page agent.
//
// L'agent est forcé OFF (capturé/restauré) : la tâche est créée `approved`
// mais NE spawn AUCUNE exécution (queue automatique via busy). Tout est
// nettoyé en after() : tâche + suggestion supprimées via l'API.

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

describe('Bulle d\'aide — suggestion → implémentation directe', () => {
  let browser, ctx, page
  let originalEnabled = false
  let itemId = null
  let taskId = null

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
    // Cleanup même en cas d'échec : tâche, suggestion, puis toggle restauré.
    try { if (taskId && page) await api(page, 'DELETE', `/agent/tasks/${taskId}`) } catch {}
    try { if (itemId && page) await api(page, 'DELETE', `/agent/backlog/${itemId}`) } catch {}
    try { if (page) await api(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('soumission → tâche approuvée en file (opus/high, sans approbation manuelle)', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    // 1. Ouvrir la bulle → le formulaire s'ouvre directement (demande générale).
    await page.click('[data-testid="feedback-fab"]')
    await page.waitForSelector('[data-testid="feedback-fab-text"]', { timeout: 5000 })
    const text = `E2E fab ${Date.now()} : le tri par montant de la page Achats ignore le signe.`
    await page.fill('[data-testid="feedback-fab-text"]', text)
    await page.click('[data-testid="feedback-fab-submit"]')

    // 2. Confirmation immédiate d'implémentation (pas de proposition à approuver).
    await page.waitForSelector('[data-testid="feedback-approved"]', { timeout: 10000 })

    // 3. Suggestion créée côté API, avec contexte, et déjà liée à une tâche.
    const backlog = await api(page, 'GET', '/agent/backlog')
    const item = backlog.find(i => i.text === text)
    assert.ok(item, 'la suggestion doit exister côté API')
    itemId = item.id
    assert.ok(item.context.includes('/dashboard'), 'la page d\'origine doit être jointe en contexte')
    assert.ok(item.author, 'l\'auteur doit être enregistré')
    assert.ok(item.task_id, 'la suggestion doit être liée à une tâche immédiatement')
    taskId = item.task_id

    // 4. Tâche approuvée d'office, toujours opus/effort élevé (agent OFF → aucune exécution).
    const task = (await api(page, 'GET', '/agent/tasks')).find(t => t.id === taskId)
    assert.ok(task, 'la tâche doit exister')
    assert.equal(task.status, 'approved', 'la tâche doit être approuvée automatiquement')
    assert.equal(task.kind, 'suggestion', 'kind=suggestion attendu')
    assert.equal(task.model, 'opus', 'implémentation directe → modèle opus')
    assert.equal(task.effort, 'high', 'implémentation directe → effort high')

    // 5. Lien vers la page agent → fiche visible avec statut « En file ».
    await page.click('[data-testid="feedback-open-agent"]')
    await page.waitForURL(u => u.toString().endsWith('/agent'), { timeout: 10000 })
    const card = page.locator('[data-testid="suggestion-card"]', { hasText: 'E2E fab' })
    await card.first().waitFor({ timeout: 10000 })
    assert.ok((await card.first().innerText()).includes('En file'), 'la fiche doit afficher « En file »')
  })
})
