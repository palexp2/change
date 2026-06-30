// FAB « Signaler un problème / suggérer une amélioration » monté dans Layout.
//
// Vérifie : le bouton flottant est présent sur une page quelconque, son clic
// ouvre la modale, la soumission crée un item dans le backlog de l'agent (POST
// /api/agent/backlog) avec la route courante jointe en contexte, et un toast de
// succès s'affiche.
//
// Cleanup : l'item de backlog créé est supprimé via l'API dans after() (règle
// CLAUDE.md — prod DB = test DB).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const MARKER = `E2E feedback FAB ${Date.now()}`

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

function apiFetch(page, method, p, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const opts = { method, headers: { Authorization: `Bearer ${tok}` } }
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
    const r = await fetch('/erp/api' + path, opts)
    return r.json()
  }, { method, path: p, body })
}
const apiGet = (page, p) => apiFetch(page, 'GET', p)

describe('FAB feedback → backlog agent', () => {
  let browser, ctx, page
  let createdId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    // Supprime l'item de backlog créé par le test, quel que soit le résultat.
    try {
      if (!createdId && page) {
        const list = await apiGet(page, '/agent/backlog')
        const mine = list.find(b => (b.text || '').includes(MARKER))
        if (mine) createdId = mine.id
      }
      if (createdId && page) await apiFetch(page, 'DELETE', `/agent/backlog/${createdId}`)
    } catch {}
    await browser?.close()
  })

  test('le FAB ouvre la modale, envoie au backlog avec la route en contexte', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    // Le FAB est présent sur la page.
    const fab = page.locator('[data-testid="feedback-fab"]')
    await fab.waitFor({ timeout: 10000 })

    await fab.click()

    // La modale s'ouvre avec le textarea.
    const textarea = page.locator('[data-testid="feedback-fab-text"]')
    await textarea.waitFor({ timeout: 5000 })

    await textarea.fill(MARKER)
    await page.locator('[data-testid="feedback-fab-submit"]').click()

    // Toast de succès.
    await page.locator('text=Suggestion transmise').first().waitFor({ timeout: 5000 })

    // L'item existe en backlog avec le texte + la route courante jointe.
    const list = await apiGet(page, '/agent/backlog')
    const mine = list.find(b => (b.text || '').includes(MARKER))
    assert.ok(mine, 'un item de backlog doit avoir été créé')
    createdId = mine.id
    assert.ok(
      mine.text.includes('/dashboard'),
      'la route courante /dashboard doit être jointe en contexte',
    )
    assert.ok(
      mine.text.includes('Signalé depuis'),
      'le marqueur de contexte doit être présent',
    )
  })
})
