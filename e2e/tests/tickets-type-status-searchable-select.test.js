// Champs Type/Statut des billets → SearchableSelect.
// Avant, Tickets.jsx (formulaire « Nouveau billet ») et TicketDetail.jsx rendaient
// `meta.types` (11 valeurs, pilotées par le backend) et `meta.statuses` dans des
// <select> natifs sans recherche, ce qui violait la règle CLAUDE.md « tout dropdown
// > 10 options doit offrir une recherche ».
//
// Vérifie :
//   1. Formulaire « Nouveau billet » : Type/Statut sont des <button> (SearchableSelect)
//      avec menu en portail filtrable.
//   2. TicketDetail : Type/Statut sont des SearchableSelect ; changer le Type filtre,
//      persiste réellement (autosave PUT /tickets/:id), puis on restaure la valeur.
//
// Le Type du billet est une vraie valeur de record : on lit la valeur d'origine avant
// et on la RESTAURE dans after(), même en cas d'échec (règle CLAUDE.md).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const API = URL.replace(/\/erp$/, '') + '/api'
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

async function api(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

describe('Tickets — Type/Statut = SearchableSelect', () => {
  let browser, ctx, page, token
  let ticketId, originalType, types

  before(async () => {
    const auth = await api(null, 'POST', '/auth/login', { email: EMAIL, password: PASS })
    assert.equal(auth.status, 200, 'login API doit réussir')
    token = auth.body.token

    const meta = await api(token, 'GET', '/tickets/meta')
    types = meta.body.types || []
    assert.ok(types.length > 10, `types doit dépasser 10 options pour la règle (got ${types.length})`)

    const list = await api(token, 'GET', '/tickets?limit=1')
    const rows = Array.isArray(list.body) ? list.body : (list.body.data || [])
    assert.ok(rows.length > 0, 'au moins un billet nécessaire')
    ticketId = rows[0].id
    originalType = rows[0].type ?? ''

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    // Toujours restaurer le type d'origine, même si le test a échoué.
    if (token && ticketId && originalType !== undefined) {
      await api(token, 'PUT', `/tickets/${ticketId}`, { type: originalType })
    }
    await browser?.close()
  })

  test('Formulaire « Nouveau billet » : Type/Statut filtrables', async () => {
    await page.goto(`${URL}/tickets`, { waitUntil: 'networkidle' })
    await page.click('button:has-text("Nouveau billet")')

    const typeTrigger = page.locator('[data-testid="ticket-form-type"]')
    await typeTrigger.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await typeTrigger.evaluate(el => el.tagName.toLowerCase()), 'button', 'Type doit être un bouton (SearchableSelect)')

    const statusTrigger = page.locator('[data-testid="ticket-form-status"]')
    assert.equal(await statusTrigger.evaluate(el => el.tagName.toLowerCase()), 'button', 'Statut doit être un bouton (SearchableSelect)')

    // Ouvrir Type → menu portail filtrable.
    await typeTrigger.click()
    const menu = page.locator('[data-testid="ticket-form-type-menu"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    const optionSelector = '[data-testid="ticket-form-type-menu"] button'
    const total = await page.locator(optionSelector).count()
    assert.ok(total >= types.length, `le menu devrait lister tous les types, got ${total}`)

    // Filtrer sur la première valeur réelle restreint la liste.
    const sample = types[0]
    await menu.locator('input').fill(sample.slice(0, 4))
    await page.waitForTimeout(150)
    const filtered = await page.locator(optionSelector).count()
    assert.ok(filtered >= 1 && filtered <= total, 'le filtre devrait restreindre la liste')

    await menu.locator('input').fill('zzz-aucun-zzz')
    await page.waitForTimeout(150)
    await menu.locator('text=Aucun résultat').waitFor({ state: 'visible', timeout: 3000 })
  })

  test('TicketDetail : Type est un SearchableSelect qui persiste', async () => {
    await page.goto(`${URL}/tickets/${ticketId}`, { waitUntil: 'networkidle' })

    const trigger = page.locator('[data-testid="ticket-field-type"]')
    await trigger.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await trigger.evaluate(el => el.tagName.toLowerCase()), 'button', 'Type doit être un bouton (SearchableSelect)')

    // Statut aussi.
    const statusTrigger = page.locator('[data-testid="ticket-field-status"]')
    assert.equal(await statusTrigger.evaluate(el => el.tagName.toLowerCase()), 'button', 'Statut doit être un bouton (SearchableSelect)')

    // Choisir un type différent de l'actuel.
    const target = types.find(t => t !== originalType) || types[0]
    await trigger.click()
    const menu = page.locator('[data-testid="ticket-field-type-menu"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    await menu.locator('input').fill(target)
    await page.waitForTimeout(150)
    await page.locator('[data-testid="ticket-field-type-menu"] button', { hasText: target }).first().click()
    await menu.waitFor({ state: 'hidden', timeout: 3000 })

    const triggerText = (await trigger.innerText()).trim()
    assert.ok(triggerText.includes(target), `le bouton devrait afficher le type choisi, got "${triggerText}"`)

    // Persistance autosave (PUT).
    await page.waitForTimeout(900)
    const afterSave = await api(token, 'GET', `/tickets/${ticketId}`)
    assert.equal(afterSave.body.type, target, 'le type doit être persisté en DB')
  })
})
