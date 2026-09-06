// Agent autonome — « Voir la page » déduit du rapport quand il n'y a pas de contexte.
//
// Les tâches issues de /travaux (ou de l'agent autonome sans passer par la bulle
// de feedback d'une page) n'ont pas de `context` (route de signalement) : avant ce
// correctif, la carte de tâche terminée n'affichait donc jamais de lien « Voir la
// page », même si le rapport de l'agent mentionne clairement un fichier de page
// précis (ex. client/src/pages/Paies.jsx). On dérive maintenant la route à partir
// du rapport via le manifeste d'architecture (composant → route).
//
// Connexion via un JWT signé directement (compte claude@orisha.io, sans mot de
// passe requis) — voir server/src/middleware/auth.js: « tokens de test signés
// sans record » est un usage prévu par le code d'auth.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const crypto = require('node:crypto')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) throw new Error('JWT_SECRET env var required (voir server/.env)')
const CLAUDE_USER_ID = '6c016118-aa19-45dc-9d90-0fb9ee26122e' // claude@orisha.io

// jsonwebtoken n'est pas une dépendance du package e2e (seul le serveur en a
// besoin) — un HS256 minimal en pur Node évite d'ajouter une dépendance juste
// pour signer un token de test, symétrique à jwt.verify() côté serveur.
function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function signHS256(payload, secret) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${header}.${body}.${signature}`
}

const SEED_TEXT = `E2E voir-la-page dérivée du rapport ${Date.now()}`
// Aucun `context` : simule une tâche née hors d'une page (agent autonome / travaux).
const SEED_REPORT = 'Correctif appliqué dans client/src/pages/Paies.jsx pour corriger le calcul.'

function apiFetch(page, method, p, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const opts = { method, headers: { Authorization: `Bearer ${tok}` } }
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
    const r = await fetch('/erp/api' + path, opts)
    return r.json()
  }, { method, path: p, body })
}

describe('Agent — « Voir la page » déduit du rapport (sans contexte)', () => {
  let browser, ctx, page
  let originalEnabled = false
  let backlogId = null
  let taskId = null

  before(async () => {
    const token = signHS256({ id: CLAUDE_USER_ID, role: 'admin', name: 'Claude', exp: Math.floor(Date.now() / 1000) + 7200 }, JWT_SECRET)
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.evaluate(t => localStorage.setItem('erp_token', t), token)

    const s = await apiFetch(page, 'GET', '/agent/settings')
    originalEnabled = !!s.enabled
    await apiFetch(page, 'PUT', '/agent/settings', { enabled: false })

    // Pas de `context` ici : c'est précisément le cas qui manquait de lien avant.
    const item = await apiFetch(page, 'POST', '/agent/backlog', { text: SEED_TEXT })
    backlogId = item.id
    taskId = item.task_id
    assert.ok(taskId, 'la tâche liée doit exister après POST /agent/backlog')
    const now = new Date().toISOString()
    await apiFetch(page, 'PATCH', `/agent/tasks/${taskId}`, {
      status: 'done', started_at: now, completed_at: now,
      agent_result: SEED_REPORT,
      user_summary: 'Seed E2E — implémentation simulée.',
    })
  })

  after(async () => {
    try { if (backlogId && page) await apiFetch(page, 'DELETE', `/agent/backlog/${backlogId}`) } catch {}
    try { if (taskId && page) await apiFetch(page, 'DELETE', `/agent/tasks/${taskId}`) } catch {}
    try { if (page) await apiFetch(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('le lien « Voir la page » pointe vers /paies malgré l\'absence de context', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Agent autonome', { timeout: 10000 })

    const card = page.locator('[data-testid="suggestion-card"]', { hasText: SEED_TEXT })
    await card.waitFor({ timeout: 10000 })
    const link = card.getByTestId('card-page-link')
    await link.waitFor({ timeout: 5000 })

    assert.equal(await link.getAttribute('href'), '/erp/paies', `lien attendu vers /erp/paies, obtenu : ${await link.getAttribute('href')}`)
  })
})
