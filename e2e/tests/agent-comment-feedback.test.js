// Agent autonome — feedback visible à la sauvegarde du commentaire d'une suggestion.
//
// Le champ « Commentaire (calibre l'agent en cas de rejet) » s'autosauvegarde au
// blur, mais ne donnait AUCUN retour visuel : l'utilisateur tapait, cliquait
// ailleurs, et rien ne semblait se produire (alors que le PATCH partait bien).
// Ce test vérifie le nouvel indicateur « Enregistré » ET la persistance en DB.
//
// L'agent est forcé OFF pour tout le run (aucun subprocess Claude). Seed/cleanup
// via l'API (writes sérialisés côté serveur). Le toggle est restauré (règle CLAUDE.md).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const SEED_DESC = `E2E commentaire feedback ${Date.now()}`
const COMMENT_TEXT = `ne propose plus de migrations cosmétiques (${Date.now()})`

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

describe('Agent autonome — feedback de sauvegarde du commentaire', () => {
  let browser, ctx, page
  let originalEnabled = false
  let seedId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)

    const s = await apiGet(page, '/agent/settings')
    originalEnabled = !!s.enabled
    await apiFetch(page, 'PUT', '/agent/settings', { enabled: false })

    // POST crée la tâche en « approved » → on la repasse en « pending » pour que
    // canTriage soit vrai et que le champ commentaire s'affiche. L'agent est OFF,
    // donc le bref passage par « approved » ne lance aucune exécution.
    const created = await apiFetch(page, 'POST', '/agent/tasks', { description: SEED_DESC })
    seedId = created.id
    await apiFetch(page, 'PATCH', `/agent/tasks/${seedId}`, { status: 'pending' })
  })

  after(async () => {
    try { if (seedId && page) await apiFetch(page, 'DELETE', `/agent/tasks/${seedId}`) } catch {}
    try { if (page) await apiFetch(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('écrire un commentaire affiche « Enregistré » et persiste user_comment', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Agent autonome', { timeout: 10000 })

    const cardTitle = page.locator(`text=${SEED_DESC}`)
    await cardTitle.waitFor({ timeout: 5000 })
    await cardTitle.click() // déplier la carte

    // Le champ commentaire (placeholder distinct du champ « Discuter… »).
    const commentBox = page.locator('textarea[placeholder^="Ex. ne propose plus"]')
    await commentBox.waitFor({ timeout: 5000 })

    await commentBox.fill(COMMENT_TEXT)
    // Blur le champ → déclenche l'autosave (onBlur).
    await commentBox.evaluate(el => el.blur())

    // L'indicateur « Enregistré » doit apparaître brièvement (feedback visible).
    await page.locator('text=Enregistré').first().waitFor({ timeout: 5000 })

    // Et la valeur doit être persistée côté serveur.
    const after = (await apiGet(page, '/agent/tasks')).find(t => t.id === seedId)
    assert.equal(after.user_comment, COMMENT_TEXT, 'user_comment doit être persisté en DB')
  })
})
