// Page Agent — le badge de contexte d'une suggestion n'affiche QUE la page
// d'origine, pas le descriptif brut de l'élément ciblé (balise HTML).
//
// Le contexte stocké combine « /page — élément ciblé par l'utilisateur : <…> » ;
// le badge doit montrer « /page » seulement, le reste restant dispo au survol.
//
// L'agent est forcé OFF (capturé/restauré). La suggestion créée via l'API
// auto-approuve une tâche (agent OFF → aucune exécution). Tout est nettoyé
// en after() : tâche + suggestion supprimées.

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

describe('Page Agent — badge de contexte = page seulement', () => {
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
    try { if (taskId && page) await api(page, 'DELETE', `/agent/tasks/${taskId}`) } catch {}
    try { if (itemId && page) await api(page, 'DELETE', `/agent/backlog/${itemId}`) } catch {}
    try { if (page) await api(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('le badge montre « /factures » sans le descriptif de l\'élément', async () => {
    const stamp = Date.now()
    const text = `E2E ctx-badge ${stamp} : badge de contexte = page seulement.`
    const elementDesc = '<button data-testid="factures-stripe-sync" class="btn-primary">'
    const context = `/factures — élément ciblé par l'utilisateur : ${elementDesc}`

    // Seed via l'API (auto-approve ; agent OFF → aucune exécution ne démarre).
    await api(page, 'POST', '/agent/backlog', { text, context, mode: 'question' })
    const backlog = await api(page, 'GET', '/agent/backlog')
    const item = backlog.find(i => i.text === text)
    assert.ok(item, 'la suggestion doit exister côté API')
    itemId = item.id
    taskId = item.task_id || null
    assert.equal(item.context, context, 'le contexte stocké doit contenir la page ET l\'élément')

    // Sur la page Agent, la carte doit afficher le badge de contexte réduit à la page.
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    const card = page.locator('[data-testid="suggestion-card"]', { hasText: `E2E ctx-badge ${stamp}` })
    await card.first().waitFor({ timeout: 10000 })

    // Le badge mono-espace porte le contexte complet en title, mais n'affiche que « /factures ».
    const badge = card.first().locator('span.font-mono', { hasText: '/factures' })
    await badge.first().waitFor({ timeout: 5000 })
    const badgeText = (await badge.first().innerText()).trim()
    assert.equal(badgeText, '/factures', 'le badge doit afficher uniquement la page')
    assert.ok(!badgeText.includes('élément ciblé'), 'le badge ne doit pas contenir le descriptif de l\'élément')
    assert.ok(!badgeText.includes('<button'), 'le badge ne doit pas contenir la balise HTML brute')

    // Le contexte complet reste accessible au survol (attribut title).
    const title = await badge.first().getAttribute('title')
    assert.equal(title, context, 'le contexte complet doit rester disponible en title')
  })
})
