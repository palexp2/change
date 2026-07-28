// Vérifie le bouton « revenir au panneau latéral » de la fiche entreprise plein
// écran (/companies/:id) :
//  - le bouton est visible dans l'en-tête (mode non embarqué)
//  - le clic ramène sur la liste /companies avec le side-peek (RecordPeekDrawer)
//    ouvert sur la même entreprise
//  - aller-retour complet : peek → « ouvrir en grand » → plein écran →
//    « revenir au panneau » → peek à nouveau
//
// Lecture seule : on n'édite aucun champ, donc aucun record n'est créé ni muté
// (rien à nettoyer/restaurer).
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Fiche entreprise plein écran — bouton retour au panneau latéral', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  // Récupère l'id de la première entreprise de la liste (pour ouvrir sa fiche
  // pleine page directement).
  async function firstCompanyId() {
    await page.goto(`${URL}/companies`, { waitUntil: 'networkidle' })
    const firstRow = page.locator('[data-row-id]').first()
    await firstRow.waitFor({ timeout: 10000 })
    return firstRow.getAttribute('data-row-id')
  }

  test('le clic sur le bouton rouvre le side-peek sur la liste', async () => {
    const id = await firstCompanyId()
    await page.goto(`${URL}/companies/${id}`, { waitUntil: 'networkidle' })
    const btn = page.locator('[data-testid="company-open-as-peek"]')
    await btn.waitFor({ timeout: 10000 })
    await btn.click()
    // De retour sur la liste (pas sur la fiche) avec le drawer ouvert.
    await page.locator('[data-testid="record-peek-drawer"]').waitFor({ timeout: 10000 })
    const path = page.url().split('?')[0].split('#')[0]
    assert.ok(!/\/companies\/[^/]+$/.test(path),
      `doit être revenu sur la liste (url=${page.url()})`)
    // Le drawer rend bien la fiche embarquée de la même entreprise (onglets).
    const body = await page.locator('[data-testid="record-peek-body"]').innerText()
    assert.ok(/Informations/i.test(body), 'le drawer affiche l’onglet Informations')
    assert.ok(/Contacts/i.test(body), 'le drawer affiche l’onglet Contacts')
  })

  test('aller-retour : peek → plein écran → retour au peek', async () => {
    await page.goto(`${URL}/companies`, { waitUntil: 'networkidle' })
    const firstRow = page.locator('[data-row-id]').first()
    await firstRow.waitFor({ timeout: 10000 })
    const rowId = await firstRow.getAttribute('data-row-id')
    // Ouvre le peek (clic sur la cellule Nom, sans lien).
    await firstRow.locator('.font-medium').first().click()
    await page.locator('[data-testid="record-peek-drawer"]').waitFor({ timeout: 8000 })
    const peekTitle = await page.locator('[data-testid="record-peek-title"]').innerText()
    // « Ouvrir en grand » → fiche pleine page.
    await page.click('[data-testid="record-peek-expand"]')
    await page.waitForURL(u => u.toString().includes(`/companies/${rowId}`), { timeout: 8000 })
    // « Revenir au panneau latéral » → drawer rouvert sur la même entreprise.
    await page.click('[data-testid="company-open-as-peek"]')
    await page.locator('[data-testid="record-peek-drawer"]').waitFor({ timeout: 10000 })
    const reTitle = await page.locator('[data-testid="record-peek-title"]').innerText()
    assert.equal(reTitle, peekTitle, 'le drawer rouvert montre la même entreprise')
    // Un refresh de la page ne doit PAS rouvrir le drawer (state d'historique nettoyé).
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    assert.equal(await page.locator('[data-testid="record-peek-drawer"]').count(), 0,
      'le drawer ne se rouvre pas après un refresh')
  })

  test('le bouton est absent du mode embarqué (drawer)', async () => {
    await page.goto(`${URL}/companies`, { waitUntil: 'networkidle' })
    const firstRow = page.locator('[data-row-id]').first()
    await firstRow.waitFor({ timeout: 10000 })
    await firstRow.locator('.font-medium').first().click()
    const drawer = page.locator('[data-testid="record-peek-drawer"]')
    await drawer.waitFor({ timeout: 8000 })
    assert.equal(await drawer.locator('[data-testid="company-open-as-peek"]').count(), 0,
      'pas de bouton « revenir au panneau » dans le drawer lui-même')
  })
})
