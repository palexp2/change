// Page Agent — une demande « toute l'application » ne montre aucune référence à
// la page d'où elle a été émise.
//
// Signalement utilisateur : pour un changement global de toute l'application, on
// affichait tout de même la page où la demande avait été faite (badge de
// contexte + éventuel lien « Voir la page »). Le contexte d'une demande globale
// (voir FeedbackFab) commence par « Demande concernant l'ensemble de
// l'application (pas seulement la page /x) ». La carte doit alors montrer
// « Toute l'application » et JAMAIS le chemin de page ni le lien « Voir la page ».
//
// Agent forcé OFF (capturé/restauré). Seed via POST /agent/backlog (crée item +
// tâche liée) puis PATCH de la tâche en « done » pour faire apparaître (le cas
// échéant) le lien « Voir la page ». Nettoyage complet en after().

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const SEED_TEXT = `E2E app-wide no-page-link ${Date.now()}`
// Contexte tel que produit par FeedbackFab pour une demande « toute l'application ».
const SEED_CONTEXT = "Demande concernant l'ensemble de l'application (pas seulement la page /factures)"

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

function api(page, method, p, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const opts = { method, headers: { Authorization: `Bearer ${tok}` } }
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
    const r = await fetch('/erp/api' + path, opts)
    return r.json()
  }, { method, path: p, body })
}

describe('Agent — demande globale : aucune référence à la page d\'origine', () => {
  let browser, ctx, page
  let originalEnabled = false
  let backlogId = null
  let taskId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)

    const s = await api(page, 'GET', '/agent/settings')
    originalEnabled = !!s.enabled
    await api(page, 'PUT', '/agent/settings', { enabled: false })

    const item = await api(page, 'POST', '/agent/backlog', { text: SEED_TEXT, context: SEED_CONTEXT })
    backlogId = item.id
    taskId = item.task_id
    assert.ok(taskId, 'la tâche liée doit exister après POST /agent/backlog')
    const now = new Date().toISOString()
    await api(page, 'PATCH', `/agent/tasks/${taskId}`, {
      status: 'done', started_at: now, completed_at: now,
      user_summary: 'Seed E2E — implémentation simulée.',
    })
  })

  after(async () => {
    try { if (backlogId && page) await api(page, 'DELETE', `/agent/backlog/${backlogId}`) } catch {}
    try { if (taskId && page) await api(page, 'DELETE', `/agent/tasks/${taskId}`) } catch {}
    try { if (page) await api(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('badge « Toute l\'application », aucune page /factures ni lien « Voir la page »', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Agent autonome', { timeout: 10000 })

    const card = page.locator('[data-testid="suggestion-card"]', { hasText: SEED_TEXT })
    await card.first().waitFor({ timeout: 10000 })

    // Le badge de contexte doit montrer « Toute l'application ».
    const appWideBadge = card.first().getByTestId('context-app-wide')
    await appWideBadge.waitFor({ timeout: 5000 })
    assert.ok((await appWideBadge.innerText()).includes('Toute l\'application'), 'le badge doit indiquer la portée globale')

    // Aucune référence visible au chemin de la page d'origine.
    const cardText = await card.first().innerText()
    assert.ok(!cardText.includes('/factures'), 'la carte ne doit pas afficher le chemin de la page d\'origine')

    // Aucun lien « Voir la page » sur une demande globale.
    assert.equal(await card.first().getByTestId('card-page-link').count(), 0, 'aucun lien « Voir la page » pour une demande globale')
  })
})
