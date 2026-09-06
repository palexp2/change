// Le champ « Statut » a été retiré de la table Envois (signalement utilisateur
// depuis /champs/shipments) : la colonne SQL et les automatisations qui la
// lisent restent en place côté serveur, mais le champ ne doit plus apparaître
// nulle part dans l'interface — page de configuration des champs, tableau des
// envois, fiche envoi (badge + modale « Modifier »).
//
// Lecture seule : aucun record créé ni modifié, aucune vue enregistrée (on
// n'ouvre ni le panneau Filtres ni le sélecteur de vues — cf. CLAUDE.md).
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Envois — le champ Statut a été supprimé', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('/champs/shipments : plus de ligne « Statut »', async () => {
    await page.goto(URL + '/champs/shipments', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid^="fieldcfg-row-"]', { timeout: 20000 })

    // Les autres champs cœur de l'envoi sont bien là : la page est chargée.
    await page.waitForSelector('[data-testid="fieldcfg-row-carrier"]', { timeout: 20000 })
    await page.waitForSelector('[data-testid="fieldcfg-row-tracking_number"]', { timeout: 20000 })

    assert.equal(
      await page.locator('[data-testid="fieldcfg-row-status"]').count(), 0,
      'la ligne du champ « Statut » ne doit plus exister'
    )
    // Ni sous forme de ligne « colonne ERP non listée » portant le libellé.
    const rows = page.locator('[data-testid^="fieldcfg-row-"]')
    const names = await rows.locator('input').evaluateAll(els => els.map(e => e.value))
    assert.ok(!names.includes('Statut'), `aucun champ nommé « Statut » (vu : ${names.join(', ')})`)
  })

  test('/envois : plus de colonne Statut dans le tableau', async () => {
    await page.goto(URL + '/envois', { waitUntil: 'domcontentloaded' })
    await page.locator('button:has-text("Configurer les champs")').first()
      .waitFor({ state: 'visible', timeout: 20000 })
    // En-têtes du tableau : au moins « Transporteur », jamais « Statut ».
    await page.locator('[data-testid="col-header-carrier"]').waitFor({ state: 'visible', timeout: 20000 })
    assert.equal(
      await page.locator('[data-testid="col-header-status"]').count(), 0,
      'aucune colonne « Statut » dans le tableau des envois'
    )
    const labels = (await page.locator('[data-testid^="col-header-"]').allInnerTexts()).map(t => t.trim())
    assert.ok(!labels.some(l => l === 'Statut'), `aucun en-tête « Statut » (vu : ${labels.join(' | ')})`)
  })

  test("fiche envoi : ni badge de statut, ni champ Statut dans « Modifier »", async () => {
    await page.goto(URL + '/envois', { waitUntil: 'domcontentloaded' })
    const firstRow = page.locator('[data-row-id]').first()
    await firstRow.waitFor({ state: 'visible', timeout: 20000 })
    await firstRow.click()
    await page.waitForURL(u => /\/envois\/[0-9a-f-]{8,}/.test(u.toString()), { timeout: 15000 })
    await page.locator('button:has-text("Modifier")').first().waitFor({ state: 'visible', timeout: 20000 })

    // Plus de badge « À envoyer » / « Envoyé » à côté du titre.
    assert.equal(await page.locator('h1 ~ * >> text="À envoyer"').count(), 0)
    const bodyText = await page.locator('main, body').first().innerText()
    assert.ok(!/^Statut$/m.test(bodyText), 'aucun libellé « Statut » sur la fiche')

    // Modale « Modifier » : aucun sélecteur de statut (ouverture seule, rien
    // n'est saisi → aucun autosave déclenché).
    await page.locator('button:has-text("Modifier")').first().click()
    await page.locator('text=Transporteur').first().waitFor({ state: 'visible', timeout: 10000 })
    const modal = page.locator('[role="dialog"], .fixed').filter({ hasText: 'Modifier l\'envoi' }).first()
    const modalText = await modal.innerText()
    assert.ok(!/Statut/.test(modalText), `la modale ne propose plus de statut (vu : ${modalText.slice(0, 300)})`)
    assert.equal(
      await modal.locator('option:text-is("À envoyer")').count(), 0,
      'plus d\'options « À envoyer » / « Envoyé »'
    )
    await modal.locator('button:has-text("Fermer")').click()
  })
})
