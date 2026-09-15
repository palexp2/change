// Vérifie les panneaux latéraux de /interactions :
//  - clic sur une ligne → la fiche de l'INTERACTION s'ouvre en side-peek
//    (comme les autres enregistrements de l'app), plus de modale
//  - clic sur un nom de contact dans la table → fiche contact en side-peek
//  - depuis le panneau d'une interaction, le nom du contact empile un second
//    panneau ; le fermer laisse celui de l'interaction en place
//
// Lecture seule : aucun record créé ni config modifiée → pas de cleanup.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Interactions — panneaux latéraux', () => {
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

  // Charge /interactions sur la vue sans filtre et retourne le premier lien
  // « nom de contact » du tableau (colonne contact_name).
  async function gotoInteractionsWithContact() {
    await page.goto(`${URL}/interactions`, { waitUntil: 'domcontentloaded' })
    // La vue active par défaut peut porter des filtres masquant les lignes avec
    // contact : on bascule sur la vue sans filtre « Toutes les intéractions »
    // (sélection de pill = état localStorage, non persisté serveur → rien à
    // restaurer). On attend que la pill soit rendue avant de cliquer.
    const allPill = page.locator('button', { hasText: /toutes les int.ractions/i }).first()
    await allPill.waitFor({ timeout: 15000 })
    await allPill.click()
    const link = page.locator('[data-row-id] a.link-record').first()
    await link.waitFor({ timeout: 15000 })
    return link
  }

  test('clic sur une ligne ouvre la fiche interaction en panneau latéral', async () => {
    await gotoInteractionsWithContact()
    // Clic sur la pastille de type (inerte) pour ne pas tomber sur un lien.
    const row = page.locator('[data-row-id]').first()
    await row.locator('span.inline-flex').first().click()

    const drawer = page.locator('[data-testid="record-peek-drawer"]')
    await drawer.waitFor({ timeout: 8000 })

    // URL partageable de la fiche pendant que le panneau est ouvert.
    await page.waitForURL(u => /\/interactions\/[^/]+$/.test(u.toString().split('?')[0]), { timeout: 5000 })

    const title = (await page.locator('[data-testid="record-peek-title"]').innerText()).trim()
    assert.ok(title.length > 0, 'le panneau porte un titre')

    // Plus aucune modale : la fiche vit dans le panneau.
    assert.equal(await page.locator('.fixed.inset-0 [role="dialog"]').count(), 0,
      'aucune modale de détail d\'interaction')

    await page.click('[data-testid="record-peek-close"]')
    await drawer.waitFor({ state: 'detached', timeout: 5000 })
  })

  test('clic sur un nom de contact ouvre la fiche contact en panneau latéral', async () => {
    const link = await gotoInteractionsWithContact()
    const name = (await link.innerText()).trim()
    await link.click()

    const drawer = page.locator('[data-testid="record-peek-drawer"]')
    await drawer.waitFor({ timeout: 8000 })

    const title = (await page.locator('[data-testid="record-peek-title"]').innerText()).trim()
    assert.equal(title, name, 'le titre du panneau est le nom du contact')

    // Le corps rend la fiche contact embarquée (labels du formulaire) — la
    // fiche charge en async, on attend l'apparition du label.
    await page.locator('[data-testid="record-peek-body"]').getByText(/courriel/i).first().waitFor({ timeout: 10000 })
  })

  test('depuis la fiche interaction, le nom du contact empile un second panneau', async () => {
    await gotoInteractionsWithContact()
    const row = page.locator('[data-row-id]').filter({ has: page.locator('a.link-record') }).first()
    await row.locator('span.inline-flex').first().click()

    const drawers = page.locator('[data-testid="record-peek-drawer"]')
    await drawers.first().waitFor({ timeout: 8000 })

    const contactLink = page.locator('[data-testid="record-peek-body"] a[href*="/contacts/"]').first()
    await contactLink.waitFor({ timeout: 10000 })
    await contactLink.click()

    await page.locator('[data-peek-depth="1"]').waitFor({ timeout: 8000 })
    await page.locator('[data-peek-depth="1"] [data-testid="record-peek-body"]').getByText(/courriel/i).first().waitFor({ timeout: 10000 })

    // Fermer le panneau du dessus : celui de l'interaction reste ouvert.
    await page.locator('[data-peek-depth="1"] [data-testid="record-peek-close"]').click()
    await page.locator('[data-peek-depth="1"]').waitFor({ state: 'detached', timeout: 5000 })
    assert.equal(await page.locator('[data-peek-depth="0"]').count(), 1,
      'le panneau de l\'interaction est toujours ouvert')
  })
})
