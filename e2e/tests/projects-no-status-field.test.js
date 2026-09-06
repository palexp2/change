// Le champ « Statut » a été retiré de la table Projet (signalement utilisateur
// depuis /champs/projects) : la colonne SQL `projects.status` et les routes qui
// la lisent restent en place côté serveur, mais le champ ne doit plus apparaître
// nulle part dans l'interface — page de configuration des champs, tableau du
// pipeline, fiche projet (badge + bloc « Statut »), modales « Nouveau projet » /
// « Modifier le projet », et fiche entreprise (cartes de projets).
//
// Lecture seule : aucun record créé ni modifié, aucune vue enregistrée (on
// n'ouvre ni le panneau Filtres ni le sélecteur de vues — cf. CLAUDE.md). Les
// modales ne sont qu'ouvertes puis fermées, sans saisie → aucun autosave.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Projets — le champ Statut a été supprimé', () => {
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

  test('/champs/projects : plus de ligne « Statut »', async () => {
    await page.goto(URL + '/champs/projects', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid^="fieldcfg-row-"]', { timeout: 30000 })

    // Les autres champs cœur du projet sont bien là : la page est chargée.
    await page.waitForSelector('[data-testid="fieldcfg-row-type"]', { timeout: 30000 })
    await page.waitForSelector('[data-testid="fieldcfg-row-value_cad"]', { timeout: 30000 })

    assert.equal(
      await page.locator('[data-testid="fieldcfg-row-status"]').count(), 0,
      'la ligne du champ « Statut » ne doit plus exister'
    )
    // Ni sous forme de ligne « colonne ERP non listée » portant le libellé.
    const rows = page.locator('[data-testid^="fieldcfg-row-"]')
    const names = await rows.locator('input').evaluateAll(els => els.map(e => e.value))
    assert.ok(
      !names.includes('Statut'),
      `aucun champ nommé exactement « Statut » (vu : ${names.filter(n => /statut/i.test(n)).join(', ')})`
    )
  })

  test('/pipeline : plus de colonne Statut dans le tableau', async () => {
    await page.goto(URL + '/pipeline', { waitUntil: 'domcontentloaded' })
    await page.locator('[data-testid="col-header-name"]').waitFor({ state: 'visible', timeout: 30000 })
    assert.equal(
      await page.locator('[data-testid="col-header-status"]').count(), 0,
      'aucune colonne « Statut » dans le tableau des projets'
    )
    const labels = (await page.locator('[data-testid^="col-header-"]').allInnerTexts()).map(t => t.trim())
    assert.ok(!labels.some(l => l === 'Statut'), `aucun en-tête « Statut » (vu : ${labels.join(' | ')})`)
  })

  test('modale « Nouveau projet » : aucun sélecteur de statut', async () => {
    await page.goto(URL + '/pipeline', { waitUntil: 'domcontentloaded' })
    await page.locator('button:has-text("Nouveau projet")').first().click()
    const modal = page.locator('.fixed').filter({ hasText: 'Nouveau projet' }).first()
    await modal.locator('text=Nom du projet').first().waitFor({ state: 'visible', timeout: 15000 })
    const modalText = await modal.innerText()
    assert.ok(!/\bStatut\b/.test(modalText), `la modale ne propose plus de statut (vu : ${modalText.slice(0, 400)})`)
    assert.equal(
      await modal.locator('option:text-is("Gagné")').count(), 0,
      'plus d\'options « Ouvert » / « Gagné » / « Perdu »'
    )
    // Fermeture sans rien enregistrer (bouton « Annuler » du mode création).
    await modal.locator('button:has-text("Annuler")').first().click()
  })

  test('fiche projet : ni badge de statut, ni bloc « Statut »', async () => {
    // On récupère un id de projet par l'API (lecture seule) plutôt qu'en
    // cliquant une ligne : le clic sur le tableau peut ouvrir le side-peek.
    const id = await page.evaluate(async () => {
      const t = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projects?limit=1', { headers: { Authorization: `Bearer ${t}` } })
      const d = await r.json()
      return (d.data || d)[0]?.id
    })
    assert.ok(id, 'au moins un projet doit exister pour vérifier la fiche')
    await page.goto(URL + `/projects/${id}`, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-testid="project-company-field"]').waitFor({ state: 'visible', timeout: 30000 })

    const bodyText = await page.locator('main, body').first().innerText()
    assert.ok(!/^Statut$/mi.test(bodyText), 'aucun libellé « Statut » sur la fiche')
    assert.equal(await page.locator('h1 ~ * >> text="Ouvert"').count(), 0, 'plus de badge de statut à côté du titre')
  })
})
