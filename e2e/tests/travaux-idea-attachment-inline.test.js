// Travaux — carnet d'idées : pièce jointe affichée inline dans la carte.
//
// Demande : ajouter une image à une idée doit l'afficher directement dans la
// carte (pas de clic requis pour la voir) et un clic doit l'agrandir en
// lightbox. Couvre l'upload → affichage inline → agrandissement → suppression.
//
// Aucun record réel n'est touché : le test crée sa propre idée (titre
// horodaté) et la supprime dans after() — la suppression de l'idée entraîne
// celle de la pièce jointe côté serveur (soft delete en cascade non requis
// ici, mais on la supprime explicitement par prudence).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()
const IDEA_TITLE = `E2E idée pièce jointe ${STAMP}`

// 1x1 PNG transparent (valide pour multer + filtre de format)
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

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

async function waitFor(fn, { timeout = 25000, label = 'condition' } = {}) {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error(`timeout: ${label}`)
    await new Promise(r => setTimeout(r, 300))
  }
}

describe('Travaux — pièce jointe inline sur une idée', () => {
  let browser, ctx, page
  let ideaId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    if (page && ideaId) await apiFetch(page, 'DELETE', `/travaux/ideas/${ideaId}`)
    await browser?.close()
  })

  test('ajouter une image à une idée l\'affiche inline, sans clic', async () => {
    const created = await apiFetch(page, 'POST', '/travaux/ideas', { title: IDEA_TITLE })
    ideaId = created.id

    await page.goto(URL + '/travaux?onglet=idees', { waitUntil: 'domcontentloaded' })
    const card = page.locator(`[data-idea-id="${ideaId}"]`)
    await card.waitFor({ timeout: 15000 })

    await card.locator('[data-testid="idea-attachment-input"]')
      .setInputFiles({ name: `e2e-idea-${STAMP}.png`, mimeType: 'image/png', buffer: PNG_1x1 })

    // L'image doit apparaître directement dans la carte, sans qu'on ait à
    // cliquer sur un lien ou un bouton « télécharger ».
    await card.locator('[data-testid="idea-attachment-image"] img').waitFor({ timeout: 20000 })
    assert.equal(await card.locator('[data-testid="idea-attachment-image"] img').count(), 1)

    const attId = await waitFor(async () => {
      const atts = await apiGet(page, `/attachments/work_ideas/${ideaId}`)
      return Array.isArray(atts) && atts[0]?.id
    }, { label: 'pièce jointe enregistrée côté serveur' })
    assert.ok(attId, 'la pièce jointe existe en base')
  })

  test('cliquer sur l\'image l\'agrandit en lightbox', async () => {
    const card = page.locator(`[data-idea-id="${ideaId}"]`)
    await card.locator('[data-testid="idea-attachment-image"]').click()
    await page.locator('[data-testid="idea-attachment-lightbox"]').waitFor({ timeout: 5000 })
    assert.equal(await page.locator('[data-testid="idea-attachment-lightbox-img"]').count(), 1)

    // Cliquer en dehors (sur l'overlay) referme la lightbox.
    await page.locator('[data-testid="idea-attachment-lightbox"]').click({ position: { x: 5, y: 5 } })
    await page.locator('[data-testid="idea-attachment-lightbox"]').waitFor({ state: 'detached', timeout: 5000 })
  })

  test('retirer la pièce jointe la fait disparaître de la carte', async () => {
    const card = page.locator(`[data-idea-id="${ideaId}"]`)
    await card.hover()
    await card.locator('[data-testid="idea-attachment-delete"]').click()
    await card.locator('[data-testid="idea-attachment-image"]').waitFor({ state: 'detached', timeout: 10000 })

    const atts = await apiGet(page, `/attachments/work_ideas/${ideaId}`)
    assert.equal(atts.length, 0, 'supprimée côté serveur aussi')
  })
})
