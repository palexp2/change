// Vérifie le side-peek (RecordPeekDrawer) sur la table Tickets (Billets) :
//  - un clic sur une ligne ouvre le drawer latéral SANS quitter /tickets
//  - le drawer rend la fiche TicketDetail embarquée (labels du formulaire)
//  - le bouton « ouvrir en grand » navigue vers /tickets/:id
//  - Échap ferme le drawer
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

describe('Tickets — side-peek drawer', () => {
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

  async function openFirstRowPeek() {
    await page.goto(`${URL}/tickets`, { waitUntil: 'networkidle' })
    const firstRow = page.locator('[data-row-id]').first()
    await firstRow.waitFor({ timeout: 10000 })
    const rowId = await firstRow.getAttribute('data-row-id')
    // Clic sur le titre (1re colonne, sans lien) pour éviter le lien contact.
    await firstRow.locator('.font-medium').first().click()
    await page.locator('[data-testid="record-peek-drawer"]').waitFor({ timeout: 8000 })
    return rowId
  }

  test('clic sur une ligne ouvre le drawer sans naviguer', async () => {
    const rowId = await openFirstRowPeek()
    // Toujours sur la liste — pas de navigation vers la fiche complète.
    const path = page.url().split('?')[0].split('#')[0]
    assert.ok(path.includes('/tickets'), 'reste sur /tickets')
    assert.ok(!/\/tickets\/[^/]+$/.test(path),
      `ne doit pas avoir navigué vers la fiche (url=${page.url()})`)
    // Le corps rend la fiche embarquée : labels du formulaire billet.
    const body = await page.locator('[data-testid="record-peek-body"]').innerText()
    assert.ok(/Statut/i.test(body), 'le drawer affiche le champ Statut')
    assert.ok(/Question/i.test(body), 'le drawer affiche le champ Question')
    assert.ok(rowId, 'la ligne a un data-row-id')
  })

  test('bouton « ouvrir en grand » navigue vers la fiche complète', async () => {
    const rowId = await openFirstRowPeek()
    await page.click('[data-testid="record-peek-expand"]')
    await page.waitForURL(u => u.toString().includes(`/tickets/${rowId}`), { timeout: 8000 })
    assert.ok(page.url().includes(`/tickets/${rowId}`), 'navigué vers /tickets/:id')
    // Le drawer doit s'être fermé.
    assert.equal(await page.locator('[data-testid="record-peek-drawer"]').count(), 0,
      'le drawer est fermé après navigation')
    // La fiche complète garde son propre chrome (bouton retour, titre).
    await page.locator('h1').first().waitFor({ timeout: 8000 })
  })

  test('Échap ferme le drawer', async () => {
    await openFirstRowPeek()
    await page.keyboard.press('Escape')
    await page.locator('[data-testid="record-peek-drawer"]').waitFor({ state: 'detached', timeout: 5000 })
    assert.equal(await page.locator('[data-testid="record-peek-drawer"]').count(), 0,
      'le drawer est fermé après Échap')
  })
})
