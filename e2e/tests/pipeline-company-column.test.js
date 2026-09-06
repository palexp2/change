const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Régression : la colonne « Entreprise » de /pipeline s'était entièrement vidée.
// Cause — le sync dynamique Airtable considérait la def native projects.company_id
// (libellé interne « Entreprise », sans champ Airtable correspondant) comme un
// champ importable et remettait company_id = NULL juste après que le sync
// hardcodé l'ait correctement rempli depuis « Client final » : le garde-fou
// « colonne gérée par la sync hardcodée » comparait les CLÉS du field_map
// (`company`) au nom de colonne (`company_id`) et ne matchait jamais.
//
// Test en LECTURE SEULE : aucun record créé, modifié ni supprimé.
describe('Pipeline — colonne Entreprise', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    await browser?.close()
  })

  test('les projets affichent leur entreprise sous forme de lien cliquable', async () => {
    // L'API doit renvoyer des projets liés à une entreprise.
    const api = await page.evaluate(async (base) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(base.replace(/\/erp$/, '') + '/api/projects?limit=200&page=1&lite=1', {
        headers: { Authorization: 'Bearer ' + token },
      })
      const j = await r.json()
      return {
        total: (j.data || []).length,
        linked: (j.data || []).filter(p => p.company_id && p.company_name).length,
      }
    }, URL)
    assert.ok(api.total > 0, 'aucun projet renvoyé par /api/projects')
    assert.ok(api.linked > 0, `aucun projet lié à une entreprise (0/${api.total})`)

    await page.goto(URL + '/pipeline', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-row-id]', { timeout: 20000 })

    // La colonne « Entreprise » doit être affichée (en-tête de la DataTable).
    const header = page.locator('[data-testid="col-header-company_name"]')
    await header.waitFor({ state: 'visible', timeout: 15000 })
    assert.match(await header.innerText(), /Entreprise/i)

    // Au moins une ligne visible doit porter un lien vers la fiche entreprise
    // (règle de design « champs référence » : lien, pas un simple label).
    const links = page.locator('[data-row-id] a[href*="/companies/"]')
    await links.first().waitFor({ state: 'visible', timeout: 20000 })
    const n = await links.count()
    assert.ok(n > 0, 'aucun lien entreprise dans la colonne Entreprise')
    const label = (await links.first().innerText()).trim()
    assert.ok(label.length > 0 && label !== '—', `nom d'entreprise vide : "${label}"`)
  })
})
