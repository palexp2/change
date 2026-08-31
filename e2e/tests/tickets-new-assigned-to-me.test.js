// Formulaire « Nouveau billet » : le champ « Assigné à » est pré-rempli avec
// l'utilisateur connecté (avant, il affichait le bouton vide « Assigner »).
//
// Vérifie :
//   1. À l'ouverture de la modale, le champ est en état "selected" et porte le
//      nom de l'utilisateur connecté.
//   2. Le défaut n'est pas figé : on peut le retirer (bouton Délier) et le champ
//      redevient vide, puis il se ré-applique à la réouverture de la modale.
//
// Aucun record n'est créé (la modale est fermée par « Annuler ») → rien à nettoyer.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const API = URL.replace(/\/erp$/, '') + '/api'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function api(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

describe('Nouveau billet — assigné par défaut à l\'utilisateur connecté', () => {
  let browser, ctx, page, myName

  const FIELD = '[data-testid="linked-record-field-ticket_assigned_to"]'

  before(async () => {
    const auth = await api(null, 'POST', '/auth/login', { email: EMAIL, password: PASS })
    assert.equal(auth.status, 200, 'login API doit réussir')
    const token = auth.body.token
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())

    // Le nom attendu est celui de la ligne `users` (c'est ce que le picker affiche).
    const users = await api(token, 'GET', '/auth/users')
    const rows = Array.isArray(users.body) ? users.body : (users.body?.data || [])
    const me = rows.find(u => String(u.id) === String(payload.id))
    assert.ok(me, 'l\'utilisateur connecté doit exister dans /api/auth/users')
    myName = me.name
    assert.ok(myName, 'l\'utilisateur connecté doit avoir un nom')

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    await browser?.close()
  })

  test('le champ « Assigné à » est pré-rempli à l\'ouverture', async () => {
    await page.goto(`${URL}/tickets`, { waitUntil: 'networkidle' })
    await page.click('button:has-text("Nouveau billet")')

    const field = page.locator(FIELD)
    await field.waitFor({ state: 'visible', timeout: 10000 })
    await page.waitForFunction(
      sel => document.querySelector(sel)?.getAttribute('data-state') === 'selected',
      FIELD,
      { timeout: 10000 },
    )

    const text = (await field.innerText()).trim()
    assert.ok(
      text.includes(myName),
      `le champ devrait afficher « ${myName} », got "${text}"`,
    )
  })

  test('le défaut reste modifiable et se ré-applique à la réouverture', async () => {
    const field = page.locator(FIELD)

    // Retirer l'assignation → le champ redevient vide (bouton « Assigner »).
    await field.locator('[data-testid="linked-record-clear"]').click()
    await page.waitForFunction(
      sel => document.querySelector(sel)?.getAttribute('data-state') === 'empty',
      FIELD,
      { timeout: 5000 },
    )

    // Fermer sans créer de billet, puis rouvrir : le défaut revient.
    await page.click('button:has-text("Annuler")')
    await field.waitFor({ state: 'detached', timeout: 5000 })

    await page.click('button:has-text("Nouveau billet")')
    await page.waitForFunction(
      sel => document.querySelector(sel)?.getAttribute('data-state') === 'selected',
      FIELD,
      { timeout: 10000 },
    )
    const text = (await page.locator(FIELD).innerText()).trim()
    assert.ok(text.includes(myName), `réouverture : attendu « ${myName} », got "${text}"`)

    await page.click('button:has-text("Annuler")')
  })
})
