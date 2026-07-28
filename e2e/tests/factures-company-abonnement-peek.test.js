// Vérifie que, depuis la liste /factures, les liens vers les fiches liées
// ouvrent un side-peek (RecordPeekDrawer) au lieu de naviguer :
//  - clic sur le nom d'entreprise → drawer avec la fiche entreprise embarquée,
//    bouton « ouvrir en grand » vers /companies/:id
//  - clic sur l'id d'abonnement (colonne custom « Abonnement ») → drawer avec
//    les détails de l'abonnement (variant peek d'AbonnementDetailModal)
// (Le clic sur la ligne elle-même — peek de la facture — est couvert par
// factures-record-peek-drawer.test.js.)
//
// Lecture seule : aucun record créé ni muté, rien à nettoyer.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Factures — side-peek entreprise & abonnement', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  async function gotoFactures() {
    await page.goto(`${URL}/factures`, { waitUntil: 'networkidle' })
    await page.locator('[data-row-id]').first().waitFor({ timeout: 15000 })
  }

  test("clic sur l'entreprise ouvre son side-peek sans naviguer", async () => {
    await gotoFactures()
    const link = page.locator('[data-testid="facture-company-link"]').first()
    await link.waitFor({ timeout: 10000 })
    const companyName = (await link.innerText()).trim()
    await link.click()

    const drawer = page.locator('[data-testid="record-peek-drawer"]')
    await drawer.waitFor({ timeout: 8000 })
    // Toujours sur la liste — pas de navigation vers /companies/:id.
    const path = page.url().split('?')[0].split('#')[0]
    assert.ok(path.includes('/factures'), 'reste sur /factures')
    assert.ok(!path.includes('/companies/'), `pas de navigation (url=${page.url()})`)
    // Le titre du drawer = nom de l'entreprise cliquée.
    const title = (await page.locator('[data-testid="record-peek-title"]').innerText()).trim()
    assert.equal(title, companyName, 'le drawer porte le nom de l\'entreprise')
    // Le corps rend la fiche entreprise embarquée (onglets de CompanyDetail).
    const body = page.locator('[data-testid="record-peek-body"]')
    await body.locator('button:has-text("Informations")').first().waitFor({ timeout: 10000 })
    const text = await body.innerText()
    assert.ok(/Contacts/i.test(text), 'le drawer affiche l\'onglet Contacts')

    // « Ouvrir en grand » navigue vers la fiche complète /companies/:id.
    await page.click('[data-testid="record-peek-expand"]')
    await page.waitForURL(u => /\/companies\/[^/]+/.test(u.toString()), { timeout: 8000 })
    assert.equal(await drawer.count(), 0, 'le drawer est fermé après navigation')
  })

  test("clic sur l'abonnement ouvre son side-peek", async (t) => {
    await gotoFactures()
    // La colonne « Abonnement » (champ custom subscription_id) n'est pas dans
    // la vue par défaut — sélectionner la vue « Abonnements » qui l'affiche.
    // (Sélection en lecture seule : le write-back re-sauvegarde les mêmes
    // filtres, aucune config n'est modifiée.)
    const pill = page.locator('button:has-text("Abonnements")').first()
    if (await pill.count() > 0) {
      await pill.click()
      await page.waitForTimeout(1000)
    }
    const subLink = page.locator('[data-testid="facture-subscription-link"]').first()
    // Si aucune facture avec abonnement n'est visible, on saute proprement.
    if (await subLink.count() === 0) {
      t.skip('aucun lien abonnement visible dans la vue courante')
      return
    }
    await subLink.click()
    const drawer = page.locator('[data-testid="record-peek-drawer"]')
    await drawer.waitFor({ timeout: 8000 })
    // Toujours sur /factures (pas de navigation).
    assert.ok(page.url().split('?')[0].includes('/factures'), 'reste sur /factures')
    // Contenu abonnement : champ Entreprise + lien/label Stripe.
    const body = page.locator('[data-testid="record-peek-body"]')
    await body.locator('text=Entreprise').first().waitFor({ timeout: 10000 })
    const text = await body.innerText()
    assert.ok(/Stripe/i.test(text), 'le drawer affiche les infos Stripe de l\'abonnement')

    // Échap ferme le drawer et on reste sur la liste.
    await page.keyboard.press('Escape')
    await drawer.waitFor({ state: 'detached', timeout: 5000 })
    assert.ok(page.url().split('?')[0].includes('/factures'), 'toujours sur /factures après fermeture')
  })
})
