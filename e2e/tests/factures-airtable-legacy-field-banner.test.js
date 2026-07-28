const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
const TOKEN = process.env.ERP_TOKEN // alternative au login par mot de passe (JWT injecté)
if (!PASS && !TOKEN) throw new Error('ERP_PASS ou ERP_TOKEN env var requis')

// Régression : la colonne « Année de facturation » de /factures est une colonne
// héritée de l'ancien import Airtable (source='airtable'), mais le sync complet
// Airtable→factures est débranché (Stripe = source de vérité). La modale
// « Modifier le champ » affichait « Connecté à Airtable … voir la page de gestion
// des champs Airtable du module » — trompeur : cette colonne n'apparaît pas dans
// la config de sync Airtable et n'existe aucune page de gestion Airtable pour
// factures. Le message doit désormais expliquer l'origine héritée et pointer vers
// « Mapping des champs Stripe ». Le test ouvre la modale en lecture seule (aucune
// édition, aucun autosave) — rien à nettoyer.
describe('Factures — bannière champ Airtable hérité pointe vers Stripe', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    if (TOKEN) {
      // Injecte le JWT dans localStorage avant tout script de page → session
      // authentifiée sans passer par le formulaire de login.
      await ctx.addInitScript(t => { try { localStorage.setItem('erp_token', t) } catch {} }, TOKEN)
      page = await ctx.newPage()
      await page.goto(URL, { waitUntil: 'domcontentloaded' })
    } else {
      page = await ctx.newPage()
      await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
      await page.fill('input[type="email"]', EMAIL)
      await page.fill('input[type="password"]', PASS)
      await page.click('button:has-text("Se connecter")')
      await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    }

    await page.goto(URL + '/factures', { waitUntil: 'domcontentloaded' })
    // Attendre que le tableau (et donc les en-têtes de colonnes) soit monté.
    await page.waitForSelector('div[draggable="true"]', { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('la modale « Modifier le champ » mentionne Stripe, pas la page de gestion Airtable', async () => {
    // En-tête de la colonne custom (les en-têtes DataTable sont draggable).
    const header = page.locator('div[draggable="true"]', { hasText: 'Année de facturation' }).first()
    await header.waitFor({ state: 'visible', timeout: 10000 })

    // Menu contextuel d'en-tête → « Modifier le champ »
    await header.click({ button: 'right' })
    await page.getByRole('button', { name: 'Modifier le champ' }).click()

    // Modale d'édition ouverte
    const dialog = page.getByRole('dialog')
    await dialog.getByText('Modifier le champ').first().waitFor({ state: 'visible', timeout: 5000 })

    const bannerText = await dialog.innerText()

    // Le message corrigé pointe vers le mapping Stripe…
    assert.match(bannerText, /Mapping des champs Stripe/i,
      'la bannière doit orienter vers « Mapping des champs Stripe »')
    // …et explique pourquoi la colonne n'est pas dans la config de sync Airtable.
    assert.match(bannerText, /sync Airtable/i,
      'la bannière doit expliquer l\'absence de la colonne dans la config de sync Airtable')
    // …sans plus renvoyer vers une page de gestion des champs Airtable inexistante.
    assert.doesNotMatch(bannerText, /page de gestion des champs Airtable/i,
      'la bannière ne doit plus renvoyer vers la page de gestion des champs Airtable (inexistante pour factures)')

    // Fermer sans rien modifier — aucune écriture, rien à nettoyer.
    await page.keyboard.press('Escape')
  })
})
