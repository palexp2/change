// Vérifie le side-peek contact sur /interactions (remplace l'ancien test
// interactions-contact-link : le nom de contact n'est plus un <Link> qui
// navigue, mais un bouton qui ouvre la fiche contact dans un drawer latéral) :
//  - clic sur un nom de contact dans la table ouvre le RecordPeekDrawer avec la
//    fiche ContactDetail embarquée, SANS quitter /interactions et SANS ouvrir
//    la modale de détail d'interaction
//  - le bouton « ouvrir en grand » navigue vers /contacts/:id
//  - depuis la modale de détail d'une interaction, le nom du contact ouvre
//    aussi le drawer par-dessus la modale (qui reste ouverte)
//
// Lecture seule : aucun record créé ni config modifiée → pas de cleanup.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Interactions — side-peek contact', () => {
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

  // Charge /interactions et retourne le premier bouton « nom de contact » du
  // tableau (rendu .text-brand-600 dans la colonne contact_name).
  async function gotoInteractionsWithContact() {
    await page.goto(`${URL}/interactions`, { waitUntil: 'domcontentloaded' })
    // La vue active par défaut peut porter des filtres masquant les lignes avec
    // contact : on bascule sur la vue sans filtre « Toutes les intéractions »
    // (sélection de pill = état localStorage, non persisté serveur → rien à
    // restaurer). On attend que la pill soit rendue avant de cliquer.
    const allPill = page.locator('button', { hasText: /toutes les int.ractions/i }).first()
    await allPill.waitFor({ timeout: 15000 })
    await allPill.click()
    const btn = page.locator('[data-row-id] button.text-brand-600').first()
    await btn.waitFor({ timeout: 15000 })
    return btn
  }

  test('clic sur un nom de contact ouvre le drawer sans naviguer ni ouvrir la modale', async () => {
    const btn = await gotoInteractionsWithContact()
    const name = (await btn.innerText()).trim()
    await btn.click()

    const drawer = page.locator('[data-testid="record-peek-drawer"]')
    await drawer.waitFor({ timeout: 8000 })

    // Toujours sur /interactions — pas de navigation vers /contacts/:id.
    const path = page.url().split('?')[0].split('#')[0]
    assert.ok(path.endsWith('/interactions'), `reste sur /interactions (url=${page.url()})`)

    // Le titre du drawer est le nom du contact cliqué.
    const title = (await page.locator('[data-testid="record-peek-title"]').innerText()).trim()
    assert.equal(title, name, 'le titre du drawer est le nom du contact')

    // Le corps rend la fiche contact embarquée (labels du formulaire) — la
    // fiche charge en async, on attend l'apparition du label.
    await page.locator('[data-testid="record-peek-body"]').getByText(/courriel/i).first().waitFor({ timeout: 10000 })

    // stopPropagation : la modale de détail d'interaction ne doit PAS s'être
    // ouverte derrière (elle porte un en-tête Appel/Courriel/SMS/Réunion/Note).
    await page.click('[data-testid="record-peek-close"]')
    await drawer.waitFor({ state: 'detached', timeout: 5000 })
    assert.equal(await page.locator('[role="dialog"]').count(), 0,
      'aucune modale ouverte après fermeture du drawer')
  })

  test('bouton « ouvrir en grand » navigue vers la fiche contact complète', async () => {
    const btn = await gotoInteractionsWithContact()
    await btn.click()
    await page.locator('[data-testid="record-peek-drawer"]').waitFor({ timeout: 8000 })
    await page.click('[data-testid="record-peek-expand"]')
    await page.waitForURL(u => /\/contacts\/[^/]+$/.test(u.toString().split('?')[0]), { timeout: 8000 })
    assert.equal(await page.locator('[data-testid="record-peek-drawer"]').count(), 0,
      'le drawer est fermé après navigation')
  })

  test('depuis la modale de détail, le nom du contact ouvre le drawer par-dessus', async () => {
    const btn = await gotoInteractionsWithContact()
    // Ouvre la modale de détail en cliquant la ligne (sur la pastille de type,
    // inerte, pour ne pas toucher le bouton contact).
    const row = page.locator('[data-row-id]').filter({ has: page.locator('button.text-brand-600') }).first()
    await row.locator('div.inline-flex').first().click()
    const contactBtn = page.locator('[role="dialog"] button.text-blue-600').first()
    await contactBtn.waitFor({ timeout: 8000 })
    assert.ok(btn, 'sanity')

    await contactBtn.click()
    const drawer = page.locator('[data-testid="record-peek-drawer"]')
    await drawer.waitFor({ timeout: 8000 })
    await page.locator('[data-testid="record-peek-body"]').getByText(/courriel/i).first().waitFor({ timeout: 10000 })

    // Fermer le drawer via × : la modale d'interaction reste ouverte derrière.
    await page.click('[data-testid="record-peek-close"]')
    await drawer.waitFor({ state: 'detached', timeout: 5000 })
    assert.ok(await page.locator('[role="dialog"] button.text-blue-600').count() > 0,
      'la modale de détail d\'interaction est toujours ouverte')
  })
})
