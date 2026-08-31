const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

// Régression : la colonne « Créé le » (projects.creation) de /pipeline affichait
// l'horodatage ISO brut « 2025-11-14T00:00:00.000Z » au lieu de la date seule.
// Cause — DataTable.renderCell ne formatait que les colonnes `dynamic` : une
// colonne type:'date' dont la page ne câble pas de render() (« Créé le » et
// « Modifié le » du Pipeline) tombait sur le rendu « valeur brute ».
//
// Test en LECTURE SEULE : aucun record créé, modifié ni supprimé. La vue
// utilisée (« Ouvert ») est seulement sélectionnée, jamais reconfigurée.
describe('Pipeline — colonne « Créé le » formatée', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      timezoneId: 'America/Toronto',
    })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('les dates de création s\'affichent en YYYY-MM-DD, pas en ISO brut', async () => {
    // L'API doit renvoyer des projets dont `creation` est un horodatage ISO
    // complet — c'est bien le formatage d'affichage qui est testé.
    const api = await page.evaluate(async (base) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(base.replace(/\/erp$/, '') + '/api/projects?limit=200&page=1&lite=1', {
        headers: { Authorization: 'Bearer ' + token },
      })
      const j = await r.json()
      const withIso = (j.data || []).filter(p => /^\d{4}-\d{2}-\d{2}T/.test(p.creation || ''))
      return { total: (j.data || []).length, iso: withIso.length, sample: withIso[0]?.creation }
    }, URL)
    assert.ok(api.total > 0, 'aucun projet renvoyé par /api/projects')
    assert.ok(api.iso > 0, `aucun projet avec un \`creation\` ISO (0/${api.total})`)

    await page.goto(URL + '/pipeline', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-row-id]', { timeout: 20000 })

    // La vue « Ouvert » affiche la colonne « Créé le ».
    const header = page.locator('[data-testid="col-header-creation"]')
    if (!(await header.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: 'Ouvert', exact: true }).first().click()
    }
    await header.waitFor({ state: 'visible', timeout: 15000 })
    assert.match(await header.innerText(), /Créé le/i)

    const cells = page.locator('[data-grid-cell$="|creation"]')
    await cells.first().waitFor({ state: 'visible', timeout: 20000 })
    const texts = (await cells.allInnerTexts()).map(t => t.trim()).filter(t => t && t !== '—')
    assert.ok(texts.length > 0, 'aucune valeur dans la colonne « Créé le »')
    for (const t of texts) {
      assert.ok(
        /^\d{4}-\d{2}-\d{2}$/.test(t),
        `« Créé le » doit afficher une date seule (YYYY-MM-DD), reçu : "${t}" (ex. DB : ${api.sample})`
      )
    }
  })
})
