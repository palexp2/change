// OrderDetail (/orders/:id) — la section Notes doit être en lecture seule :
//   - si la commande a des notes, elles s'affichent dans un <p>, pas un
//     <textarea>/<input> ;
//   - aucun champ éditable n'est présent dans la carte « Notes ».
//
// Ne crée aucun record ; sélectionne une commande existante avec des notes
// non vides (sinon la carte « Notes » n'est pas rendue du tout, ce qui valide
// aussi l'absence de zone d'édition — mais on préfère le cas positif quand
// possible). Aucun cleanup nécessaire.

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

async function apiFetch(page, path, init = {}) {
  return await page.evaluate(async ({ path, init }) => {
    const tok = localStorage.getItem('erp_token')
    const headers = Object.assign({}, init.headers || {}, { Authorization: `Bearer ${tok}` })
    if (init.body) headers['Content-Type'] = 'application/json'
    const r = await fetch('/erp' + path, { ...init, headers })
    const text = await r.text()
    try { return { status: r.status, body: JSON.parse(text) } } catch { return { status: r.status, body: text } }
  }, { path, init })
}

describe('OrderDetail — notes en lecture seule', () => {
  let browser, ctx, page
  let orderId = null
  let originalNotes = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    // Trouve la 1re commande disponible et lui pose une note non vide via API
    // (pour garantir l'affichage de la carte « Notes »). On restaure la valeur
    // d'origine en after() — règle « ne pas écraser une configuration ».
    const list = await apiFetch(page, '/api/orders?limit=10')
    assert.equal(list.status, 200)
    assert.ok(list.body.data?.length, 'aucune commande disponible pour le test')
    orderId = list.body.data[0].id

    const orig = await apiFetch(page, `/api/orders/${orderId}`)
    assert.equal(orig.status, 200)
    originalNotes = orig.body.notes ?? null

    if (!originalNotes) {
      const r = await apiFetch(page, `/api/orders/${orderId}`, {
        method: 'PATCH',
        body: JSON.stringify({ notes: `E2E readonly check ${Date.now()}` }),
      })
      assert.ok(r.status === 200 || r.status === 204, `PATCH notes failed: ${r.status}`)
    }
  })

  after(async () => {
    // Restaure la note d'origine (null compris) pour ne rien laisser en DB.
    if (orderId) {
      try {
        await apiFetch(page, `/api/orders/${orderId}`, {
          method: 'PATCH',
          body: JSON.stringify({ notes: originalNotes }),
        })
      } catch {}
    }
    await browser?.close()
  })

  test('la section Notes affiche un <p> et aucun textarea/input éditable', async () => {
    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'networkidle' })

    // Repère la carte Notes par son titre.
    const notesHeader = page.locator('h2', { hasText: /^Notes$/ }).first()
    await notesHeader.waitFor({ state: 'visible', timeout: 5000 })

    // Le card est le parent commun ; on cherche dans ce conteneur.
    const notesCard = notesHeader.locator('xpath=ancestor::div[contains(@class, "card")][1]')

    // Aucun textarea ni input éditable dans la carte.
    const textareas = notesCard.locator('textarea')
    const inputs = notesCard.locator('input:not([type="hidden"])')
    assert.equal(await textareas.count(), 0, 'la carte Notes ne devrait contenir aucun <textarea>')
    assert.equal(await inputs.count(), 0, 'la carte Notes ne devrait contenir aucun <input> éditable')

    // Le contenu de la note est rendu dans un <p>.
    const paragraph = notesCard.locator('p').first()
    await paragraph.waitFor({ state: 'visible', timeout: 5000 })
    const text = (await paragraph.textContent() || '').trim()
    assert.ok(text.length > 0, 'le <p> de la note ne devrait pas être vide')

    // Le label « Enregistrement… » (présent uniquement en mode édition) ne doit pas apparaître.
    const savingHint = notesCard.locator('text=Enregistrement…')
    assert.equal(await savingHint.count(), 0, 'aucun indicateur de sauvegarde ne doit s\'afficher')
  })
})
